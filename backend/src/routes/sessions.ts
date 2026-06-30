import { Router } from 'express'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { supabaseService } from '../services/supabase'
import { emailService } from '../services/email'

const router = Router()
router.use(authMiddleware)

// POST /api/sessions — create session + send invite email
router.post('/', async (req: AuthRequest, res) => {
  const { candidate_name, candidate_email, job_title, question_set_id } = req.body
  if (!candidate_name || !candidate_email || !job_title || !question_set_id) {
    res.status(400).json({ error: 'Missing required fields' })
    return
  }
  try {
    const session = await supabaseService.createSession({
      org_id: req.orgId!,
      created_by: req.hrUserId!,
      candidate_name,
      candidate_email,
      job_title,
      question_set_id,
    })
    await emailService.sendInvite({
      to: candidate_email,
      candidateName: candidate_name,
      jobTitle: job_title,
      token: session.token,
    })
    res.status(201).json({ id: session.id, token: session.token })
  } catch (err) {
    console.error('[POST /api/sessions]', err)
    res.status(500).json({ error: 'Failed to create session' })
  }
})

// GET /api/sessions — list sessions for org
router.get('/', async (req: AuthRequest, res) => {
  try {
    const sessions = await supabaseService.listSessions(req.orgId!)
    res.json(sessions)
  } catch (err) {
    console.error('[GET /api/sessions]', err)
    res.status(500).json({ error: 'Failed to list sessions' })
  }
})

// GET /api/sessions/:id — full session detail
router.get('/:id', async (req: AuthRequest, res) => {
  try {
    const detail = await supabaseService.getSessionDetail(req.params.id, req.orgId!)
    if (!detail.session) {
      res.status(404).json({ error: 'Session not found' })
      return
    }
    res.json(detail)
  } catch (err) {
    console.error('[GET /api/sessions/:id]', err)
    res.status(500).json({ error: 'Failed to get session' })
  }
})

export default router
