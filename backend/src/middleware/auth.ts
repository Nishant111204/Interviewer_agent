import { Request, Response, NextFunction } from 'express'
import jwt from 'jsonwebtoken'

export interface AuthRequest extends Request {
  hrUserId?: string
  orgId?: string
}

export function authMiddleware(req: AuthRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization header' })
    return
  }
  try {
    const payload = jwt.verify(header.slice(7), process.env.JWT_SECRET!) as {
      sub: string
      org_id: string
    }
    req.hrUserId = payload.sub
    req.orgId = payload.org_id
    next()
  } catch {
    res.status(401).json({ error: 'Invalid token' })
  }
}
