import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'
import { supabaseService } from '../services/supabase'

export interface AuthRequest extends Request {
  hrUserId?: string
  orgId?: string
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization header' })
    return
  }
  let payload: { sub: string }
  try {
    payload = jwt.verify(header.slice(7), process.env.SUPABASE_JWT_SECRET!) as { sub: string }
  } catch {
    res.status(401).json({ error: 'Invalid token' })
    return
  }
  supabaseService.getHrUser(payload.sub)
    .then(hrUser => {
      if (!hrUser) {
        res.status(403).json({ error: 'Not an HR user' })
        return
      }
      req.hrUserId = payload.sub
      req.orgId = hrUser.org_id
      next()
    })
    .catch(() => {
      res.status(500).json({ error: 'Auth check failed' })
    })
}
