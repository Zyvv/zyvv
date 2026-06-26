// ============================================================
// ZYVV TORAH -- Sefaria Source Engine
// File: lib/sefaria.ts
// Purpose: Four-pass pre-processing before generateDoors()
//   Pass 1: Extract a search query from the situation (Groq fast)
//   Pass 2: Find the most relevant base text (Sefaria Search API)
//   Pass 3: Fetch commentary chain + base text in parallel (Sefaria Related + v3/texts)
//   Pass 4: Fetch each commentary text in parallel (Sefaria v3/texts)
// Returns: SefariaSource | null -- null always logged with reason
// No API key required -- Sefaria's API is open, no auth.
// ============================================================

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'
const SEFARIA_BASE = 'https://www.sefaria.org'

// How many distinct commentators to carry through the chain.
const MAX_COMMENTATORS = 3

// Fetch timeout per call in ms. Sefaria can be slow -- 7s is safe.
const FETCH_TIMEOUT_MS = 7000

export interface SefariaCommentaryEntry {
  commentator: string
  ref: string
  era: string
  excerpt: string
}

export interface SefariaSource {
  baseRef: string
  baseSignal: string
  commentaryChain: SefariaCommentaryEntry[]
  chainSummary: string
  query: string
  raw: string
}

// ── Fetch with timeout ─────────────────────────────────────────

async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController()
  const id = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...options, signal: controller.signal })
    clearTimeout(id)
    return res
  } catch (err: unknown) {
    clearTimeout(id)
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('abort') || msg.includes('AbortError')) {
      throw new Error(`fetch timeout after ${timeoutMs}ms: ${url}`)
    }
    throw err
  }
}

// ── Era labeling from Sefaria compDate range ──────────────────

function eraFromCompDate(compDate?: number[]): string {
  if (!compDate || !compDate.length) return 'undated'
  const year = compDate[0]
  if (year < 0) return `${Math.abs(year)} BCE`
  if (year < 500) return 'Talmudic era'
  if (year < 1000) return 'Geonic era'
  if (year < 1300) return 'Rishonim'
  if (year < 1700) return 'early Acharonim'
  return 'later Acharonim'
}

// ── PASS 1: Extract search query (Groq fast) ──────────────────

async function groqFast(
  systemPrompt: string,
  userContent: string,
  maxTokens = 80
): Promise<string | null> {
  try {
    const res = await fetchWithTimeout(GROQ_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        max_tokens: maxTokens,
        temperature: 0.1,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
      }),
    })
    const data = await res.json()
    if (!res.ok) {
      console.error('[sefaria] Pass 1 Groq HTTP error:', res.status, JSON.stringify(data).slice(0, 200))
      return null
    }
    return data.choices?.[0]?.message?.content?.trim() ?? null
  } catch (err: unknown) {
    console.error('[sefaria] Pass 1 Groq fetch failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ── PASS 2: Search Sefaria for base text ref ──────────────────

interface SefariaSearchHit {
  ref: string
  categories: string[]
}

const LOW_VALUE_CATEGORIES = ['Reference', 'Dictionary', 'Sheets']

// Only accept refs from canonical Jewish text categories.
const CANONICAL_CATEGORIES = [
  'Tanakh', 'Talmud', 'Midrash', 'Halakhah', 'Responsa',
  'Kabbalah', 'Jewish Thought', 'Chasidut', 'Mussar', 'Liturgy',
]

async function sefariaSearch(query: string): Promise<SefariaSearchHit | null> {
  try {
    const res = await fetchWithTimeout(
      `${SEFARIA_BASE}/api/search-wrapper`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query,
          type: 'text',
          field: 'naive_lemmatizer',
          size: 15,
          slop: 10,
          sort_method: 'score',
          sort_fields: ['pagesheetrank'],
        }),
      }
    )

    if (!res.ok) {
      console.error('[sefaria] Pass 2 search-wrapper HTTP error:', res.status)
      return null
    }

    const data = await res.json()
    const hits = data?.hits?.hits ?? []
    console.log('[sefaria] Pass 2 raw hits count:', hits.length)

    if (!hits.length) {
      console.error('[sefaria] Pass 2 FAIL: search returned 0 hits for query=', query)
      return null
    }

    // Filter: no low-value categories, must have a canonical category
    const usable = hits.find((h: { _source?: { ref?: string; categories?: string[] } }) => {
      const cats: string[] = h._source?.categories ?? []
      const isLowValue = cats.some((c) => LOW_VALUE_CATEGORIES.includes(c))
      const isCanonical = cats.some((c) => CANONICAL_CATEGORIES.includes(c))
      return !isLowValue && isCanonical
    })

    if (!usable) {
      // Log what we got so we can tune the filters
      const allCategories = hits.slice(0, 5).map((h: { _source?: { ref?: string; categories?: string[] } }) => ({
        ref: h._source?.ref,
        cats: h._source?.categories,
      }))
      console.error('[sefaria] Pass 2 FAIL: no canonical hit. Top 5:', JSON.stringify(allCategories))
      return null
    }

    const ref = usable._source?.ref
    const categories: string[] = usable._source?.categories ?? []

    if (!ref) {
      console.error('[sefaria] Pass 2 FAIL: selected hit has no ref')
      return null
    }

    console.log('[sefaria] Pass 2 selected ref=', ref, 'categories=', categories)
    return { ref, categories }
  } catch (err: unknown) {
    console.error('[sefaria] Pass 2 fetch failed:', err instanceof Error ? err.message : String(err))
    return null
  }
}

// ── PASS 3: Fetch commentary chain ────────────────────────────

interface RelatedLink {
  ref: string
  category: string
  collectiveTitle?: { en?: string }
  compDate?: number[]
}

async function sefariaRelated(ref: string): Promise<RelatedLink[]> {
  try {
    const res = await fetchWithTimeout(
      `${SEFARIA_BASE}/api/related/${encodeURIComponent(ref)}`
    )

    if (!res.ok) {
      console.error('[sefaria] Pass 3 related HTTP error:', res.status, 'ref=', ref)
      return []
    }

    const data = await res.json()
    const links: RelatedLink[] = data?.links ?? []
    const commentaries = links.filter((l) => l.category === 'Commentary')
    console.log('[sefaria] Pass 3 total links:', links.length, 'commentaries:', commentaries.length)

    const seen = new Set<string>()
    const deduped: RelatedLink[] = []
    for (const link of commentaries) {
      const name = link.collectiveTitle?.en
      if (!name || seen.has(name)) continue
      seen.add(name)
      deduped.push(link)
    }

    deduped.sort((a, b) => (a.compDate?.[0] ?? 9999) - (b.compDate?.[0] ?? 9999))
    const capped = deduped.slice(0, MAX_COMMENTATORS)
    console.log('[sefaria] Pass 3 commentators selected:', capped.map((c) => c.collectiveTitle?.en))
    return capped
  } catch (err: unknown) {
    console.error('[sefaria] Pass 3 fetch failed:', err instanceof Error ? err.message : String(err))
    return []
  }
}

// ── PASS 4: Fetch actual text for a ref ───────────────────────

function flattenSefariaText(text: unknown): string {
  if (!text) return ''
  if (typeof text === 'string') return text.replace(/<[^>]+>/g, '').trim()
  if (Array.isArray(text)) return text.map(flattenSefariaText).filter(Boolean).join(' ').trim()
  return ''
}

async function sefariaText(ref: string): Promise<string> {
  try {
    const tryVersion = async (version: string): Promise<string> => {
      const res = await fetchWithTimeout(
        `${SEFARIA_BASE}/api/v3/texts/${encodeURIComponent(ref)}?version=${version}&return_format=text_only`
      )

      if (!res.ok) {
        console.error('[sefaria] v3/texts HTTP error:', res.status, 'ref=', ref, 'version=', version)
        return ''
      }

      const data = await res.json()

      // Log shape so we catch API drift immediately
      const versionsLen = data?.versions?.length ?? 0
      const firstTextType = typeof data?.versions?.[0]?.text
      const firstTextIsArray = Array.isArray(data?.versions?.[0]?.text)
      console.log(
        `[sefaria] v3/texts ref=${ref} version=${version} versionsLen=${versionsLen} textType=${firstTextType} isArray=${firstTextIsArray}`
      )

      const flat = flattenSefariaText(data?.versions?.[0]?.text)
      return flat
    }

    const english = await tryVersion('english')
    if (english.length > 10) {
      return english.slice(0, 600)
    }

    console.log('[sefaria] English text too short (', english.length, ') for ref=', ref, '-- trying source')
    const source = await tryVersion('source')
    return source.slice(0, 600)
  } catch (err: unknown) {
    console.error('[sefaria] sefariaText failed ref=', ref, err instanceof Error ? err.message : String(err))
    return ''
  }
}

// ── MAIN EXPORT ────────────────────────────────────────────────

export async function extractSefariaSource(
  situation: string
): Promise<SefariaSource | null> {
  console.log('[sefaria] START situation.length=', situation.length)

  try {
    // ── PASS 1: Extract Sefaria-relevant search query ─────────
    const query = await groqFast(
      `You extract a search query for the Sefaria Jewish text library from a user situation.
Output ONLY the query. No quotes. No explanation. No punctuation at end.
Target the underlying human dilemma, virtue, or principle at stake, not the surface
details. Use plain English words that classical Jewish texts discuss (patience,
judgment, partnership, deception, risk, leadership, boundaries, speech, etc).

Examples:
Situation: "I want to quit my stable job to start a company" -> risk and security
Situation: "My business partner and I disagree on direction" -> partnership and disagreement
Situation: "I keep delaying a hard conversation" -> truth and avoidance
Situation: "Should I move to another country for work" -> exile and uprooting`,
      situation,
      30
    )

    if (!query || query.trim().length < 3) {
      console.error('[sefaria] Pass 1 FAIL: no usable query extracted. raw=', query)
      return null
    }
    console.log('[sefaria] Pass 1 OK query=', query.trim())

    // ── PASS 2: Find the base text ────────────────────────────
    const hit = await sefariaSearch(query.trim())
    if (!hit) {
      // sefariaSearch already logged the reason
      return null
    }
    console.log('[sefaria] Pass 2 OK ref=', hit.ref)

    // ── PASS 3 + base text fetch in parallel ──────────────────
    const [commentaryLinks, baseText] = await Promise.all([
      sefariaRelated(hit.ref),
      sefariaText(hit.ref),
    ])

    if (!baseText || baseText.trim().length < 10) {
      console.error('[sefaria] Pass 3/4 FAIL: base text empty or too short for ref=', hit.ref, 'length=', baseText?.length)
      return null
    }
    console.log('[sefaria] Pass 3/4 OK baseText.length=', baseText.length, 'commentaryLinks=', commentaryLinks.length)

    // ── PASS 4: Fetch each commentary text in parallel ────────
    const commentaryResults = await Promise.all(
      commentaryLinks.map(async (link) => {
        const text = await sefariaText(link.ref)
        if (!text || text.trim().length < 5) {
          console.log('[sefaria] commentary text empty for', link.collectiveTitle?.en, 'ref=', link.ref)
          return null
        }
        return {
          commentator: link.collectiveTitle?.en ?? 'Commentary',
          ref: link.ref,
          era: eraFromCompDate(link.compDate),
          excerpt: text,
        } as SefariaCommentaryEntry
      })
    )

    const commentaryChain = commentaryResults.filter(
      (c): c is SefariaCommentaryEntry => c !== null
    )
    console.log('[sefaria] Pass 4 OK commentaryChain.length=', commentaryChain.length)

    const chainInput = [
      `BASE TEXT (${hit.ref}): ${baseText}`,
      ...commentaryChain.map(
        (c) => `${c.commentator.toUpperCase()} (${c.era}, on ${c.ref}): ${c.excerpt}`
      ),
    ].join('\n\n')

    console.log('[sefaria] SUCCESS query=', query.trim(), 'ref=', hit.ref, 'chain entries=', commentaryChain.length + 1, 'chainInput.length=', chainInput.length)

    return {
      baseRef: hit.ref,
      baseSignal: baseText.slice(0, 120).trim(),
      commentaryChain,
      chainSummary: '',
      query: query.trim(),
      raw: chainInput,
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[sefaria] Silent failure:', msg)
    return null
  }
}
