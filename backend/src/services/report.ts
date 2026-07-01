import { getSupabaseClient } from './supabase'

interface FlagRow { flag_type: string }
interface TurnRow { role: string; score: number | null }

function calcSuspicionScore(flags: FlagRow[]): number {
  const counts: Record<string, number> = {}
  for (const f of flags) counts[f.flag_type] = (counts[f.flag_type] ?? 0) + 1
  let score = 0
  if ((counts['face_absent'] ?? 0) > 3) score += 20
  if ((counts['face_multiple'] ?? 0) > 0) score += 30
  const extraTabs = Math.max(0, (counts['tab_switch'] ?? 0) - 2)
  score += extraTabs * 15
  if ((counts['gaze_away'] ?? 0) > 0) score += 10
  score += (counts['copy_attempt'] ?? 0) * 15
  score += (counts['paste_attempt'] ?? 0) * 20
  const cappedFullscreen = Math.min(counts['fullscreen_exit'] ?? 0, 2)
  score += cappedFullscreen * 10
  score += (counts['right_click'] ?? 0) * 2
  score += (counts['keyboard_shortcut'] ?? 0) * 3
  return Math.min(score, 100)
}

function calcOverallScore(turns: TurnRow[]): number | null {
  const scored = turns
    .filter(t => t.role === 'user' && t.score != null)
    .map(t => t.score as number)
  if (scored.length === 0) return null
  return Math.round((scored.reduce((a, b) => a + b, 0) / scored.length) * 10) / 10
}

export async function generateReport(sessionId: string): Promise<void> {
  const supabase = getSupabaseClient()
  const [{ data: flags, error: flagsErr }, { data: turns, error: turnsErr }] = await Promise.all([
    supabase.from('proctoring_flags').select('flag_type').eq('session_id', sessionId),
    supabase.from('transcript_turns').select('role, score').eq('session_id', sessionId),
  ])
  if (flagsErr) console.error('[Report] Failed to fetch flags:', flagsErr)
  if (turnsErr) console.error('[Report] Failed to fetch turns:', turnsErr)
  const suspicionScore = calcSuspicionScore((flags ?? []) as FlagRow[])
  const overallScore = calcOverallScore((turns ?? []) as TurnRow[])
  const update: Record<string, number> = { suspicion_score: suspicionScore }
  if (overallScore !== null) update.overall_score = overallScore
  const { error: updateErr } = await supabase.from('sessions').update(update).eq('id', sessionId)
  if (updateErr) console.error('[Report] Failed to persist scores:', updateErr)
  else console.log(`[Report] session=${sessionId} suspicion=${suspicionScore} overall=${overallScore ?? 'n/a'}`)
}
