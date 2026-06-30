// InterviewCapture: manages mic capture, video capture, and flag streaming
// Task 4: audio section (connect, startAudio, stopAudio, playAudio, sendFlag, disconnect)
// Task 5: startVideo, stopVideo will be added here
// Task 6: startFaceDetection, stopFaceDetection, startProctoring, stopProctoring will be added here

export interface ProctoringEvent {
  type: string
  ts: string
  [key: string]: unknown
}

type AudioCallback = (base64: string) => void
type TranscriptCallback = (role: string, text: string) => void

export class InterviewCapture {
  private ws: WebSocket | null = null
  private audioCtx: AudioContext | null = null
  private micStream: MediaStream | null = null
  private workletNode: AudioWorkletNode | null = null
  private onAudioCb: AudioCallback | null = null
  private onTranscriptCb: TranscriptCallback | null = null
  private sessionToken: string

  constructor(token: string) {
    this.sessionToken = token
  }

  // --- WebSocket connection ---

  connect(backendWsUrl: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${backendWsUrl}/interview/${this.sessionToken}`
      this.ws = new WebSocket(url)
      this.ws.onopen = () => resolve()
      this.ws.onerror = (_e) => reject(new Error('WS connection failed'))
      this.ws.onmessage = (e) => this._handleServerMessage(e)
    })
  }

  private _handleServerMessage(e: MessageEvent) {
    let msg: { type: string; data?: string; role?: string; text?: string }
    try { msg = JSON.parse(e.data as string) } catch { return }

    if (msg.type === 'audio' && msg.data && this.onAudioCb) {
      this.onAudioCb(msg.data)
    }
    if (msg.type === 'transcript' && msg.role && msg.text && this.onTranscriptCb) {
      this.onTranscriptCb(msg.role, msg.text)
    }
  }

  onAudio(cb: AudioCallback) { this.onAudioCb = cb }
  onTranscript(cb: TranscriptCallback) { this.onTranscriptCb = cb }

  // --- Mic capture ---

  async startAudio(): Promise<void> {
    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true },
      video: false,
    })
    this.audioCtx = new AudioContext({ sampleRate: 16000 })
    await this.audioCtx.audioWorklet.addModule('/pcm-processor.js')
    const source = this.audioCtx.createMediaStreamSource(this.micStream)
    this.workletNode = new AudioWorkletNode(this.audioCtx, 'pcm-processor')
    this.workletNode.port.onmessage = (e: MessageEvent<Float32Array>) => {
      this._sendAudioChunk(e.data)
    }
    source.connect(this.workletNode)
    // AudioWorklet output doesn't need to connect to destination (we only capture)
  }

  private _sendAudioChunk(float32: Float32Array) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    // Convert Float32 → Int16 (PCM16 mono 16 kHz)
    const int16 = new Int16Array(float32.length)
    for (let i = 0; i < float32.length; i++) {
      int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768))
    }
    // Base64 encode
    const bytes = new Uint8Array(int16.buffer)
    let binary = ''
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i])
    const base64 = btoa(binary)
    this.ws.send(JSON.stringify({ type: 'audio', data: base64 }))
  }

  stopAudio() {
    this.workletNode?.disconnect()
    this.micStream?.getTracks().forEach((t) => t.stop())
    this.audioCtx?.close()
    this.workletNode = null
    this.micStream = null
    this.audioCtx = null
  }

  // --- Play Gemini's audio response (mono PCM16 at 24 kHz) ---

  async playAudio(base64: string): Promise<void> {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const int16 = new Int16Array(bytes.buffer)
    const playCtx = new AudioContext({ sampleRate: 24000 })
    const buffer = playCtx.createBuffer(1, int16.length, 24000)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < int16.length; i++) channel[i] = int16[i] / 32768
    const source = playCtx.createBufferSource()
    source.buffer = buffer
    source.connect(playCtx.destination)
    source.start()
    return new Promise((resolve) => { source.onended = () => { playCtx.close(); resolve() } })
  }

  // --- Flag streaming ---

  sendFlag(event: ProctoringEvent) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(JSON.stringify({ type: 'flag', event }))
  }

  // --- Cleanup ---

  disconnect() {
    this.stopAudio()
    this.ws?.close()
    this.ws = null
  }

  // --- Video capture (Task 5) ---
  // startVideo(): Promise<void> { ... }
  // stopVideo(): void { ... }

  // --- Face detection / proctoring (Task 6) ---
  // startFaceDetection(): Promise<void> { ... }
  // stopFaceDetection(): void { ... }
  // startProctoring(): void { ... }
  // stopProctoring(): void { ... }
}
