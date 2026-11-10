// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PromptHistoryItem } from '../../hooks/usePromptHistory'
import { ChatInput } from './ChatInput'

const { authFetchMock, currentSessionMock, sttState, sendMessageMock, sttEngineKey } = vi.hoisted(() => ({
  authFetchMock: vi.fn(() => Promise.resolve({ ok: true })),
  currentSessionMock: {
    id: 's1',
    workdir: '/tmp',
    projectId: 'p1',
    messageCount: 0,
    pauseState: 'none' as const,
  },
  sttState: {
    status: 'idle' as 'idle' | 'loading' | 'listening' | 'transcribing',
    partialText: '',
    finalText: null as string | null,
    level: 0,
    speaking: false,
    progress: null as number | null,
    loadingModel: null as string | null,
    captureError: null,
    error: null as string | null,
    start: vi.fn(),
    stop: vi.fn(),
    reset: vi.fn(),
  },
  sendMessageMock: vi.fn(),
  sttEngineKey: 'stt.engine',
}))

vi.mock('../../lib/api', () => ({
  authFetch: authFetchMock,
}))

vi.mock('../../stores/session', () => ({
  useSessionStore: (selector: (state: unknown) => unknown) =>
    selector({
      currentSession: currentSessionMock,
      panes: {},
      focusedSessionId: null,
      stopGeneration: vi.fn(),
      pauseGeneration: vi.fn(),
      resumeGeneration: vi.fn(),
      cancelQueued: vi.fn(),
      queuedMessages: [],
      restoredInput: null,
      clearRestoredInput: vi.fn(),
    }),
  useIsRunning: () => false,
  useQueuedMessages: () => [],
}))

vi.mock('../../stores/stt', () => {
  const useSttStore = (selector: (s: unknown) => unknown) => selector(sttState)
  useSttStore.getState = () => sttState
  return { useSttStore }
})

vi.mock('../../hooks/useScrolledSend', () => ({
  useScrolledSend: () => ({ sendMessage: sendMessageMock, launchWorkflow: vi.fn() }),
}))

vi.mock('../../hooks/useSetting', () => ({
  useSetting: (key: string, fallback = '') => ({
    value: key === sttEngineKey ? 'vosk' : fallback,
    loading: false,
  }),
}))

vi.mock('../../hooks/useEffortGateContext', () => ({
  useEffortGateContext: () => ({
    sessionId: 's1',
    currentEffort: undefined,
    warmCache: false,
    gate: { requestEffortSwitch: vi.fn() },
  }),
  useEffortGatedAgentSwitch: () => vi.fn(),
}))

vi.mock('../../components/plan/EffortChangeGate', () => ({
  EffortChangeGateProvider: (props: { children?: unknown }) => <>{props.children}</>,
  useEffortChangeGate: () => ({ requestEffortSwitch: vi.fn() }),
}))

const setInputMock = vi.fn()

function renderChatInput(input = '') {
  return render(
    <ChatInput
      input={input}
      setInput={setInputMock}
      attachments={[]}
      setAttachments={vi.fn()}
      dragOver={false}
      setDragOver={vi.fn()}
      errorMessage={null}
      setErrorMessage={vi.fn()}
      scrollToBottom={vi.fn()}
      sessionId="s1"
      showHistory={false}
      history={[]}
      selectedIndex={0}
      openHistory={vi.fn()}
      closeHistory={vi.fn()}
      navigateUp={vi.fn()}
      navigateDown={vi.fn()}
      selectCurrent={vi.fn()}
      isAutoScrollActive={true}
      setAutoScroll={vi.fn()}
      onOpenMessageSearch={vi.fn()}
      onOpenCommandsModal={vi.fn()}
      onOpenWorkflowsModal={vi.fn()}
      onSelectWorkflow={vi.fn()}
      onSelectWorkflowWithSubGroup={vi.fn()}
      onSendCommand={vi.fn()}
      clearInput={vi.fn()}
    />,
  )
}

function resetSttState() {
  sttState.status = 'idle'
  sttState.partialText = ''
  sttState.finalText = null
  sttState.level = 0
  sttState.speaking = false
  sttState.progress = null
  sttState.loadingModel = null
  sttState.captureError = null
  sttState.error = null
}

describe('ChatInput dictation mic indicator', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    resetSttState()
  })

  it('shows a pulsing red dot on the mic icon while listening', () => {
    sttState.status = 'listening'
    renderChatInput()

    const dot = screen.getByTestId('chat-mic-recording-dot')
    const micBtn = screen.getByTestId('chat-mic-button')
    expect(dot).toBeInTheDocument()
    expect(dot.className).toContain('bg-accent-error')
    expect(dot.className).toContain('animate-pulse')
    expect(micBtn).toContainElement(dot)
    expect(screen.queryByTestId('chat-mic-spinner')).not.toBeInTheDocument()
  })

  it.each(['loading', 'transcribing'] as const)('shows a spinner on the mic icon while %s', (status) => {
    sttState.status = status
    renderChatInput()

    const spinner = screen.getByTestId('chat-mic-spinner')
    const micBtn = screen.getByTestId('chat-mic-button')
    expect(spinner).toBeInTheDocument()
    expect(spinner.className).toContain('animate-spin')
    expect(spinner.className).toContain('border-t-accent-error')
    expect(micBtn).toContainElement(spinner)
    expect(screen.queryByTestId('chat-mic-recording-dot')).not.toBeInTheDocument()
  })

  it('keeps the mic icon visible in every state', () => {
    for (const status of ['loading', 'listening', 'transcribing'] as const) {
      sttState.status = status
      renderChatInput()
      expect(screen.getByTestId('chat-mic-button').querySelector('svg')).not.toBeNull()
      cleanup()
    }
    renderChatInput()
    expect(screen.getByTestId('chat-mic-button').querySelector('svg')).not.toBeNull()
  })

  it('hides both indicators when the mic is idle', () => {
    renderChatInput()
    expect(screen.queryByTestId('chat-mic-recording-dot')).not.toBeInTheDocument()
    expect(screen.queryByTestId('chat-mic-spinner')).not.toBeInTheDocument()
  })
})

describe('ChatInput Enter while dictating', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    resetSttState()
  })

  it('sends the current text, clears the box and stops dictation', () => {
    sttState.status = 'listening'
    sttState.partialText = 'bonjour'
    const clearInputMock = vi.fn()
    render(
      <ChatInput
        input="bonjour le monde"
        setInput={setInputMock}
        attachments={[]}
        setAttachments={vi.fn()}
        dragOver={false}
        setDragOver={vi.fn()}
        errorMessage={null}
        setErrorMessage={vi.fn()}
        scrollToBottom={vi.fn()}
        sessionId="s1"
        showHistory={false}
        history={[]}
        selectedIndex={0}
        openHistory={vi.fn()}
        closeHistory={vi.fn()}
        navigateUp={vi.fn()}
        navigateDown={vi.fn()}
        selectCurrent={vi.fn()}
        isAutoScrollActive={true}
        setAutoScroll={vi.fn()}
        onOpenMessageSearch={vi.fn()}
        onOpenCommandsModal={vi.fn()}
        onOpenWorkflowsModal={vi.fn()}
        onSelectWorkflow={vi.fn()}
        onSelectWorkflowWithSubGroup={vi.fn()}
        onSendCommand={vi.fn()}
        clearInput={clearInputMock}
      />,
    )

    fireEvent.keyDown(screen.getByTestId('chat-input-textarea'), { key: 'Enter' })

    expect(sendMessageMock).toHaveBeenCalledWith('bonjour le monde', [])
    expect(clearInputMock).toHaveBeenCalled()
    expect(sttState.stop).toHaveBeenCalled()
  })

  it('does not re-insert the sent text when the final transcript arrives', () => {
    sttState.status = 'listening'
    const props = {
      input: 'bonjour le monde',
      setInput: setInputMock,
      attachments: [],
      setAttachments: vi.fn(),
      dragOver: false,
      setDragOver: vi.fn(),
      errorMessage: null,
      setErrorMessage: vi.fn(),
      scrollToBottom: vi.fn(),
      sessionId: 's1',
      showHistory: false,
      history: [] as PromptHistoryItem[],
      selectedIndex: 0,
      openHistory: vi.fn(),
      closeHistory: vi.fn(),
      navigateUp: vi.fn(),
      navigateDown: vi.fn(),
      selectCurrent: vi.fn(),
      isAutoScrollActive: true,
      setAutoScroll: vi.fn(),
      onOpenMessageSearch: vi.fn(),
      onOpenCommandsModal: vi.fn(),
      onOpenWorkflowsModal: vi.fn(),
      onSelectWorkflow: vi.fn(),
      onSelectWorkflowWithSubGroup: vi.fn(),
      onSendCommand: vi.fn(),
      clearInput: vi.fn(),
    }
    const { rerender } = render(<ChatInput {...props} />)

    fireEvent.keyDown(screen.getByTestId('chat-input-textarea'), { key: 'Enter' })

    sttState.finalText = 'bonjour le monde'
    rerender(<ChatInput {...props} />)

    const written = setInputMock.mock.calls.map((c) => c[0] as string)
    expect(written).not.toContain('bonjour le monde')
    expect(sttState.reset).toHaveBeenCalled()
  })

  it('does not touch dictation when idle', () => {
    renderChatInput('salut')
    fireEvent.keyDown(screen.getByTestId('chat-input-textarea'), { key: 'Enter' })
    expect(sendMessageMock).toHaveBeenCalledWith('salut', [])
    expect(sttState.stop).not.toHaveBeenCalled()
  })
})

describe('ChatInput stale discard flag reset', () => {
  afterEach(() => {
    cleanup()
    vi.clearAllMocks()
    resetSttState()
  })

  it('resets the discard flag on a new session so the next transcript is kept', () => {
    const props = {
      input: 'bonjour',
      setInput: setInputMock,
      attachments: [],
      setAttachments: vi.fn(),
      dragOver: false,
      setDragOver: vi.fn(),
      errorMessage: null,
      setErrorMessage: vi.fn(),
      scrollToBottom: vi.fn(),
      sessionId: 's1',
      showHistory: false,
      history: [] as PromptHistoryItem[],
      selectedIndex: 0,
      openHistory: vi.fn(),
      closeHistory: vi.fn(),
      navigateUp: vi.fn(),
      navigateDown: vi.fn(),
      selectCurrent: vi.fn(),
      isAutoScrollActive: true,
      setAutoScroll: vi.fn(),
      onOpenMessageSearch: vi.fn(),
      onOpenCommandsModal: vi.fn(),
      onOpenWorkflowsModal: vi.fn(),
      onSelectWorkflow: vi.fn(),
      onSelectWorkflowWithSubGroup: vi.fn(),
      onSendCommand: vi.fn(),
      clearInput: vi.fn(),
    }
    sttState.status = 'loading'
    const { rerender } = render(<ChatInput {...props} />)
    fireEvent.keyDown(screen.getByTestId('chat-input-textarea'), { key: 'Enter' })

    resetSttState()
    setInputMock.mockClear()
    const fresh = { ...props, input: '' }
    rerender(<ChatInput {...fresh} />)
    fireEvent.click(screen.getByTestId('chat-mic-button'))
    sttState.status = 'listening'
    sttState.partialText = 'texte dicté'
    rerender(<ChatInput {...fresh} />)

    fireEvent.click(screen.getByTestId('chat-mic-button'))
    sttState.status = 'transcribing'
    sttState.finalText = 'texte dicté'
    rerender(<ChatInput {...fresh} />)

    const written = setInputMock.mock.calls.map((c) => c[0] as string)
    expect(written).toContain('texte dicté')
  })
})
