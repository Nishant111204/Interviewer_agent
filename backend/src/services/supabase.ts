// backend/src/services/supabase.ts
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import crypto from 'crypto'
import type { QuestionSet, FinalizeResult } from '../agents/interviewer'

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
      question_set: data.question_sets as unknown as QuestionSet | null,
      use_question_set: (data.use_question_set ?? true) as boolean,
      job_role: (data.job_role ?? '') as string,
      experience_years: (data.experience_years ?? 'Fresher') as string,
      jd_text: data.jd_text as string | null,
      jd_file_uri: data.jd_file_uri as string | null,
      resume_text: data.resume_text as string | null,
      resume_file_uri: data.resume_file_uri as string | null,
      linkedin_url: data.linkedin_url as string | null,
      custom_instructions: data.custom_instructions as string | null,
    }
  },

  async markSessionStarted(sessionId: string) {
    const { error } = await getClient()
      .from('sessions')
      .update({ status: 'in_progress', started_at: new Date().toISOString() })
      .eq('id', sessionId)
    if (error) console.error('[DB] markSessionStarted error:', error)
  },

  async saveScore(sessionId: string, area: string, score: number, notes: string) {
    const { error } = await getClient().from('transcript_turns').insert({
      session_id: sessionId,
      role: 'model',
      text: `[Competency: ${area} | Score: ${score}/5] ${notes}`,
      question_id: area,
      score,
    })
    if (error) console.error('[DB] saveScore error:', error)
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

  async finalizeSession(sessionId: string, result: FinalizeResult) {
    const { error } = await getClient()
      .from('sessions')
      .update({
        status: 'completed',
        ended_at: new Date().toISOString(),
        recommendation: result.recommendation,
        summary: result.summary,
        competency_ratings: result.competency_ratings,
        verified_strengths: result.verified_strengths,
        gaps: result.gaps,
        notable_signals: result.notable_signals ?? null,
        followup_areas: result.followup_areas ?? null,
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
    job_role: string
    experience_years: string
    question_set_id?: string
    use_question_set: boolean
    jd_text?: string
    jd_file_uri?: string
    resume_text?: string
    resume_file_uri?: string
    linkedin_url?: string
    custom_instructions?: string
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

export { getClient as getSupabaseClient }
