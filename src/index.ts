import type { Context, Plugin } from '@deepseek-ai/cordis'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { TracerProvider } from '@opentelemetry/sdk-trace'
import { ConfigSchema, resolveConfig, type TracingConfig } from './config.ts'
import { TraceAdapter } from './adapter.ts'
import { createSpanProcessors } from './exporters.ts'

type Session = Parameters<TraceAdapter['onSessionEvent']>[0]
type DurableEvent = Parameters<TraceAdapter['onSessionEvent']>[1]
type StreamPayload = Parameters<TraceAdapter['onAssistantStream']>[0]

type DshEvents = {
  on(name: 'session/event', listener: (session: Session, event: DurableEvent) => void, options?: { global?: boolean }): unknown
  on(name: 'session/disposed', listener: (session: Session) => void, options?: { global?: boolean }): unknown
  on(name: 'agent/assistant-stream', listener: (payload: StreamPayload) => void, options?: { global?: boolean }): unknown
}

function safeListener<T extends unknown[]>(
  label: string,
  logger: { warn?: (message: string, error?: unknown) => void } | undefined,
  listener: (...args: T) => void,
): (...args: T) => void {
  return (...args) => {
    try {
      listener(...args)
    } catch (error) {
      try {
        logger?.warn?.(`[dsh-otel-plugin] ${label} failed`, error)
      } catch {
        // Logging is best effort too. Observer errors must not escape into DSH.
      }
    }
  }
}

const plugin: Plugin.Object<TracingConfig> = {
  name: 'dsh-otel-plugin',
  Config: ConfigSchema as unknown as NonNullable<Plugin.Object<TracingConfig>['Config']>,
  apply(ctx: Context, config: TracingConfig) {
    if (!config.enabled) return
    const resolved = resolveConfig(config)
    if (resolved.endpoints.length === 0) return

    const provider = new TracerProvider({
      resource: resourceFromAttributes({ 'service.name': resolved.serviceName }),
      spanProcessors: createSpanProcessors(resolved.endpoints),
    })
    const tracer = provider.getTracer('dsh-otel-plugin', '0.1.0')
    const adapter = new TraceAdapter(tracer, resolved)
    const logger = (ctx as Context & { logger?: (name: string) => { warn?: (message: string, error?: unknown) => void } })
      .logger?.('dsh-otel-plugin')
    const events = ctx as unknown as DshEvents

    // Cordis unwinds effects in reverse order, so register this before hooks.
    // The hooks are removed before the final span flush starts.
    ctx.effect(() => async () => {
      adapter.dispose()
      try {
        await provider.shutdown()
      } catch (error) {
        try {
          logger?.warn?.('[dsh-otel-plugin] exporter shutdown failed', error)
        } catch {
          // Shutdown errors are contained so unloading does not reject DSH work.
        }
      }
    })

    events.on('session/event', safeListener('session/event', logger, (session, event) => {
      adapter.onSessionEvent(session, event)
    }), { global: true })
    events.on('session/disposed', safeListener('session/disposed', logger, session => {
      adapter.onSessionDisposed(session)
    }), { global: true })
    events.on('agent/assistant-stream', safeListener('agent/assistant-stream', logger, payload => {
      adapter.onAssistantStream(payload)
    }), { global: true })
  },
}

export { ConfigSchema, resolveConfig }
export { TraceAdapter } from './adapter.ts'
export default plugin
