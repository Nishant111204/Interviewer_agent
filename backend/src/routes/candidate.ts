import { Router, Request, Response } from 'express'
import { supabaseService } from '../services/supabase'

const router = Router()

// In-memory rate limiter: 5 requests per token per 60 seconds
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()

function checkRateLimit(token: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(token)
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(token, { count: 1, resetAt: now + 60_000 })
    return true
  }
  if (entry.count >= 5) return false
  entry.count++
  return true
}

// PATCH /candidate/sessions/:token/descriptor
// No authMiddleware — candidate identifies via invite token only.
router.patch('/sessions/:token/descriptor', async (req: Request, res: Response) => {
  const { token } = req.params
  const { descriptor } = req.body as { descriptor?: unknown }

  if (!token || !/^[a-f0-9]{64}$/.test(token)) {
    res.status(400).json({ error: 'Invalid token format' })
    return
  }

  if (!Array.isArray(descriptor) || descriptor.length !== 128 || !descriptor.every(n => typeof n === 'number')) {
    res.status(400).json({ error: 'descriptor must be an array of 128 numbers' })
    return
  }

  if (!checkRateLimit(token)) {
    res.status(429).json({ error: 'Too many requests' })
    return
  }

  const result = await supabaseService.saveFaceDescriptor(token, descriptor as number[])

  switch (result) {
    case 'ok':
      res.json({ ok: true })
      break
    case 'already_set':
      res.status(409).json({ ok: true, alreadySet: true })
      break
    case 'not_found':
      res.status(404).json({ error: 'Session not found' })
      break
    case 'not_pending':
      res.status(403).json({ error: 'Session is not in pending state' })
      break
    default:
      res.status(500).json({ error: 'Failed to save descriptor' })
  }
})

export default router
