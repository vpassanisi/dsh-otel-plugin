import {
  ROOT_CONTEXT,
  SpanStatusCode,
  trace,
  type Context as OtelContext,
  type Span,
  type SpanContext,
  type Tracer,
} from '@opentelemetry/api'
import type { ResolvedConfig } from './config.ts'
import { capturedMessages, capturedToolArguments } from './privacy.ts'

type SessionId = string
type Session = {
  id: SessionId
  header?: { parentSession?: SessionId; agentPreset?: string }
  requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined
  deriveMessages?: () => Array<{ id?: string; role?: string; content?: unknown[] }>
}

type DurableEvent = {
  type: string
  time: number
  seq?: number
  data: Record<string, any>
}

type AssistantStreamFrame = {
  type: 'start' | 'chunk' | 'end'
  attemptId: string
  turn: number
  step: number
  time?: number
  chunk?: { type?: string; text?: string; argumentsDelta?: string; name?: string }
  outcome?: { kind: 'committed' | 'abandoned'; eventType?: string; seq?: number }
}

type Agent = {
  id?: string
  options?: { provider?: string; model?: string }
  session: Session
}

type ChatSpan = {
  span: Span
  context: SpanContext
  attemptId?: string
  turn: number
  step: number
  startedAt: number
  firstChunkAt?: number
}

type ToolSpan = {
  span: Span
  turn: number
  step: number
}

type SessionState = {
  session: Session
  turn?: number
  step?: number
  root?: Span
  chatByAttempt: Map<string, ChatSpan>
  chatQueueByStep: Map<string, ChatSpan[]>
  lastChatByStep: Map<string, ChatSpan>
  tools: Map<string, ToolSpan>
  provider?: string
  model?: string
}

function stateKey(session: SessionId, turn: number, step: number): string {
  return `${session}\u0000${turn}\u0000${step}`
}

function time(value?: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : Date.now()
}

function firstStreamTime(stream: any[] | undefined): number | undefined {
  if (!stream) return undefined
  const times = stream.flatMap(record => {
    if (record?.type === 'chunk' && typeof record.time === 'number') return [record.time]
    if (typeof record?.time0 === 'number') return [record.time0]
    return []
  })
  return times.length ? Math.min(...times) : undefined
}

function finishReason(stream: any[] | undefined, interrupted?: boolean): string | undefined {
  if (interrupted) return 'cancelled'
  for (let i = (stream?.length ?? 0) - 1; i >= 0; i -= 1) {
    const record = stream![i]
    const chunk = record?.type === 'chunk' ? record.chunk : undefined
    if (chunk?.type === 'finish' && chunk.reason?.kind) {
      switch (chunk.reason.kind) {
        case 'tool-calls': return 'tool_calls'
        case 'max-tokens': return 'max_tokens'
        case 'aborted': return 'cancelled'
        default: return String(chunk.reason.kind)
      }
    }
  }
  return undefined
}

function finishErrorType(stream: any[] | undefined): string | undefined {
  for (let i = (stream?.length ?? 0) - 1; i >= 0; i -= 1) {
    const record = stream![i]
    const failure = record?.type === 'chunk' && record.chunk?.type === 'finish'
      ? record.chunk.reason?.failure
      : undefined
    if (failure) return String(failure.code ?? failure.name ?? 'model_error')
  }
  return undefined
}

function hasFirstToken(chunk: AssistantStreamFrame['chunk']): boolean {
  if (!chunk) return false
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return Boolean(chunk.text?.trim())
  if (chunk.type === 'tool-call-delta') return Boolean(chunk.name || chunk.argumentsDelta)
  return false
}

function currentPromptMessages(session: Session, settledMessageId?: string): Array<{ id?: string; role?: string; content?: unknown[] }> {
  return (session.deriveMessages?.() ?? []).filter(message => message.id !== settledMessageId)
}

export class TraceAdapter {
  private readonly sessions = new Map<SessionId, SessionState>()
  private readonly latestRootBySession = new Map<SessionId, SpanContext>()
  private closed = false
  private readonly tracer: Tracer
  private readonly config: ResolvedConfig

  constructor(tracer: Tracer, config: ResolvedConfig) {
    this.tracer = tracer
    this.config = config
  }

  onSessionEvent(session: Session, event: DurableEvent): void {
    if (this.closed) return
    const state = this.getState(session)
    switch (event.type) {
      case 'turn/start':
        this.startTurn(state, event)
        break
      case 'turn/end':
        this.endTurn(state, event)
        break
      case 'step/start':
        state.turn = event.data.turn
        state.step = event.data.step
        if (!state.root) this.startTurn(state, { ...event, type: 'turn/start', data: { turn: event.data.turn } })
        break
      case 'step/end':
        this.endStep(state, event)
        break
      case 'request/header':
        state.provider = event.data.header?.config?.provider ?? state.provider
        state.model = event.data.header?.config?.model ?? state.model
        break
      case 'request/context':
        state.provider = event.data.provider ?? state.provider
        state.model = event.data.model ?? state.model
        break
      case 'assistant/message':
        this.endChatFromEvent(state, event, false)
        break
      case 'assistant/attempt':
        this.endChatFromEvent(state, event, true)
        break
      case 'tool/call':
        this.startTool(state, event)
        break
      case 'tool/result':
        this.endTool(state, event)
        break
      default:
        break
    }
  }

  onAssistantStream(payload: { agent: Agent; frame: AssistantStreamFrame }): void {
    if (this.closed) return
    const { agent, frame } = payload
    const state = this.getState(agent.session)
    state.provider = agent.options?.provider ?? state.provider
    state.model = agent.options?.model ?? state.model
    if (frame.type === 'start') {
      if (!state.root) this.startTurn(state, { type: 'turn/start', time: Date.now(), data: { turn: frame.turn } })
      const key = stateKey(agent.session.id, frame.turn, frame.step)
      const span = this.tracer.startSpan(
        state.model ? `chat ${state.model}` : 'chat',
        {
          startTime: Date.now(),
          attributes: this.chatAttributes(state, frame.turn, frame.step),
        },
        this.parentContext(state),
      )
      const chat: ChatSpan = {
        span,
        context: span.spanContext(),
        attemptId: frame.attemptId,
        turn: frame.turn,
        step: frame.step,
        startedAt: Date.now(),
      }
      state.chatByAttempt.set(frame.attemptId, chat)
      state.lastChatByStep.set(key, chat)
      const queue = state.chatQueueByStep.get(key) ?? []
      queue.push(chat)
      state.chatQueueByStep.set(key, queue)
    } else if (frame.type === 'chunk') {
      const chat = state.chatByAttempt.get(frame.attemptId)
      if (chat && !chat.firstChunkAt && hasFirstToken(frame.chunk)) {
        chat.firstChunkAt = time(frame.time)
        chat.span.addEvent('gen_ai.stream.first_chunk', {
          'dsh.stream.first_chunk_ms': Math.max(0, chat.firstChunkAt - chat.startedAt),
        }, chat.firstChunkAt)
      }
    } else if (frame.type === 'end' && frame.outcome?.kind === 'abandoned') {
      const chat = state.chatByAttempt.get(frame.attemptId)
      if (chat) {
        chat.span.setAttribute('gen_ai.response.finish_reasons', ['cancelled'])
        chat.span.setAttribute('error.type', 'cancelled')
        this.finishChat(state, chat, Date.now())
      }
    }
  }

  onSessionDisposed(session: Session): void {
    const state = this.sessions.get(session.id)
    if (!state) return
    const now = Date.now()
    for (const chat of state.chatByAttempt.values()) this.finishChat(state, chat, now)
    for (const chat of state.chatQueueByStep.values()) {
      for (const item of chat) this.finishChat(state, item, now)
    }
    for (const tool of state.tools.values()) this.finishTool(state, tool, now, 'cancelled')
    state.root?.end(now)
    this.sessions.delete(session.id)
    this.latestRootBySession.delete(session.id)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const state of this.sessions.values()) this.onSessionDisposed(state.session)
    this.sessions.clear()
  }

  private getState(session: Session): SessionState {
    let state = this.sessions.get(session.id)
    if (!state) {
      state = {
        session,
        chatByAttempt: new Map(),
        chatQueueByStep: new Map(),
        lastChatByStep: new Map(),
        tools: new Map(),
        provider: session.requestHeader?.()?.config?.provider,
        model: session.requestHeader?.()?.config?.model,
      }
      this.sessions.set(session.id, state)
    } else {
      state.session = session
    }
    return state
  }

  private parentContext(state: SessionState): OtelContext {
    return state.root ? trace.setSpanContext(ROOT_CONTEXT, state.root.spanContext()) : ROOT_CONTEXT
  }

  private startTurn(state: SessionState, event: DurableEvent): void {
    if (state.root) {
      this.closeTurnChildren(state, state.turn ?? 0, event.time)
      state.root.end(time(event.time))
    }
    const turn = event.data.turn ?? 0
    state.turn = turn
    const parentId = state.session.header?.parentSession
    const parent = parentId ? this.latestRootBySession.get(parentId) : undefined
    const agentName = state.session.header?.agentPreset
    const span = this.tracer.startSpan(
      agentName ? `invoke_agent ${agentName}` : 'invoke_agent',
      {
        startTime: time(event.time),
        attributes: {
          'gen_ai.operation.name': 'invoke_agent',
          'gen_ai.conversation.id': state.session.id,
          'gen_ai.agent.id': state.session.id,
          'dsh.turn': turn,
          ...(agentName ? { 'gen_ai.agent.name': agentName } : {}),
        },
        ...(parent ? { links: [{ context: parent }] } : {}),
      },
      ROOT_CONTEXT,
    )
    state.root = span
    this.latestRootBySession.set(state.session.id, span.spanContext())
  }

  private endTurn(state: SessionState, event: DurableEvent): void {
    const turn = event.data.turn
    this.closeTurnChildren(state, turn, event.time)
    if (state.root && state.turn === turn) {
      const reason = event.data.reason
      if (reason?.kind === 'error') {
        state.root.setAttribute('error.type', reason.error?.code ?? reason.error?.name ?? 'turn_error')
        state.root.setStatus({ code: SpanStatusCode.ERROR })
      } else if (reason?.kind === 'aborted' || reason?.kind === 'interrupted') {
        state.root.setAttribute('gen_ai.response.finish_reasons', [reason.kind === 'aborted' ? 'cancelled' : 'interrupted'])
      } else if (reason?.kind === 'max-tokens') {
        state.root.setAttribute('gen_ai.response.finish_reasons', ['max_tokens'])
      }
      state.root.end(time(event.time))
      state.root = undefined
    }
  }

  private endStep(state: SessionState, event: DurableEvent): void {
    const turn = event.data.turn
    const step = event.data.step
    const key = stateKey(state.session.id, turn, step)
    const queue = state.chatQueueByStep.get(key) ?? []
    for (const chat of [...queue]) this.finishChat(state, chat, event.time)
    for (const tool of [...state.tools.values()]) {
      if (tool.turn === turn && tool.step === step) this.finishTool(state, tool, event.time, 'cancelled')
    }
    state.lastChatByStep.delete(key)
    state.step = undefined
  }

  private closeTurnChildren(state: SessionState, turn: number, at: number): void {
    for (const [key, chats] of state.chatQueueByStep) {
      for (const chat of [...chats]) if (chat.turn === turn) this.finishChat(state, chat, at)
      if (key.startsWith(`${state.session.id}\u0000${turn}\u0000`)) state.lastChatByStep.delete(key)
    }
    for (const tool of [...state.tools.values()]) {
      if (tool.turn === turn) this.finishTool(state, tool, at, 'cancelled')
    }
  }

  private chatAttributes(state: SessionState, turn = state.turn, step = state.step): Record<string, string | number> {
    return {
      'gen_ai.operation.name': 'chat',
      ...(state.provider ? { 'gen_ai.provider.name': state.provider } : {}),
      ...(state.model ? { 'gen_ai.request.model': state.model } : {}),
      'gen_ai.conversation.id': state.session.id,
      ...(turn !== undefined ? { 'dsh.turn': turn } : {}),
      ...(step !== undefined ? { 'dsh.step': step } : {}),
    }
  }

  private endChatFromEvent(state: SessionState, event: DurableEvent, failedAttempt: boolean): void {
    const data = event.data
    const key = stateKey(state.session.id, data.turn, data.step)
    const queue = state.chatQueueByStep.get(key) ?? []
    const chat = queue[0] ?? this.createSettledChat(state, event)
    const reason = finishReason(data.stream, data.interrupted)
    if (reason) chat.span.setAttribute('gen_ai.response.finish_reasons', [reason])
    const responseModel = data.message?.source?.model
    if (responseModel) chat.span.setAttribute('gen_ai.response.model', responseModel)
    if (data.usage) {
      chat.span.setAttribute('gen_ai.usage.input_tokens', data.usage.inputTokens)
      chat.span.setAttribute('gen_ai.usage.output_tokens', data.usage.outputTokens)
      if (data.usage.totalTokens !== undefined) chat.span.setAttribute('gen_ai.usage.total_tokens', data.usage.totalTokens)
      if (data.usage.cacheReadTokens !== undefined) chat.span.setAttribute('gen_ai.usage.cache_read.input_tokens', data.usage.cacheReadTokens)
      if (data.usage.cacheWriteTokens !== undefined) chat.span.setAttribute('gen_ai.usage.cache_write.input_tokens', data.usage.cacheWriteTokens)
    }

    if (this.config.capturePrompts) {
      const prompt = capturedMessages(currentPromptMessages(state.session, data.message?.id), this.config)
      if (prompt) chat.span.setAttribute('gen_ai.input.messages', prompt)
    }
    if (!failedAttempt && this.config.captureResponses && data.message?.content) {
      const response = capturedMessages([data.message], this.config)
      if (response) chat.span.setAttribute('gen_ai.output.messages', response)
    }

    if (failedAttempt) {
      if (reason === 'cancelled') {
        chat.span.setAttribute('error.type', 'cancelled')
      } else {
        chat.span.setAttribute('error.type', finishErrorType(data.stream) ?? 'model_attempt_failed')
        chat.span.setStatus({ code: SpanStatusCode.ERROR })
      }
    } else if (data.interrupted) {
      chat.span.setAttribute('error.type', 'cancelled')
    }
    this.finishChat(state, chat, event.time)
  }

  private createSettledChat(state: SessionState, event: DurableEvent): ChatSpan {
    const data = event.data
    const startedAt = firstStreamTime(data.stream) ?? event.time
    const span = this.tracer.startSpan(
      state.model ? `chat ${state.model}` : 'chat',
      { startTime: startedAt, attributes: this.chatAttributes(state, data.turn, data.step) },
      this.parentContext(state),
    )
    const chat: ChatSpan = {
      span,
      context: span.spanContext(),
      turn: data.turn,
      step: data.step,
      startedAt,
    }
    const key = stateKey(state.session.id, data.turn, data.step)
    const queue = state.chatQueueByStep.get(key) ?? []
    queue.push(chat)
    state.chatQueueByStep.set(key, queue)
    state.lastChatByStep.set(key, chat)
    return chat
  }

  private finishChat(state: SessionState, chat: ChatSpan, at: number): void {
    if (!chat.span.isRecording()) return
    chat.span.end(time(at))
    if (chat.attemptId) state.chatByAttempt.delete(chat.attemptId)
    const key = stateKey(state.session.id, chat.turn, chat.step)
    const queue = state.chatQueueByStep.get(key)
    if (queue) {
      const index = queue.indexOf(chat)
      if (index >= 0) queue.splice(index, 1)
      if (queue.length === 0) state.chatQueueByStep.delete(key)
    }
  }

  private startTool(state: SessionState, event: DurableEvent): void {
    const data = event.data
    const callId = String(data.callId)
    const parentChat = state.lastChatByStep.get(stateKey(state.session.id, data.turn, data.step))
    const span = this.tracer.startSpan(
      `execute_tool ${data.name}`,
      {
        startTime: time(event.time),
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': String(data.name),
          'gen_ai.tool.call.id': callId,
          'gen_ai.conversation.id': state.session.id,
          'dsh.turn': data.turn,
          'dsh.step': data.step,
          ...(this.config.captureToolArguments
            ? { 'gen_ai.tool.call.arguments': capturedToolArguments(String(data.arguments ?? ''), this.config) }
            : {}),
        },
      },
      parentChat ? trace.setSpanContext(ROOT_CONTEXT, parentChat.context) : this.parentContext(state),
    )
    state.tools.set(callId, { span, turn: data.turn, step: data.step })
  }

  private endTool(state: SessionState, event: DurableEvent): void {
    const content = event.data.message?.content?.[0]
    const callId = String(content?.toolCallId ?? '')
    const tool = state.tools.get(callId)
    if (!tool) return
    if (content?.isError || event.data.error) {
      tool.span.setAttribute('error.type', event.data.error?.code ?? 'tool_error')
      tool.span.setStatus({ code: SpanStatusCode.ERROR })
    }
    this.finishTool(state, tool, event.time)
    state.tools.delete(callId)
  }

  private finishTool(state: SessionState, tool: ToolSpan, at: number, error?: string): void {
    if (!tool.span.isRecording()) return
    if (error) {
      tool.span.setAttribute('error.type', error)
      tool.span.setStatus({ code: SpanStatusCode.ERROR })
    }
    tool.span.end(time(at))
    for (const [id, value] of state.tools) if (value === tool) state.tools.delete(id)
  }
}
