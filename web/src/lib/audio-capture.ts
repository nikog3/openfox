const TARGET_RATE = 16000
const BUFFER_SIZE = 4096

export type CaptureErrorCode = 'denied' | 'not-found' | 'in-use' | 'unsupported' | 'unknown'

export class CaptureError extends Error {
  constructor(
    message: string,
    public readonly code: CaptureErrorCode,
  ) {
    super(message)
    this.name = 'CaptureError'
  }
}

function mapCaptureError(err: unknown): CaptureError {
  const name = err instanceof DOMException ? err.name : ''
  const code: CaptureErrorCode =
    name === 'NotAllowedError' || name === 'SecurityError'
      ? 'denied'
      : name === 'NotFoundError' || name === 'OverconstrainedError'
        ? 'not-found'
        : name === 'NotReadableError' || name === 'AbortError'
          ? 'in-use'
          : 'unknown'
  return new CaptureError(err instanceof Error ? err.message : String(err), code)
}

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
    throw new CaptureError('getUserMedia not supported in this context', 'unsupported')
  }

  let stream: MediaStream
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    })
  } catch (err) {
    throw mapCaptureError(err)
  }

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

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 8192
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}
