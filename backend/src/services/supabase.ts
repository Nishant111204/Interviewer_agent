import { createClient, SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import type { QuestionSet } from '../agents/interviewer'

// Lazy-initialised so the server boots even when SUPABASE_URL is not yet set.
let _supabase: SupabaseClient | null = null
function getClient(): SupabaseClient {
  if (!_supabase) {
    const url = process.env.SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
      throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set')
    }
    _supabase = createClient(url, key, {
      realtime: { transport: require('ws') },
    })
  }
  return _supabase
}

const FLAG_SEVERITY: Record<string, 'low' | 'medium' | 'high'> = {
  tab_switch: 'medium',
  window_blur: 'low',
  face_absent: 'medium',
  face_multiple: 'high',
  gaze_away: 'low',
  copy_attempt: 'high',
  paste_attempt: 'high',
  fullscreen_exit: 'medium',
  right_click: 'low',
  keyboard_shortcut: 'low',
  impersonation: 'high',
}

export const supabaseService = {
  async getSession(token: string) {
    const { data, error } = await getClient()
      .from('sessions')
      .select('*, question_sets(*)')
      .eq('token', token)
      .single()
    if (error || !data) return null
    return {
      id: data.id as string,
      status: data.status as string,
      expires_at: data.expires_at as string,
      candidate_name: data.candidate_name as string,
      question_set: data.question_sets as unknown as QuestionSet,
    }
  },

  async markSessionStarted(sessionId: string) {
    const { error } = await getClient()
      .from('sessions')
      .update({ status: 'in_progress', started_at: new Date().toISOString() })
      .eq('id', sessionId)
    if (error) console.error('[DB] markSessionStarted error:', error)
  },

  async saveScore(sessionId: string, questionId: string, score: number, notes: string) {
    const supabase = getClient()

    // Fetch the most-recent unscored candidate turn for this session
    const { data: turns, error: fetchErr } = await supabase
      .from('transcript_turns')
      .select('id')
      .eq('session_id', sessionId)
      .eq('role', 'user')
      .is('question_id', null)
      .order('ts', { ascending: false })
      .limit(1)

    if (fetchErr) {
      console.error('[DB] saveScore fetch error:', fetchErr)
    } else if (turns && turns.length > 0) {
      const { error: updateErr } = await supabase
        .from('transcript_turns')
        .update({ score, question_id: questionId })
        .eq('id', turns[0].id)
      if (updateErr) console.error('[DB] saveScore update error:', updateErr)
    }

    // Insert a scorer notes record
    const { error: insertErr } = await supabase.from('transcript_turns').insert({
      session_id: sessionId,
      role: 'model',
      text: `[Score: ${score}/10] ${notes}`,
      question_id: questionId,
      score,
    })
    if (insertErr) console.error('[DB] saveScore insert error:', insertErr)
  },

  async saveTranscriptTurn(sessionId: string, role: string, text: string) {
    const { error } = await getClient().from('transcript_turns').insert({ session_id: sessionId, role, text })
    if (error) console.error('[DB] saveTranscriptTurn error:', error)
  },

  async saveFlag(sessionId: string, flag: { type: string; ts: string; [k: string]: unknown }) {
    const { error } = await getClient().from('proctoring_flags').insert({
      session_id: sessionId,
      flag_type: flag.type,
      severity: FLAG_SEVERITY[flag.type] ?? 'low',
      detail: flag,
      ts: flag.ts,
    })
    if (error) console.error('[DB] saveFlag error:', error)
  },

  async finalizeSession(sessionId: string, recommendation: string, _summary: string) {
    const { error } = await getClient()
      .from('sessions')
      .update({
        status: 'completed',
        ended_at: new Date().toISOString(),
        recommendation,
      })
      .eq('id', sessionId)
    if (error) console.error('[DB] finalizeSession error:', error)
  },

  async createSession(params: {
    org_id: string
    created_by: string
    candidate_name: string
    candidate_email: string
    job_title: string
    question_set_id: string
  }) {
    const token = crypto.randomBytes(32).toString('hex')
    const { data, error } = await getClient()
      .from('sessions')
      .insert({ ...params, token })
      .select()
      .single()
    if (error) throw error
    return data as { id: string; token: string }
  },

  async listSessions(orgId: string) {
    const { data, error } = await getClient()
      .from('sessions')
      .select('id, candidate_name, candidate_email, job_title, status, suspicion_score, recommendation, overall_score, created_at, started_at, ended_at')
      .eq('org_id', orgId)
      .order('created_at', { ascending: false })
    if (error) throw error
    return data ?? []
  },

  async getSessionDetail(sessionId: string, orgId: string) {
    const [{ data: session }, { data: turns }, { data: flags }] = await Promise.all([
      getClient().from('sessions').select('*').eq('id', sessionId).eq('org_id', orgId).single(),
      getClient().from('transcript_turns').select('*').eq('session_id', sessionId).order('ts'),
      getClient().from('proctoring_flags').select('*').eq('session_id', sessionId).order('ts'),
    ])
    return { session, turns: turns ?? [], flags: flags ?? [] }
  },

  async saveFaceDescriptor(token: string, descriptor: number[]): Promise<'ok' | 'not_found' | 'not_pending' | 'already_set' | 'error'> {
    const { data, error } = await getClient()
      .from('sessions')
      .select('id, status, face_descriptor')
      .eq('token', token)
      .single()

    if (error || !data) return 'not_found'
    if (data.status !== 'pending') return 'not_pending'
    if (data.face_descriptor !== null) return 'already_set'

    const { error: updateError } = await getClient()
      .from('sessions')
      .update({ face_descriptor: descriptor })
      .eq('id', data.id)

    if (updateError) {
      console.error('[DB] saveFaceDescriptor error:', updateError)
      return 'error'
    }
    return 'ok'
  },

  async getHrUser(userId: string): Promise<{ org_id: string } | null> {
    const { data, error } = await getClient()
      .from('hr_users')
      .select('org_id')
      .eq('id', userId)
      .single()
    if (error || !data) return null
    return { org_id: data.org_id as string }
  },

  async listQuestionSets(): Promise<Array<{ id: string; role: string }>> {
    const { data, error } = await getClient()
      .from('question_sets')
      .select('id, role')
    if (error) throw error
    return (data ?? []) as Array<{ id: string; role: string }>
  },

  async verifyToken(token: string): Promise<{ id: string } | null> {
    const { data: { user }, error } = await getClient().auth.getUser(token)
    if (error || !user) return null
    return { id: user.id }
  },
}
