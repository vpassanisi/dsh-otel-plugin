import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BatchSpanProcessor,
  InMemorySpanExporter,
  TracerProvider,
} from '@opentelemetry/sdk-trace'
import { resolveConfig } from '../src/config.ts'
import { TraceAdapter } from '../src/adapter.ts'

function event(type: string, data: Record<string, any>, time: number) {
  return { type, data, time }
}

function testSession() {
  return { id: 'export-session', header: { agentPreset: 'sdk' } }
}

test('exports invoke_agent, chat, and execute_tool with parent IDs', async () => {
  const exporter = new InMemorySpanExporter()
  const provider = new TracerProvider({
    spanProcessors: [new BatchSpanProcessor({ exporter, scheduledDelayMillis: 10 })],
  })
  const adapter = new TraceAdapter(provider.getTracer('export-test'), resolveConfig({ enabled: true }, {}))
  const session = testSession()

  adapter.onSessionEvent(session as any, event('turn/start', { turn: 2 }, 2_000) as any)
  adapter.onSessionEvent(session as any, event('step/start', { turn: 2, step: 1 }, 2_010) as any)
  adapter.onAssistantStream({ agent: { session } as any,
    frame: { type: 'start', attemptId: 'export-attempt', turn: 2, step: 1 } as any })
  adapter.onSessionEvent(session as any, event('assistant/message', {
    turn: 2,
    step: 1,
    message: { id: 'assistant-output', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    stream: [],
  }, 2_020) as any)
  adapter.onSessionEvent(session as any, event('tool/call', {
    turn: 2,
    step: 1,
    callId: 'export-tool-call',
    name: 'read_file',
    arguments: '{}',
  }, 2_030) as any)
  adapter.onSessionEvent(session as any, event('tool/result', {
    turn: 2,
    step: 1,
    message: { content: [{ type: 'tool-result', toolCallId: 'export-tool-call' }] },
  }, 2_040) as any)
  adapter.onSessionEvent(session as any, event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 2_050) as any)
  await provider.forceFlush()

  const spans = exporter.getFinishedSpans()
  const root = spans.find(span => span.name === 'invoke_agent sdk')!
  const chat = spans.find(span => span.name === 'chat')!
  const tool = spans.find(span => span.name === 'execute_tool read_file')!
  assert.ok(root)
  assert.equal(chat.parentSpanContext?.spanId, root.spanContext().spanId)
  assert.equal(tool.parentSpanContext?.spanId, chat.spanContext().spanId)
  assert.equal(tool.attributes['gen_ai.tool.call.id'], 'export-tool-call')

  adapter.dispose()
  await provider.shutdown()
})

test('event handling returns while a failed batch export is pending', async () => {
  let exportStarted = false
  const unavailableCollector = {
    export(_spans: unknown[], callback: (result: { code: number; error?: Error }) => void) {
      exportStarted = true
      setTimeout(() => callback({ code: 1, error: new Error('collector unavailable') }), 150)
    },
    async shutdown() {},
  }
  const provider = new TracerProvider({
    spanProcessors: [new BatchSpanProcessor({
      exporter: unavailableCollector as any,
      scheduledDelayMillis: 10,
      exportTimeoutMillis: 500,
    })],
  })
  const adapter = new TraceAdapter(provider.getTracer('outage-test'), resolveConfig({ enabled: true }, {}))
  const session = testSession()
  const start = performance.now()
  adapter.onSessionEvent(session as any, event('turn/start', { turn: 1 }, Date.now()) as any)
  adapter.onSessionEvent(session as any, event('turn/end', { turn: 1, reason: { kind: 'completed' } }, Date.now()) as any)
  const eventHandlingMs = performance.now() - start

  assert.ok(eventHandlingMs < 100, `session event handling took ${eventHandlingMs}ms`)
  await provider.forceFlush().catch(() => undefined)
  assert.equal(exportStarted, true)
  await provider.shutdown().catch(() => undefined)
})
