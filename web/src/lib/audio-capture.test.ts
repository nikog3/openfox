import { describe, it, expect } from 'vitest'
import { Resampler } from './audio-capture'

describe('Resampler', () => {
  it('resamples 48kHz input to 16kHz output (ratio 3)', () => {
    const resampler = new Resampler(48000)
    const input = new Float32Array(480)
    for (let i = 0; i < 480; i++) {
      input[i] = Math.sin((2 * Math.PI * 440 * i) / 48000)
    }
    const output = resampler.process(input)
    expect(output.length).toBe(160)
  })

  it('resamples 44100Hz input to 16kHz output', () => {
    const resampler = new Resampler(44100)
    const input = new Float32Array(441)
    for (let i = 0; i < 441; i++) {
      input[i] = 0.5
    }
    const output = resampler.process(input)
    expect(output.length).toBe(160)
  })

  it('resamples 16kHz input to 16kHz output (ratio 1, passthrough)', () => {
    const resampler = new Resampler(16000)
    const input = new Float32Array([0.5, -0.5, 1.0, -1.0, 0.0])
    const output = resampler.process(input)
    expect(output.length).toBe(5)
    expect(output[0]).toBe(Math.round(0.5 * 32767))
    expect(output[1]).toBe(Math.round(-0.5 * 32767))
    expect(output[2]).toBe(32767)
    expect(output[3]).toBe(-32768)
    expect(output[4]).toBe(0)
  })

  it('clamps values above 1.0 to 32767', () => {
    const resampler = new Resampler(16000)
    const input = new Float32Array([1.5])
    const output = resampler.process(input)
    expect(output[0]).toBe(32767)
  })

  it('clamps values below -1.0 to -32768', () => {
    const resampler = new Resampler(16000)
    const input = new Float32Array([-1.5])
    const output = resampler.process(input)
    expect(output[0]).toBe(-32768)
  })

  it('handles fractional positions across multiple process calls', () => {
    const resampler = new Resampler(48000)
    const input1 = new Float32Array(100).fill(0.5)
    const out1 = resampler.process(input1)
    expect(out1.length).toBe(34)

    const input2 = new Float32Array(100).fill(0.5)
    const out2 = resampler.process(input2)
    expect(out2.length).toBe(33)
  })

  it('produces zero-length output for empty input', () => {
    const resampler = new Resampler(48000)
    const output = resampler.process(new Float32Array(0))
    expect(output.length).toBe(0)
  })

  it('linearly interpolates between samples', () => {
    const resampler = new Resampler(24000)
    const input = new Float32Array([0.0, 1.0, 0.0, 1.0])
    const output = resampler.process(input)
    expect(output.length).toBe(3)
    expect(output[0]).toBe(0)
    expect(output[1]).toBe(16384)
    expect(output[2]).toBe(32767)
  })
})
