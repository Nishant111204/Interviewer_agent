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

  // --- Video capture fields (Task 5) ---
  private videoStream: MediaStream | null = null
  private videoInterval: ReturnType<typeof setInterval> | null = null

  // --- Face detection fields (Task 5) ---
  private faceRafId: number | null = null
  private gazeAwayStart: number | null = null

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
    this.stopVideo()
    this.stopFaceDetection()
    this.ws?.close()
    this.ws = null
  }

  // --- Video capture (Task 5) ---

  async startVideo(videoEl: HTMLVideoElement): Promise<void> {
    this.videoStream = await navigator.mediaDevices.getUserMedia({
      video: { width: 640, height: 480, facingMode: 'user' },
      audio: false,
    })
    videoEl.srcObject = this.videoStream
    await videoEl.play()

    // Capture and send one JPEG frame per second
    const canvas = document.createElement('canvas')
    canvas.width = 320
    canvas.height = 240
    const ctx2d = canvas.getContext('2d')!
    this.videoInterval = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
      ctx2d.drawImage(videoEl, 0, 0, 320, 240)
      const jpeg = canvas.toDataURL('image/jpeg', 0.7).split(',')[1]
      this.ws.send(JSON.stringify({ type: 'video', data: jpeg }))
    }, 1000)
  }

  stopVideo(): void {
    if (this.videoInterval) clearInterval(this.videoInterval)
    this.videoStream?.getTracks().forEach((t) => t.stop())
    this.videoInterval = null
    this.videoStream = null
  }

  // --- Face detection / proctoring (Task 5) ---

  async startFaceDetection(
    videoEl: HTMLVideoElement,
    onFlag: (event: ProctoringEvent) => void,
  ): Promise<void> {
    const { initFaceLandmarker, extractGaze } = await import('./mediapipe')
    const landmarker = await initFaceLandmarker()

    const detect = () => {
      // Wait until video has actual dimensions
      if (!videoEl.videoWidth) {
        this.faceRafId = requestAnimationFrame(detect)
        return
      }

      const result = landmarker.detectForVideo(videoEl, Date.now())
      const { faceCount, yaw, pitch } = extractGaze(result)
      const ts = new Date().toISOString()

      if (faceCount === 0) {
        onFlag({ type: 'face_absent', ts })
      } else if (faceCount >= 2) {
        onFlag({ type: 'face_multiple', ts, count: faceCount })
      } else {
        // Gaze-away: sustained >3 s of |yaw| > 30° OR |pitch| > 30°
        const isLookingAway = Math.abs(yaw) > 30 || Math.abs(pitch) > 30
        if (isLookingAway) {
          if (!this.gazeAwayStart) this.gazeAwayStart = Date.now()
          const duration = (Date.now() - this.gazeAwayStart) / 1000
          if (duration > 3) {
            onFlag({ type: 'gaze_away', ts, duration, yaw, pitch })
          }
        } else {
          this.gazeAwayStart = null
        }
      }

      this.faceRafId = requestAnimationFrame(detect)
    }
    this.faceRafId = requestAnimationFrame(detect)
  }

  stopFaceDetection(): void {
    if (this.faceRafId) cancelAnimationFrame(this.faceRafId)
    this.faceRafId = null
    this.gazeAwayStart = null
  }
}
