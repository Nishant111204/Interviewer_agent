/**
 * interviewRelay.ts
 *
 * WebSocket relay between the browser and the Gemini Live API.
 *
 * ADK context:  @google/adk v0.1.3 exports LlmAgent but its runLiveFlow()
 * method throws "not implemented". We therefore bypass the ADK runner and
 * drive the Gemini Live API directly through @google/genai's
 * GoogleGenAI.live.connect().  The ADK LlmAgent is still created (for its
 * canonical instruction and tool declarations) — we extract those values and
 * pass them in the live connect config so the conversation behaves exactly as
 * the agent brief specifies.
 */

import WebSocket from 'ws'
import {
  GoogleGenAI,
  Modality,
  FunctionResponse,
  type LiveServerMessage,
  type FunctionCall,
  type Session,
  type FunctionDeclaration,
} from '@google/genai'
import { createInterviewerAgent, frontendQuestionSet, type QuestionSet } from '../agents/interviewer'
import { FunctionTool, LlmAgent } from '@google/adk'

// ---------------------------------------------------------------------------
// Stub DB — replace with real supabaseService in Task 3
// ---------------------------------------------------------------------------

interface ProctoringFlag {
  type: string
  ts: string
  [key: string]: unknown
}

interface StubDB {
  getSession(token: string): Promise<StubSession | null>
  saveScore(sessionId: string, questionId: string, score: number, notes: string): Promise<void>
  finalizeSession(sessionId: string, recommendation: string, summary: string): Promise<void>
  saveFlag(sessionId: string, flag: ProctoringFlag): Promise<void>
  saveTranscriptTurn(sessionId: string, role: string, text: string): Promise<void>
  markSessionStarted(sessionId: string): Promise<void>
}

interface StubSession {
  id: string
  status: string
  expires_at: string
  candidate_name: string
  question_set: QuestionSet
}

const stubDb: StubDB = {
  async getSession(_token: string) {
    // Returns a valid stub session — real lookup comes in Task 3.
    return {
      id: 'test-session-id',
      status: 'pending',
      expires_at: new Date(Date.now() + 48 * 3600 * 1000).toISOString(),
      candidate_name: 'Test Candidate',
      question_set: frontendQuestionSet,
    }
  },
  async saveScore(sessionId, questionId, score, notes) {
    console.log('[DB stub] saveScore', { sessionId, questionId, score, notes })
  },
  async finalizeSession(sessionId, recommendation, summary) {
    console.log('[DB stub] finalizeSession', { sessionId, recommendation, summary })
  },
  async saveFlag(sessionId, flag) {
    console.log('[DB stub] saveFlag', { sessionId, flag })
  },
  async saveTranscriptTurn(sessionId, role, text) {
    console.log('[DB stub] saveTranscriptTurn', { sessionId, role, text })
  },
  async markSessionStarted(sessionId) {
    console.log('[DB stub] markSessionStarted', sessionId)
  },
}

// ---------------------------------------------------------------------------
// Browser message types
// ---------------------------------------------------------------------------

interface BrowserMessage {
  type: 'audio' | 'video' | 'flag' | 'transcript'
  data?: string       // base64 for audio/video
  event?: ProctoringFlag
  text?: string
  role?: string
}

// ---------------------------------------------------------------------------
// Helper: extract canonical instruction string from LlmAgent
// ---------------------------------------------------------------------------

function getAgentInstruction(agent: LlmAgent): string {
  const instr = agent.canonicalInstruction
  if (typeof instr === 'string') return instr
  // canonicalInstruction may be a provider function in some agent configs;
  // for v0.1.3 our agent always uses a string literal.
  return String(instr ?? '')
}

// ---------------------------------------------------------------------------
// Helper: build tool declaration list from the agent's FunctionTool list.
// We call the tool's _getDeclaration() method (present in v0.1.3) to get the
// { name, description, parameters } object expected by the Live API.
// ---------------------------------------------------------------------------

type ToolWithDeclaration = FunctionTool & {
  _getDeclaration(): FunctionDeclaration
}

async function buildToolDeclarations(agent: LlmAgent): Promise<FunctionDeclaration[]> {
  // canonicalTools() is an async method returning BaseTool[]
  const tools = await agent.canonicalTools()
  return tools
    .filter((t): t is ToolWithDeclaration => t instanceof FunctionTool && '_getDeclaration' in t)
    .map((t) => t._getDeclaration())
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleInterviewSocket(ws: WebSocket, token: string) {
  // --- GUARD: validate session upfront ---
  const session = await stubDb.getSession(token)
  if (!session) {
    ws.close(4001, 'Session not found')
    return
  }
  if (session.status !== 'pending') {
    ws.close(4002, 'Session already completed or expired')
    return
  }
  if (new Date(session.expires_at) <= new Date()) {
    ws.close(4003, 'Session link expired')
    return
  }

  await stubDb.markSessionStarted(session.id)
  console.log(`[WS] Interview started: session=${session.id}`)

  // --- Build ADK agent to extract instruction + tool declarations ---
  const agent = createInterviewerAgent(
    session.question_set,
    session.id,
    stubDb,
    session.candidate_name,
  )

  const systemInstruction = getAgentInstruction(agent)
  const toolDeclarations = await buildToolDeclarations(agent)

  // --- Connect to Gemini Live API via @google/genai ---
  const apiKey = process.env.GOOGLE_API_KEY
  if (!apiKey) {
    console.error('[WS] GOOGLE_API_KEY not set')
    ws.close(1011, 'Server misconfiguration')
    return
  }

  const ai = new GoogleGenAI({ apiKey })

  // liveSession will be set after connect() resolves
  let liveSession: Session | null = null
  let sessionClosed = false

  // Queue incoming browser audio/video until session is ready
  const pendingMessages: BrowserMessage[] = []

  const connectPromise = ai.live.connect({
    model: 'gemini-live-2.5-flash',
    config: {
      responseModalities: [Modality.AUDIO],
      systemInstruction: systemInstruction
        ? { parts: [{ text: systemInstruction }] }
        : undefined,
      tools: toolDeclarations.length > 0
        ? [{ functionDeclarations: toolDeclarations }]
        : undefined,
    },
    callbacks: {
      onopen: () => {
        console.log('[WS] Gemini Live connected, session=', session.id)
      },
      onmessage: (msg: LiveServerMessage) => {
        handleGeminiMessage(msg, ws, session.id, stubDb, liveSession).catch((err) =>
          console.error('[WS] Error handling Gemini message:', err),
        )
      },
      onerror: (e: { message?: string; error?: unknown }) => {
        console.error('[WS] Gemini Live error:', e.message ?? e)
      },
      onclose: (e: { code?: number; reason?: string }) => {
        console.log('[WS] Gemini Live closed:', e.code, e.reason)
        sessionClosed = true
        if (ws.readyState === WebSocket.OPEN) {
          ws.close(1000, 'AI session ended')
        }
      },
    },
  })

  connectPromise
    .then((ls) => {
      liveSession = ls
      // Drain any messages queued while connecting
      for (const msg of pendingMessages) {
        dispatchToGemini(msg, liveSession!).catch((err) =>
          console.error('[WS] Drain error:', err),
        )
      }
      pendingMessages.length = 0
    })
    .catch((err) => {
      console.error('[WS] Failed to connect to Gemini Live:', err)
      ws.close(1011, 'Failed to start AI session')
    })

  // --- Relay browser messages to Gemini ---
  ws.on('message', async (raw) => {
    let msg: BrowserMessage
    try {
      msg = JSON.parse(raw.toString())
    } catch {
      return
    }

    if (msg.type === 'flag') {
      if (msg.event) {
        await stubDb.saveFlag(session.id, msg.event)
      }
      return
    }

    if (!liveSession) {
      // Buffer until session is ready
      pendingMessages.push(msg)
      return
    }

    await dispatchToGemini(msg, liveSession)
  })

  ws.on('close', () => {
    console.log(`[WS] Browser disconnected: session=${session.id}`)
    if (!sessionClosed) {
      liveSession?.close()
    }
  })

  ws.on('error', (err) => {
    console.error('[WS] Browser socket error:', err)
    if (!sessionClosed) {
      liveSession?.close()
    }
  })
}

// ---------------------------------------------------------------------------
// Dispatch a browser message to the Gemini Live session
// ---------------------------------------------------------------------------

async function dispatchToGemini(msg: BrowserMessage, liveSession: Session) {
  switch (msg.type) {
    case 'audio':
      if (msg.data) {
        await liveSession.sendRealtimeInput({
          audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' },
        })
      }
      break

    case 'video':
      if (msg.data) {
        await liveSession.sendRealtimeInput({
          video: { data: msg.data, mimeType: 'image/jpeg' },
        })
      }
      break

    default:
      break
  }
}

// ---------------------------------------------------------------------------
// Handle a message arriving from Gemini Live
// ---------------------------------------------------------------------------

async function handleGeminiMessage(
  msg: LiveServerMessage,
  ws: WebSocket,
  sessionId: string,
  db: StubDB,
  liveSession: Session | null,
) {
  const content = msg.serverContent

  if (content?.modelTurn?.parts) {
    for (const part of content.modelTurn.parts) {
      // Audio chunk from Gemini (PCM16 24kHz, base64)
      if (part.inlineData?.data) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'audio', data: part.inlineData.data }))
        }
      }
      // Text part (transcript from model)
      if (part.text) {
        db.saveTranscriptTurn(sessionId, 'model', part.text)
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'transcript', role: 'model', text: part.text }))
        }
      }
    }
  }

  // Input transcription (user's speech transcribed)
  if (content?.inputTranscription?.text) {
    const text = content.inputTranscription.text
    db.saveTranscriptTurn(sessionId, 'user', text)
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'transcript', role: 'user', text }))
    }
  }

  // Output transcription (model speech transcribed)
  if (content?.outputTranscription?.text) {
    const text = content.outputTranscription.text
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'transcript', role: 'model', text }))
    }
  }

  // Tool call — Gemini wants us to execute a function
  if (msg.toolCall?.functionCalls && liveSession) {
    const responses = await executeFunctionCalls(msg.toolCall.functionCalls, sessionId, db)
    if (responses.length > 0) {
      liveSession.sendToolResponse({ functionResponses: responses })
    }
  }
}

// ---------------------------------------------------------------------------
// Execute tool calls requested by the model and return FunctionResponse objects
// ---------------------------------------------------------------------------

async function executeFunctionCalls(
  calls: FunctionCall[],
  sessionId: string,
  db: StubDB,
): Promise<FunctionResponse[]> {
  const responses: FunctionResponse[] = []

  for (const call of calls) {
    const name = call.name ?? ''
    const args = (call.args ?? {}) as Record<string, unknown>
    const id = call.id ?? ''
    let result: Record<string, unknown> = {}

    try {
      if (name === 'score_answer') {
        const questionId = args['question_id'] as string
        const score = args['score'] as number
        const notes = args['notes'] as string
        await db.saveScore(sessionId, questionId, score, notes)
        result = { saved: true }
      } else if (name === 'end_interview') {
        const recommendation = args['recommendation'] as string
        const summary = args['summary'] as string
        await db.finalizeSession(sessionId, recommendation, summary)
        result = { ended: true }
      } else {
        console.warn('[WS] Unknown tool call:', name)
        result = { error: `Unknown function: ${name}` }
      }
    } catch (err) {
      console.error(`[WS] Error executing tool ${name}:`, err)
      result = { error: String(err) }
    }

    const fr = new FunctionResponse()
    fr.id = id
    fr.name = name
    fr.response = result
    responses.push(fr)
  }

  return responses
}
