import assert from 'node:assert/strict'
import test from 'node:test'
import { ROOT_CONTEXT, trace, type SpanContext, type SpanOptions } from '@opentelemetry/api'
import { resolveConfig } from '../src/config.ts'
import { TraceAdapter } from '../src/adapter.ts'

class RecordingSpan {
  readonly name: string
  readonly spanId: string
  readonly attributes: Record<string, unknown>
  readonly events: Array<{ name: string; attributes?: Record<string, unknown> }> = []
  readonly parent?: SpanContext
  readonly links: SpanOptions['links']
  endedAt?: number
  status?: { code: number }
  recording = true

  constructor(name: string, options: SpanOptions, spanId: string, parent?: SpanContext) {
    this.name = name
    this.spanId = spanId
    this.attributes = { ...options.attributes }
    this.parent = parent
    this.links = options.links
  }

  spanContext(): SpanContext {
    return {
      traceId: this.parent?.traceId ?? this.spanId.padStart(32, '0'),
      spanId: this.spanId.padStart(16, '0'),
      traceFlags: 1,
    }
  }

  setAttribute(key: string, value: unknown) { this.attributes[key] = value; return this }
  setStatus(status: { code: number }) { this.status = status; return this }
  addEvent(name: string, attributes?: Record<string, unknown>) { this.events.push({ name, attributes }); return this }
  end(endTime?: number) { this.endedAt = endTime; this.recording = false }
  isRecording() { return this.recording }
}

class RecordingTracer {
  readonly spans: RecordingSpan[] = []
  getTracer() { return this }

  startSpan(name: string, options: SpanOptions = {}, context = ROOT_CONTEXT) {
    const parent = trace.getSpanContext(context)
    const span = new RecordingSpan(name, options, String(this.spans.length + 1), parent)
    this.spans.push(span)
    return span
  }
}

function event(type: string, data: Record<string, any>, time: number) {
  return { type, data, time }
}

function session(id: string, parentSession?: string) {
  const messages: Array<{ id: string; role: string; content: any[] }> = []
  return {
    id,
    header: { agentPreset: id, ...(parentSession ? { parentSession } : {}) },
    deriveMessages: () => messages,
    messages,
  }
}

test('correlates retries and multiple tool calls under one turn root', () => {
  const tracer = new RecordingTracer()
  const adapter = new TraceAdapter(tracer as any, resolveConfig({ enabled: true }, {}))
  const current = session('agent-1')
  adapter.onSessionEvent(current as any, event('turn/start', { turn: 1 }, 1_000) as any)
  adapter.onSessionEvent(current as any, event('request/context', { provider: 'deepseek', model: 'deepseek-chat' }, 1_010) as any)
  adapter.onSessionEvent(current as any, event('step/start', { turn: 1, step: 1 }, 1_020) as any)

  adapter.onAssistantStream({ agent: { session: current, options: { provider: 'deepseek', model: 'deepseek-chat' } } as any,
    frame: { type: 'start', attemptId: 'attempt-1', turn: 1, step: 1 } as any })
  adapter.onAssistantStream({ agent: { session: current } as any,
    frame: { type: 'chunk', attemptId: 'attempt-1', turn: 1, step: 1, time: 1_040, chunk: { type: 'text-delta', text: 'retrying' } } as any })
  adapter.onSessionEvent(current as any, event('assistant/attempt', { turn: 1, step: 1, stream: [] }, 1_050) as any)

  adapter.onAssistantStream({ agent: { session: current } as any,
    frame: { type: 'start', attemptId: 'attempt-2', turn: 1, step: 1 } as any })
  adapter.onSessionEvent(current as any, event('assistant/message', {
    turn: 1, step: 1, message: {
      id: 'm1', role: 'assistant', source: { kind: 'model', provider: 'deepseek', model: 'deepseek-chat' },
      content: [{ type: 'text', text: 'done' }],
    },
    usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
    stream: [{ type: 'chunk', time: 1_090, chunk: { type: 'finish', reason: { kind: 'tool-calls' } } }],
  }, 1_100) as any)

  adapter.onSessionEvent(current as any, event('tool/call', { turn: 1, step: 1, callId: 'tool-a', name: 'read', arguments: '{}' }, 1_110) as any)
  adapter.onSessionEvent(current as any, event('tool/call', { turn: 1, step: 1, callId: 'tool-b', name: 'write', arguments: '{}' }, 1_120) as any)
  adapter.onSessionEvent(current as any, event('tool/result', { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'tool-a' }] } }, 1_130) as any)
  adapter.onSessionEvent(current as any, event('tool/result', { turn: 1, step: 1, message: { content: [{ type: 'tool-result', toolCallId: 'tool-b' }] } }, 1_140) as any)
  adapter.onSessionEvent(current as any, event('step/end', { turn: 1, step: 1 }, 1_150) as any)
  adapter.onSessionEvent(current as any, event('turn/end', { turn: 1, reason: { kind: 'success' } }, 1_160) as any)

  const root = tracer.spans.find(span => span.name.startsWith('invoke_agent'))!
  const chats = tracer.spans.filter(span => span.name.startsWith('chat'))
  const tools = tracer.spans.filter(span => span.name.startsWith('execute_tool'))
  assert.equal(chats.length, 2)
  assert.equal(tools.length, 2)
  assert.ok(chats.every(span => span.parent?.spanId === root.spanContext().spanId))
  assert.ok(tools.every(span => span.parent?.spanId === chats[1].spanContext().spanId))
  assert.ok(chats.every(span => span.endedAt !== undefined))
  assert.equal(chats[1].attributes['gen_ai.usage.input_tokens'], 3)
  assert.equal(chats[1].attributes['gen_ai.response.model'], 'deepseek-chat')
  assert.deepEqual(chats[1].attributes['gen_ai.response.finish_reasons'], ['tool_calls'])
  assert.equal(root.endedAt, 1_160)
})

test('closes abandoned stream attempts as cancelled', () => {
  const tracer = new RecordingTracer()
  const adapter = new TraceAdapter(tracer as any, resolveConfig({ enabled: true }, {}))
  const current = session('agent-cancel')
  adapter.onAssistantStream({ agent: { session: current } as any,
    frame: { type: 'start', attemptId: 'attempt-cancel', turn: 1, step: 1 } as any })
  adapter.onAssistantStream({ agent: { session: current } as any,
    frame: { type: 'end', attemptId: 'attempt-cancel', turn: 1, step: 1, outcome: { kind: 'abandoned' } } as any })
  const chat = tracer.spans.find(span => span.name.startsWith('chat'))!
  assert.equal(chat.attributes['error.type'], 'cancelled')
  assert.deepEqual(chat.attributes['gen_ai.response.finish_reasons'], ['cancelled'])
  assert.ok(chat.endedAt)
})

test('links child agent roots to a known parent session span', () => {
  const tracer = new RecordingTracer()
  const adapter = new TraceAdapter(tracer as any, resolveConfig({ enabled: true }, {}))
  const parent = session('parent')
  const child = session('child', 'parent')
  adapter.onSessionEvent(parent as any, event('turn/start', { turn: 1 }, 1_000) as any)
  adapter.onSessionEvent(child as any, event('turn/start', { turn: 1 }, 1_010) as any)
  const childRoot = tracer.spans.find(span => span.name.includes('child'))!
  assert.equal(childRoot.links?.[0]?.context.spanId, tracer.spans[0].spanContext().spanId)
  assert.equal(childRoot.parent, undefined)
})
