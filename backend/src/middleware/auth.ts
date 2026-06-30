import { Request, Response, NextFunction } from 'express'
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
  const token = header.slice(7)

  supabaseService.verifyToken(token)
    .then(user => {
      if (!user) {
        res.status(401).json({ error: 'Invalid token' })
        return
      }
      return supabaseService.getHrUser(user.id).then(hrUser => {
        if (!hrUser) {
          res.status(403).json({ error: 'Not an HR user' })
          return
        }
        req.hrUserId = user.id
        req.orgId = hrUser.org_id
        next()
      })
    })
    .catch(() => {
      res.status(500).json({ error: 'Auth check failed' })
    })
}
