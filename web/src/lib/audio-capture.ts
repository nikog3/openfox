const TARGET_RATE = 16000
const BUFFER_SIZE = 4096

export class Resampler {
  private ratio: number
  private pos = 0

  constructor(fromRate: number) {
    this.ratio = fromRate / TARGET_RATE
  }

  process(input: Float32Array): Int16Array {
    const out: number[] = []
    const n = input.length
    while (this.pos < n) {
      const i = Math.floor(this.pos)
      const frac = this.pos - i
      const s0 = input[i] ?? 0
      const s1 = i + 1 < n ? (input[i + 1] ?? s0) : s0
      const v = s0 * (1 - frac) + s1 * frac
      out.push(clamp16(v))
      this.pos += this.ratio
    }
    this.pos -= n
    return new Int16Array(out)
  }
}

function clamp16(v: number): number {
  if (v <= -1) return -32768
  if (v >= 1) return 32767
  return Math.round(v * 32767)
}

export interface AudioCaptureHandle {
  stop(): void
}

export async function startAudioCapture(onChunk: (samples: Int16Array) => void): Promise<AudioCaptureHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia not supported in this context')
  }

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  })

  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(stream)
  const resampler = new Resampler(ctx.sampleRate)

  const processor = ctx.createScriptProcessor(BUFFER_SIZE, 1, 1)

  processor.onaudioprocess = (event) => {
    const input = event.inputBuffer.getChannelData(0)
    const samples = resampler.process(input)
    if (samples.length > 0) {
      onChunk(samples)
    }
  }

  source.connect(processor)
  processor.connect(ctx.destination)

  return {
    stop() {
      try {
        processor.disconnect()
        source.disconnect()
        stream.getTracks().forEach((track) => track.stop())
      } finally {
        void ctx.close()
      }
    },
  }
}
