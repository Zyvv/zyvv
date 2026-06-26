// ============================================================
// ZYVV API v1 -- Generate Doors
// File: app/api/v1/doors/route.ts
// ============================================================
import { NextRequest, NextResponse } from 'next/server'
import { generateDoors } from '@/lib/groq'
import { saveSituation, saveDoors } from '@/lib/supabase'
import { authenticateRequest, logRequest } from '@/lib/apiAuth'
import { extractSefariaSource } from '@/lib/sefaria'



export async function POST(req: NextRequest) {
  const auth = await authenticateRequest(req)
  if (!auth.ok) {
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  try {
    const body = await req.json()
    const trimmed = body.situation?.trim()
    if (!trimmed) {
      await logRequest(auth.apiKeyId!, '/api/v1/doors', 400)
      return NextResponse.json({ error: 'situation is required' }, { status: 400 })
    }
    if (trimmed.length < 10) {
      await logRequest(auth.apiKeyId!, '/api/v1/doors', 400)
      return NextResponse.json({ error: 'situation too short -- minimum 10 characters' }, { status: 400 })
    }
    if (trimmed.length > 2000) {
      await logRequest(auth.apiKeyId!, '/api/v1/doors', 400)
      return NextResponse.json({ error: 'situation too long -- maximum 2000 characters' }, { status: 400 })
    }

    const torahSource = body.version === 'torah'
      ? await extractSefariaSource(trimmed)
      : null

    const groqResult = await generateDoors(trimmed, undefined, undefined, torahSource?.raw ?? null)
    const { roast, doors, structuredData } = groqResult
    const situation_id = await saveSituation({
      content: trimmed,
      session_id: body.session_id ?? `api_${auth.apiKeyId}`,
      email: undefined,
    })
    const doorsWithMoat = doors.map((door, index) => ({
      ...door,
      situation_id,
      potential_objections: structuredData?.doors?.[index]?.potential_objections || [],
    }))
    const savedDoors = await saveDoors(doorsWithMoat)
    await logRequest(auth.apiKeyId!, '/api/v1/doors', 200)
    return NextResponse.json({
      roast,
      doors: savedDoors,
      situation_id,
      structuredData,
      torahSource: torahSource
        ? {
            baseRef: torahSource.baseRef,
            baseSignal: torahSource.baseSignal,
            chainSummary: torahSource.chainSummary,
            commentaryChain: torahSource.commentaryChain.map((c) => ({
              commentator: c.commentator,
              era: c.era,
              ref: c.ref,
            })),
            query: torahSource.query,
          }
        : null,
    }, { status: 200 })
  } catch (err: any) {
    console.error('[/api/v1/doors] Error:', err)
    await logRequest(auth.apiKeyId!, '/api/v1/doors', 500)
    return NextResponse.json({ error: err?.message || 'Unknown error' }, { status: 500 })
  }
}
