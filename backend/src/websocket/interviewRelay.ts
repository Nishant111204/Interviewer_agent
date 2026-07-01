// backend/src/websocket/interviewRelay.ts
import WebSocket from 'ws'
import {
  GoogleGenAI,
  Modality,
  FunctionResponse,
  type LiveServerMessage,
  type FunctionCall,
  type Session,
  type Part,
} from '@google/genai'
import {
  buildSystemPromptText,
  interviewerTools,
  executeTool,
  type InterviewContext,
} from '../agents/interviewer'
import { supabaseService } from '../services/supabase'
import { generateReport } from '../services/report'

interface ProctoringFlag {
  type: string
  ts: string
  [key: string]: unknown
}

interface BrowserMessage {
  type: 'audio' | 'video' | 'flag' | 'transcript'
  data?: string
  event?: ProctoringFlag
  text?: string
  role?: string
}

export async function handleInterviewSocket(ws: WebSocket, token: string) {
  const db = supabaseService

  const session = await db.getSession(token)
  if (!session) { ws.close(4001, 'Session not found'); return }
  if (session.status !== 'pending') { ws.close(4002, 'Session already completed or expired'); return }
  if (new Date(session.expires_at) <= new Date()) { ws.close(4003, 'Session link expired'); return }

  await db.markSessionStarted(session.id)
  console.log(`[WS] Interview started: session=${session.id}`)

  const apiKey = process.env.GOOGLE_API_KEY
  if (!apiKey) {
    console.error('[WS] GOOGLE_API_KEY not set')
    ws.close(1011, 'Server misconfiguration')
    return
  }

  const ctx: InterviewContext = {
    candidateName: session.candidate_name,
    jobRole: session.job_role || 'the role',
    experienceYears: session.experience_years || 'Fresher',
    jdText: session.jd_text ?? undefined,
    jdFileUri: session.jd_file_uri ?? undefined,
    resumeText: session.resume_text ?? undefined,
    resumeFileUri: session.resume_file_uri ?? undefined,
    linkedinUrl: session.linkedin_url ?? undefined,
    customInstructions: session.custom_instructions ?? undefined,
    useQuestionSet: session.use_question_set,
    questionSet: session.use_question_set && session.question_set ? session.question_set : undefined,
  }

  const systemParts: Part[] = [{ text: buildSystemPromptText(ctx) }]
  if (ctx.jdFileUri) systemParts.push({ fileData: { mimeType: 'application/pdf', fileUri: ctx.jdFileUri } })
  if (ctx.resumeFileUri) systemParts.push({ fileData: { mimeType: 'application/pdf', fileUri: ctx.resumeFileUri } })

  const ai = new GoogleGenAI({ apiKey })
  let liveSession: Session | null = null
  let sessionClosed = false
  const pendingMessages: BrowserMessage[] = []

  const connectPromise = ai.live.connect({
    model: 'gemini-2.0-flash-exp',
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: { parts: systemParts },
      tools: [{ functionDeclarations: interviewerTools }],
    },
    callbacks: {
      onopen: () => {
        console.log('[WS] Gemini Live connected, session=', session.id)
      },
      onmessage: (msg: LiveServerMessage) => {
        handleGeminiMessage(msg, ws, session.id, db, liveSession).catch((err) =>
          console.error('[WS] Error handling Gemini message:', err),
        )
      },
      onerror: (e: { message?: string; error?: unknown }) => {
        console.error('[WS] Gemini Live error:', e.message ?? e)
      },
      onclose: (e: { code?: number; reason?: string }) => {
        console.log('[WS] Gemini Live closed:', e.code, e.reason)
        sessionClosed = true
        if (ws.readyState === WebSocket.OPEN) ws.close(1000, 'AI session ended')
      },
    },
  })

  connectPromise
    .then((ls) => {
      liveSession = ls
      console.log('[WS] Sending initial greeting trigger, session=', session.id)
      try {
        ls.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: 'Hello, I am ready to begin.' }] }],
          turnComplete: true,
        })
      } catch (err) {
        console.error('[WS] Failed to send greeting trigger:', err)
      }

      for (const msg of pendingMessages) {
        dispatchToGemini(msg, liveSession!)
      }
      pendingMessages.length = 0
    })
    .catch((err) => {
      console.error('[WS] Failed to connect to Gemini Live:', err)
      ws.close(1011, 'Failed to start AI session')
    })

  ws.on('message', async (raw) => {
    let msg: BrowserMessage
    try { msg = JSON.parse(raw.toString()) } catch { return }

    if (msg.type === 'flag') {
      if (msg.event) await db.saveFlag(session.id, msg.event)
      return
    }

    if (!liveSession) { pendingMessages.push(msg); return }
    dispatchToGemini(msg, liveSession)
  })

  ws.on('close', () => {
    console.log(`[WS] Browser disconnected: session=${session.id}`)
    if (!sessionClosed) liveSession?.close()
    generateReport(session.id).catch(err =>
      console.error('[Report] Failed to generate:', err),
    )
  })

  ws.on('error', (err) => {
    console.error('[WS] Browser socket error:', err)
    if (!sessionClosed) liveSession?.close()
  })
}

function dispatchToGemini(msg: BrowserMessage, liveSession: Session) {
  switch (msg.type) {
    case 'audio':
      if (msg.data) liveSession.sendRealtimeInput({ audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' } })
      break
    case 'video':
      if (msg.data) liveSession.sendRealtimeInput({ video: { data: msg.data, mimeType: 'image/jpeg' } })
      break
  }
}

async function handleGeminiMessage(
  msg: LiveServerMessage,
  ws: WebSocket,
  sessionId: string,
  db: typeof supabaseService,
  liveSession: Session | null,
) {
  const content = msg.serverContent

  if (content?.modelTurn?.parts) {
    for (const part of content.modelTurn.parts) {
      if (part.inlineData?.data && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'audio', data: part.inlineData.data }))
      }
      if (part.text) {
        await db.saveTranscriptTurn(sessionId, 'model', part.text)
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'transcript', role: 'model', text: part.text }))
        }
      }
    }
  }

  if (content?.inputTranscription?.text) {
    const text = content.inputTranscription.text
    await db.saveTranscriptTurn(sessionId, 'user', text)
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'transcript', role: 'user', text }))
  }

  if (content?.outputTranscription?.text) {
    const text = content.outputTranscription.text
    await db.saveTranscriptTurn(sessionId, 'model', text)
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'transcript', role: 'model', text }))
  }

  if (msg.toolCall?.functionCalls && liveSession) {
    const responses = await runToolCalls(msg.toolCall.functionCalls, sessionId, db)
    if (responses.length > 0) liveSession.sendToolResponse({ functionResponses: responses })
  }
}

async function runToolCalls(
  calls: FunctionCall[],
  sessionId: string,
  db: typeof supabaseService,
): Promise<FunctionResponse[]> {
  const responses: FunctionResponse[] = []

  for (const call of calls) {
    const name = call.name ?? ''
    const args = (call.args ?? {}) as Record<string, unknown>
    let result: Record<string, unknown>

    try {
      result = await executeTool(name, args, sessionId, db)
    } catch (err) {
      console.error(`[WS] Error executing tool ${name}:`, err)
      result = { error: String(err) }
    }

    const fr = new FunctionResponse()
    fr.id = call.id ?? ''
    fr.name = name
    fr.response = result
    responses.push(fr)
  }

  return responses
}
