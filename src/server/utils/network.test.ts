import { describe, it, expect } from 'vitest'
import { displayHost } from './network.js'

describe('displayHost', () => {
  it('maps 0.0.0.0 to localhost', () => {
    expect(displayHost('0.0.0.0')).toBe('localhost')
  })

  it('maps :: to localhost', () => {
    expect(displayHost('::')).toBe('localhost')
  })

  it('maps * to localhost', () => {
    expect(displayHost('*')).toBe('localhost')
  })

  it('keeps 127.0.0.1 unchanged', () => {
    expect(displayHost('127.0.0.1')).toBe('127.0.0.1')
  })

  it('keeps explicit LAN IPs unchanged', () => {
    expect(displayHost('192.168.1.42')).toBe('192.168.1.42')
  })

  it('keeps hostnames unchanged', () => {
    expect(displayHost('myhost.local')).toBe('myhost.local')
  })
})
