import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { URL } from 'url'
import { handleInterviewSocket } from './websocket/interviewRelay'
import sessionsRouter from './routes/sessions'
import candidateRouter from './routes/candidate'
import questionSetsRouter from './routes/questionSets'

const app = express()
app.use(cors({ origin: process.env.FRONTEND_URL ?? 'http://localhost:3000' }))
app.use(express.json())

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }))

// REST routes — HR (JWT-protected via authMiddleware inside sessionsRouter)
app.use('/api/sessions', sessionsRouter)

// REST routes — candidate (token-based auth, no JWT)
app.use('/candidate', candidateRouter)

// REST routes — question sets (JWT-protected)
app.use('/api/question-sets', questionSetsRouter)

const server = createServer(app)
const wss = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '', `http://${req.headers.host}`)
  const match = url.pathname.match(/^\/interview\/([a-f0-9]{64})$/)
  if (!match) {
    socket.destroy()
    return
  }
  const token = match[1]
  wss.handleUpgrade(req, socket, head, (ws) => {
    handleInterviewSocket(ws, token)
  })
})

const PORT = process.env.PORT ?? 3001
server.listen(PORT, () => console.log(`Backend listening on :${PORT}`))
