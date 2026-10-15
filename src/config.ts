import Schema from '@deepseek-ai/schemastery'

const ProtocolSchema = Schema.union([
  Schema.const('http/protobuf'),
  Schema.const('grpc'),
])

const EndpointSchema = Schema.object({
  /** HTTP requires a complete traces URL. gRPC accepts a target such as host:4317 or unix:///path. */
  url: Schema.string().default(''),
  protocol: ProtocolSchema.default('http/protobuf'),
  /** Name of an environment variable containing comma-separated key=value headers. */
  headersEnv: Schema.string().default(''),
  timeoutMs: Schema.natural().min(100).max(120_000).default(5_000),
})

export const ConfigSchema = Schema.object({
  enabled: Schema.boolean().default(false),
  serviceName: Schema.string().default('dsh'),
  endpoints: Schema.array(EndpointSchema).default([]),
  capturePrompts: Schema.boolean().default(false),
  captureResponses: Schema.boolean().default(false),
  captureToolArguments: Schema.boolean().default(false),
  maxContentLength: Schema.natural().min(64).max(65_536).default(8_192),
})

export type TracingConfig = Schemastery.TypeT<typeof ConfigSchema>
export type OtlpProtocol = 'http/protobuf' | 'grpc'
export type EndpointConfig = Schemastery.TypeT<typeof EndpointSchema>
export type EndpointInput = Partial<EndpointConfig>
export type TracingConfigInput = Partial<Omit<TracingConfig, 'endpoints'>> & {
  endpoints?: EndpointInput[]
}

export interface ResolvedEndpoint {
  url: string
  protocol: OtlpProtocol
  headers?: Record<string, string>
  timeoutMs: number
}

export interface ResolvedConfig {
  enabled: boolean
  serviceName: string
  endpoints: ResolvedEndpoint[]
  capturePrompts: boolean
  captureResponses: boolean
  captureToolArguments: boolean
  maxContentLength: number
}

export type Environment = Record<string, string | undefined>

function firstValue(...values: Array<string | undefined>): string | undefined {
  return values.find(value => value !== undefined && value.trim() !== '')?.trim()
}

function parseHeaders(raw: string, envName: string): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const pair of raw.split(',')) {
    const separator = pair.indexOf('=')
    if (separator <= 0) {
      throw new Error(`Invalid headers in environment variable ${envName}; expected comma-separated key=value pairs`)
    }
    const key = pair.slice(0, separator).trim()
    const value = pair.slice(separator + 1).trim()
    if (!key) {
      throw new Error(`Invalid headers in environment variable ${envName}; header names cannot be empty`)
    }
    headers[key] = value
  }
  return headers
}

function resolveHeaders(headersEnv: string | undefined, env: Environment): Record<string, string> | undefined {
  const envName = firstValue(headersEnv)
  if (!envName) return undefined
  const value = firstValue(env[envName])
  if (!value) throw new Error(`Environment variable ${envName} is required for endpoint headers`)
  return parseHeaders(value, envName)
}

function validateHttpEndpoint(endpoint: string): string {
  let parsed: URL
  try {
    parsed = new URL(endpoint)
  } catch {
    throw new Error(`Invalid OTLP HTTP endpoint URL: ${endpoint}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('OTLP HTTP/protobuf endpoint must use http or https')
  }
  return parsed.toString().replace(/\/$/, '')
}

function validateGrpcTarget(target: string): string {
  const value = target.trim()
  if (!value) throw new Error('OTLP gRPC endpoint target cannot be empty')
  if (value.startsWith('unix://')) {
    try {
      const parsed = new URL(value)
      if (!parsed.pathname) throw new Error()
    } catch {
      throw new Error(`Invalid OTLP gRPC endpoint target: ${target}`)
    }
    return value
  }

  let parsed: URL
  try {
    parsed = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`)
  } catch {
    throw new Error(`Invalid OTLP gRPC endpoint target: ${target}`)
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.host) {
    throw new Error(`Invalid OTLP gRPC endpoint target: ${target}`)
  }
  return value
}

function resolveEndpoint(endpoint: EndpointInput, index: number, env: Environment): ResolvedEndpoint {
  const protocol = endpoint.protocol ?? 'http/protobuf'
  const configuredUrl = endpoint.url ?? ''
  const url = protocol === 'grpc'
    ? validateGrpcTarget(configuredUrl)
    : validateHttpEndpoint(configuredUrl)
  const timeoutMs = endpoint.timeoutMs ?? 5_000
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    throw new Error(`Endpoint ${index + 1} timeoutMs must be an integer from 100 to 120000`)
  }

  return {
    url,
    protocol,
    headers: resolveHeaders(endpoint.headersEnv, env),
    timeoutMs,
  }
}

export function resolveConfig(config: TracingConfigInput, env: Environment = process.env): ResolvedConfig {
  return {
    enabled: config.enabled ?? false,
    serviceName: firstValue(env.OTEL_SERVICE_NAME, config.serviceName, 'dsh')!,
    endpoints: (config.endpoints ?? []).map((endpoint, index) => resolveEndpoint(endpoint, index, env)),
    capturePrompts: config.capturePrompts ?? false,
    captureResponses: config.captureResponses ?? false,
    captureToolArguments: config.captureToolArguments ?? false,
    maxContentLength: config.maxContentLength ?? 8_192,
  }
}
