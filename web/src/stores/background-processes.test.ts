// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useBackgroundProcessesStore } from './background-processes'

vi.mock('../lib/api', () => ({
  authFetch: vi.fn(),
}))

describe('useBackgroundProcessesStore', () => {
  beforeEach(() => {
    useBackgroundProcessesStore.setState({ processes: [], logs: {} })
  })

  describe('appendLog', () => {
    it('caps per-process logs to a bounded buffer so memory stays finite', async () => {
      for (let i = 0; i < 2500; i++) {
        useBackgroundProcessesStore.getState().appendLog('proc-1', 'stdout', `line-${i}`)
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

      const logs = useBackgroundProcessesStore.getState().logs['proc-1'] ?? []
      expect(logs).toHaveLength(2000)
      expect(logs[0]?.content).toBe('line-500')
      expect(logs.at(-1)?.content).toBe('line-2499')

      for (let i = 0; i < 2500; i++) {
        useBackgroundProcessesStore.getState().appendLog('proc-1', 'stdout', `line-${2500 + i}`)
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

      const capped = useBackgroundProcessesStore.getState().logs['proc-1'] ?? []
      expect(capped).toHaveLength(2000)
      expect(capped[0]?.content).toBe('line-3000')
      expect(capped[0]?.offset).toBe(3000)
      expect(capped.at(-1)?.content).toBe('line-4999')
      expect(capped.at(-1)?.offset).toBe(4999)
      for (let i = 1; i < capped.length; i++) {
        const prev = capped[i - 1]
        const curr = capped[i]
        if (prev && curr) {
          expect(curr.offset).toBeGreaterThan(prev.offset)
        }
      }
    })
  })

  describe('handleMessage backgroundProcess.started', () => {
    it('registers the process with its launch command and working directory', () => {
      useBackgroundProcessesStore.getState().handleMessage('backgroundProcess.started', {
        processId: 'proc-1',
        name: 'dev-server',
        command: 'npm run dev',
        cwd: '/project',
        pid: 4321,
        status: 'running',
      })

      const processes = useBackgroundProcessesStore.getState().processes
      expect(processes).toHaveLength(1)
      expect(processes[0]).toMatchObject({
        id: 'proc-1',
        name: 'dev-server',
        command: 'npm run dev',
        cwd: '/project',
        pid: 4321,
        status: 'running',
      })
    })
  })
})
