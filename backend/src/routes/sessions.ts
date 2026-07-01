// backend/src/routes/sessions.ts
import { Router } from 'express'
import multer from 'multer'
import pdfParse from 'pdf-parse'
import { GoogleGenAI } from '@google/genai'
import { authMiddleware, AuthRequest } from '../middleware/auth'
import { supabaseService } from '../services/supabase'
import { emailService } from '../services/email'

const router = Router()
router.use(authMiddleware)

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
})

async function uploadPdfToGemini(buffer: Buffer, filename: string): Promise<string> {
  const apiKey = process.env.GOOGLE_API_KEY
  if (!apiKey) throw new Error('GOOGLE_API_KEY not set')
  const ai = new GoogleGenAI({ apiKey })
  const blob = new Blob([buffer], { type: 'application/pdf' })
  const file = await ai.files.upload({
    file: blob,
    config: { displayName: filename, mimeType: 'application/pdf' },
  })
  if (!file.uri) throw new Error('Files API returned no URI')
  return file.uri
}

async function extractPdfText(buffer: Buffer): Promise<string> {
  const data = await pdfParse(buffer)
  return data.text
}

async function resolveDocument(
  file: Express.Multer.File | undefined,
  text: string | undefined,
): Promise<{ text?: string; fileUri?: string }> {
  if (file) {
    try {
      const fileUri = await uploadPdfToGemini(file.buffer, file.originalname)
      return { fileUri }
    } catch (err) {
      console.warn('[sessions] Gemini Files API upload failed, falling back to pdf-parse:', err)
      const extracted = await extractPdfText(file.buffer)
      return { text: extracted }
    }
  }
  if (text) return { text }
  return {}
}

// POST /api/sessions — create session + send invite email
router.post(
  '/',
  upload.fields([
    { name: 'jd_file', maxCount: 1 },
    { name: 'resume_file', maxCount: 1 },
  ]),
  async (req: AuthRequest, res) => {
    const files = req.files as { [fieldname: string]: Express.Multer.File[] } | undefined
    const body = req.body as Record<string, string>

    const { candidate_name, candidate_email, job_title, job_role, experience_years } = body
    if (!candidate_name || !candidate_email || !job_title || !job_role || !experience_years) {
      res.status(400).json({ error: 'Missing required fields' })
      return
    }

    const use_question_set = body.use_question_set !== 'false'
    const question_set_id = body.question_set_id || undefined

    if (use_question_set && !question_set_id) {
      res.status(400).json({ error: 'question_set_id required when use_question_set is true' })
      return
    }

    try {
      const [jdResult, resumeResult] = await Promise.all([
        resolveDocument(files?.['jd_file']?.[0], body.jd_text || undefined),
        resolveDocument(files?.['resume_file']?.[0], body.resume_text || undefined),
      ])

      const session = await supabaseService.createSession({
        org_id: req.orgId!,
        created_by: req.hrUserId!,
        candidate_name,
        candidate_email,
        job_title,
        job_role,
        experience_years,
        question_set_id,
        use_question_set,
        jd_text: jdResult.text,
        jd_file_uri: jdResult.fileUri,
        resume_text: resumeResult.text,
        resume_file_uri: resumeResult.fileUri,
        linkedin_url: body.linkedin_url || undefined,
        custom_instructions: body.custom_instructions || undefined,
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
  },
)

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
