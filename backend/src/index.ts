import 'dotenv/config'
import express from 'express'
import { createServer } from 'http'
import { WebSocketServer } from 'ws'
import { URL } from 'url'
import { handleInterviewSocket } from './websocket/interviewRelay'
import sessionsRouter from './routes/sessions'

const app = express()
app.use(express.json())

// Health check
app.get('/health', (_req, res) => res.json({ ok: true }))

// REST routes
app.use('/api/sessions', sessionsRouter)

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
