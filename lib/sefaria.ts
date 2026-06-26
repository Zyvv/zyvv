// ============================================================
// ZYVV TORAH — Sefaria Source Engine
// File: lib/sefaria.ts
// Purpose: Five-pass pre-processing before generateDoors()
//   Pass 1: Extract a search query from the situation (Groq fast)
//   Pass 2: Find the most relevant base text (Sefaria Search API)
//   Pass 3: Fetch the classical commentary chain on that text (Sefaria Related API)
//   Pass 4: Fetch the actual text of the base ref + each commentary (Sefaria Texts v3)
//   Pass 5: Compress everything into one clean chain block (Groq fast)
// Returns: SefariaSource | null — null always fails silently
// No API key required — Sefaria's API is open, no auth.
// ============================================================

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions'
const GROQ_MODEL = 'llama-3.3-70b-versatile'
const SEFARIA_BASE = 'https://www.sefaria.org'

// How many distinct commentators to carry through the chain.
// Raise for more depth, lower for latency.
const MAX_COMMENTATORS = 3

export interface SefariaCommentaryEntry {
  commentator: string   // "Rashi", "Ramban", "Ibn Ezra", "Tosafot"...
  ref: string            // "Rashi on Genesis 1:1:1"
  era: string             // approximate period, derived from compDate
  excerpt: string         // distilled point, not the full text
}

export interface SefariaSource {
  baseRef: string                              // "Genesis 1:1"
  baseSignal: string                           // one-line summary of the base text
  commentaryChain: SefariaCommentaryEntry[]     // chronologically ordered
  chainSummary: string                          // "Base -> Rashi -> Tosafot -> Ramban" narrative
  query: string                                  // stored for data moat
  raw: string                                     // full block, injected into Groq door prompt
}

async function groqFast(
  systemPrompt: string,
  userContent: string,
  maxTokens = 80
): Promise<string | null> {
  try {
    const res = await fetch(GROQ_URL, {
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
    return data.choices?.[0]?.message?.content?.trim() ?? null
  } catch {
    return null
  }
}

// ── Era labeling from Sefaria's compDate range ────────────────

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

// ── PASS 2: Search Sefaria for the most relevant base text ───

interface SefariaSearchHit {
  ref: string
  categories: string[]
}

const LOW_VALUE_CATEGORIES = ['Reference', 'Dictionary', 'Sheets']

async function sefariaSearch(query: string): Promise<SefariaSearchHit | null> {
  try {
    const res = await fetch(`${SEFARIA_BASE}/api/search-wrapper`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        type: 'text',
        field: 'naive_lemmatizer',
        size: 10,
        slop: 10,
        sort_method: 'score',
        sort_fields: ['pagesheetrank'],
      }),
    })
    const data = await res.json()
    const hits = data?.hits?.hits ?? []
    if (!hits.length) return null

    const usable = hits.find((h: any) => {
      const cats: string[] = h._source?.categories ?? []
      return !cats.some((c) => LOW_VALUE_CATEGORIES.includes(c))
    }) ?? hits[0]

    const ref = usable?._source?.ref
    const categories = usable?._source?.categories ?? []
    if (!ref) return null

    return { ref, categories }
  } catch {
    return null
  }
}

// ── PASS 3: Fetch the classical commentary chain on that ref ─

interface RelatedLink {
  ref: string
  category: string
  collectiveTitle?: { en?: string }
  compDate?: number[]
}

async function sefariaRelated(ref: string): Promise<RelatedLink[]> {
  try {
    const res = await fetch(`${SEFARIA_BASE}/api/related/${encodeURIComponent(ref)}`)
    const data = await res.json()
    const links: RelatedLink[] = data?.links ?? []

    const commentaries = links.filter((l) => l.category === 'Commentary')

    // Dedupe by commentator, keep earliest occurrence per commentator
    const seen = new Set<string>()
    const deduped: RelatedLink[] = []
    for (const link of commentaries) {
      const name = link.collectiveTitle?.en
      if (!name || seen.has(name)) continue
      seen.add(name)
      deduped.push(link)
    }

    // Chronological order — Rashi before Ramban before later Acharonim
    deduped.sort((a, b) => (a.compDate?.[0] ?? 9999) - (b.compDate?.[0] ?? 9999))

    return deduped.slice(0, MAX_COMMENTATORS)
  } catch {
    return []
  }
}

// ── PASS 4: Fetch actual text for a ref (English, fallback source) ─

function flattenSefariaText(text: unknown): string {
  if (!text) return ''
  if (typeof text === 'string') return text.replace(/<[^>]+>/g, '').trim()
  if (Array.isArray(text)) return text.map(flattenSefariaText).join(' ').trim()
  return ''
}

async function sefariaText(ref: string): Promise<string> {
  try {
    const tryVersion = async (version: string) => {
      const res = await fetch(
        `${SEFARIA_BASE}/api/v3/texts/${encodeURIComponent(ref)}?version=${version}&return_format=text_only`
      )
      const data = await res.json()
      return flattenSefariaText(data?.versions?.[0]?.text)
    }

    const english = await tryVersion('english')
    if (english.length > 10) return english.slice(0, 600)

    const source = await tryVersion('source')
    return source.slice(0, 600)
  } catch {
    return ''
  }
}

// ── MAIN EXPORT ────────────────────────────────────────────────

export async function extractSefariaSource(
  situation: string
): Promise<SefariaSource | null> {
  try {
    // ── PASS 1: Extract a Sefaria-relevant search query ───────
    const query = await groqFast(
      `You extract a search query for the Sefaria Jewish text library from a user situation.
Output ONLY the query. No quotes. No explanation. No punctuation at end.
Target the underlying human dilemma, virtue, or principle at stake, not the surface
details. Use plain English words that classical Jewish texts discuss (patience,
judgment, partnership, deception, risk, leadership, boundaries, speech, etc).

Examples:
Situation: "I want to quit my stable job to start a company" → risk and security
Situation: "My business partner and I disagree on direction" → partnership and disagreement
Situation: "I keep delaying a hard conversation" → truth and avoidance
Situation: "Should I move to another country for work" → exile and uprooting`,
      situation,
      30
    )

    if (!query || query.trim().length < 3) return null

    // ── PASS 2: Find the base text ────────────────────────────
    const hit = await sefariaSearch(query)
    if (!hit) return null

    // ── PASS 3 + base text fetch, run in parallel ─────────────
    const [commentaryLinks, baseText] = await Promise.all([
      sefariaRelated(hit.ref),
      sefariaText(hit.ref),
    ])
    if (!baseText) return null

    // ── PASS 4: Fetch each commentary's text in parallel ──────
    const commentaryResults = await Promise.all(
      commentaryLinks.map(async (link) => {
        const text = await sefariaText(link.ref)
        if (!text) return null
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

    // ── PASS 5: Compress into chain + one-line signal, parallel ─
    const chainInput = [
      `BASE TEXT (${hit.ref}): ${baseText}`,
      ...commentaryChain.map(
        (c) => `${c.commentator.toUpperCase()} (${c.era}, on ${c.ref}): ${c.excerpt}`
      ),
    ].join('\n\n')

    return {
  baseRef: hit.ref,
  baseSignal: baseText.slice(0, 120).trim(),
  commentaryChain,
  chainSummary: '',
  query: query.trim(),
  raw: chainInput,
}

  } catch (err) {
    // Always fail silently — never block door generation
    console.error('[sefaria] Silent failure:', err)
    return null
  }
}