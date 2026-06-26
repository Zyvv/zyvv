// ============================================================
// ZYVV — Shared TypeScript Types
// File: lib/types.ts
// Enhanced with Data Moat structures
// ============================================================



// ── Door Types ───────────────────────────────────────────────

export type DoorType = 'conventional' | 'contrarian' | 'alien'

export interface Door {
  id?: number
  situation_id?: number
  door_type: DoorType
  title: string
  description: string
  why_it_works: string
  // Moat enhancement
  potential_objections?: string[]
}

// ── Structured Data for Moat (from Groq JSON) ────────────────

export interface StructuredDoorData {
  type: string
  title: string
  description: string
  why_it_works: string
  potential_objections: string[]
}

export interface StructuredData {
  situation_summary: string
  roast_key_insights: string[]
  doors: StructuredDoorData[]
  suggested_tracking_questions: string
}

// ── Situation ────────────────────────────────────────────────

export interface Situation {
  id?: number
  content: string
  session_id?: string
  email?: string
  // Future: embedding vector for similarity search
  embedding?: any
}

// ── Choice ───────────────────────────────────────────────────

export interface Choice {
  id?: number
  situation_id: number
  door_id: number
  objection?: string // Store user objection when they pick a door
}

// ── Outcome (Phase 2+) ───────────────────────────────────────

export interface Outcome {
  id?: number
  choice_id: number
  outcome_text?: string
  outcome_score?: number // 1–5
}

// ── API Payloads — MODE A ────────────────────────────────────

export interface GenerateRequest {
  mode?: 'INITIALIZATION'
  situation: string
  session_id?: string
  version?: ZyvvVersion
}



// ── API Payloads — MODE B ────────────────────────────────────

export interface InterrogateRequest {
  mode: 'INTERROGATION'
  previous_situation: string
  selected_door: DoorType
  user_objection: string
  session_id?: string
}

export interface RefinementBlock {
  critique: string
  refined_path: string
  next_interrogation_vector: string
  outcome_tracking_hint: string
}

export interface InterrogateResponse {
  refinement_block: RefinementBlock
}

// ── Save ─────────────────────────────────────────────────────

export interface SaveChoiceRequest {
  situation_id: number
  door_id: number
  objection?: string
}

export interface SaveChoiceResponse {
  choice_id: number
}

// ── Email ────────────────────────────────────────────────────

export interface EmailRequest {
  email: string
  situation: string
  roast: string
  doors: Door[]
  chosen_door: Door
}

// ── UI State ─────────────────────────────────────────────────

export type AppPhase =
  | 'input'
  | 'loading'
  | 'roast'
  | 'doors'
  | 'chosen'
  | 'interrogation'
  | 'refining'
  | 'refined'
  | 'share'

// ── Door Config (UI metadata) ─────────────────────────────────

export interface DoorConfig {
  type: DoorType
  label: string
  color: string
  borderColor: string
  shadowColor: string
  glowColor: string
}

export const DOOR_CONFIGS: Record<DoorType, DoorConfig> = {
  conventional: {
    type: 'conventional',
    label: 'The Surface Door',
    color: 'text-zyvv-cyan',
    borderColor: 'border-zyvv-cyan',
    shadowColor: 'shadow-cyan',
    glowColor: '#00F5FF',
  },
  contrarian: {
    type: 'contrarian',
    label: 'The Friction Door',
    color: 'text-zyvv-amber',
    borderColor: 'border-zyvv-amber',
    shadowColor: 'shadow-amber',
    glowColor: '#FFB830',
  },
  alien: {
    type: 'alien',
    label: 'The Depth Door',
    color: 'text-zyvv-purple',
    borderColor: 'border-zyvv-purple',
    shadowColor: 'shadow-purple',
    glowColor: '#BF5AF2',
  },
}
// ── MANA: Assumption Breach ───────────────────────────────────
export interface AssumptionBreachDisplay {
  assumption: string
  signal: string
  searchQuery?: string
}

// ── YUGA: Context Signal ──────────────────────────────────────
export interface ContextSignalDisplay {
  signal: string
  query: string
}

export type ZyvvVersion = 'mana' | 'yuga' | 'torah'

export interface GenerateResponse {
  roast: string
  doors: Door[]
  situation_id: number
  structuredData?: StructuredData
  breach: AssumptionBreachDisplay | null        // MANA
  contextSignal: ContextSignalDisplay | null    // YUGA
  torahSource: SefariaSourceDisplay | null      // TORAH
}

// ── TORAH: Sefaria Source ─────────────────────────────────────
export interface SefariaCommentaryDisplay {
  commentator: string
  era: string
  ref: string
}

export interface SefariaSourceDisplay {
  baseRef: string
  baseSignal: string
  chainSummary: string
  commentaryChain: SefariaCommentaryDisplay[]
  query: string
}