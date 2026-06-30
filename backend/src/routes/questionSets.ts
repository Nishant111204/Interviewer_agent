import { Router } from 'express'
import { authMiddleware } from '../middleware/auth'
import { supabaseService } from '../services/supabase'

const router = Router()
router.use(authMiddleware)

router.get('/', async (_req, res) => {
  try {
    const sets = await supabaseService.listQuestionSets()
    res.json(sets)
  } catch {
    res.status(500).json({ error: 'Failed to load question sets' })
  }
})

export default router
