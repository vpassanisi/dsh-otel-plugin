import Schema from '@deepseek-ai/schemastery'

export const ConfigSchema = Schema.object({
  enabled: Schema.boolean().default(false),
  serviceName: Schema.string().default('dsh'),
  protocol: Schema.union([
    Schema.const('http/protobuf'),
    Schema.const('grpc'),
  ]).default('http/protobuf'),
  /** A complete OTLP trace URL. For HTTP, include `/v1/traces`. */
  endpoint: Schema.string().default(''),
  exportTimeoutMs: Schema.natural().min(100).max(120_000).default(5_000),
  capturePrompts: Schema.boolean().default(false),
  captureResponses: Schema.boolean().default(false),
  captureToolArguments: Schema.boolean().default(false),
  maxContentLength: Schema.natural().min(64).max(65_536).default(8_192),
})

export type TracingConfig = Schemastery.TypeT<typeof ConfigSchema>
export type OtlpProtocol = 'http/protobuf' | 'grpc'

export interface ResolvedConfig {
  enabled: boolean
  serviceName: string
  protocol: OtlpProtocol
  endpoint: string
  exportTimeoutMs: number
  capturePrompts: boolean
  captureResponses: boolean
  captureToolArguments: boolean
  maxContentLength: number
}

export type Environment = Record<string, string | undefined>

function firstValue(...values: Array<string | undefined>): string | undefined {
  return values.find(value => value !== undefined && value.trim() !== '')?.trim()
}

function parseProtocol(value: string | undefined, fallback: OtlpProtocol): OtlpProtocol {
  if (value === undefined) return fallback
  if (value === 'http/protobuf' || value === 'grpc') return value
  if (value === 'http/json') {
    throw new Error('OTLP protocol http/json is not supported; use http/protobuf or grpc')
  }
  throw new Error(`Unsupported OTLP trace protocol: ${value}`)
}

function validateEndpoint(endpoint: string, protocol: OtlpProtocol): string {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error(`Invalid OTLP endpoint URL: ${endpoint}`)
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`OTLP ${protocol} endpoint must use http or https`)
  }
  return parsed.toString().replace(/\/$/, '')
}

function appendTracesPath(base: string): string {
  const url = new URL(base)
  const path = url.pathname.replace(/\/+$/, '')
  url.pathname = path.endsWith('/v1/traces') ? path : `${path}/v1/traces`
  return url.toString()
}

export function resolveConfig(config: Partial<TracingConfig>, env: Environment = process.env): ResolvedConfig {
  const protocol = parseProtocol(
    firstValue(env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL, env.OTEL_EXPORTER_OTLP_PROTOCOL),
    config.protocol ?? 'http/protobuf',
  )
  const traceEndpoint = firstValue(env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT)
  const genericEndpoint = firstValue(env.OTEL_EXPORTER_OTLP_ENDPOINT)
  const configuredEndpoint = firstValue(config.endpoint)
  const endpoint = traceEndpoint
    ? traceEndpoint
    : genericEndpoint
      ? protocol === 'http/protobuf' ? appendTracesPath(genericEndpoint) : genericEndpoint
      : configuredEndpoint
        ? configuredEndpoint
        : protocol === 'http/protobuf'
          ? 'http://localhost:4318/v1/traces'
          : 'http://localhost:4317'

  const timeout = firstValue(
    env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT,
    env.OTEL_EXPORTER_OTLP_TIMEOUT,
  )
  const parsedTimeout = timeout === undefined ? undefined : Number(timeout)
  if (parsedTimeout !== undefined && (!Number.isInteger(parsedTimeout) || parsedTimeout <= 0)) {
    throw new Error('OTLP timeout environment value must be a positive integer in milliseconds')
  }

  return {
    enabled: config.enabled ?? false,
    serviceName: firstValue(env.OTEL_SERVICE_NAME, config.serviceName, 'dsh')!,
    protocol,
    endpoint: validateEndpoint(endpoint, protocol),
    exportTimeoutMs: parsedTimeout ?? config.exportTimeoutMs ?? 5_000,
    capturePrompts: config.capturePrompts ?? false,
    captureResponses: config.captureResponses ?? false,
    captureToolArguments: config.captureToolArguments ?? false,
    maxContentLength: config.maxContentLength ?? 8_192,
  }
}
