// AudioWorklet processor: buffers Float32 audio and posts 2048-sample chunks
// Must be a plain JS file in /public/ — AudioWorklet cannot load bundled modules.
class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buffer = new Float32Array(2048)
    this._offset = 0
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0]) return true
    const channel = input[0]

    for (let i = 0; i < channel.length; i++) {
      this._buffer[this._offset++] = channel[i]
      if (this._offset >= 2048) {
        // Clone buffer so we don't race
        this.port.postMessage(this._buffer.slice())
        this._offset = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-processor', PCMProcessor)
