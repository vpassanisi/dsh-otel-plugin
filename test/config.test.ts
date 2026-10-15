import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfigSchema, resolveConfig } from '../src/config.ts'

test('config defaults to disabled tracing with no export destinations', () => {
  const config = ConfigSchema({})
  assert.equal(config.enabled, false)
  assert.deepEqual(config.endpoints, [])
  assert.equal(config.serviceName, 'dsh')
  assert.equal(config.capturePrompts, false)
  assert.equal(config.captureResponses, false)
  assert.equal(config.captureToolArguments, false)
  assert.equal(config.maxContentLength, 8_192)
  assert.deepEqual(resolveConfig({}, {}).endpoints, [])
})

test('each endpoint keeps its own URL, protocol, headers, and timeout', () => {
  const resolved = resolveConfig({
    enabled: true,
    endpoints: [
      {
        url: 'https://http-collector.example/v1/traces',
        protocol: 'http/protobuf',
        headersEnv: 'FIRST_COLLECTOR_HEADERS',
      },
      {
        url: 'grpc-collector.example:4317',
        protocol: 'grpc',
        headersEnv: 'SECOND_COLLECTOR_HEADERS',
        timeoutMs: 2_000,
      },
    ],
  }, {
    FIRST_COLLECTOR_HEADERS: 'authorization=Bearer first-token,x-tenant=one',
    SECOND_COLLECTOR_HEADERS: 'authorization=Bearer second-token',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://ignored.example/otlp',
  })

  assert.deepEqual(resolved.endpoints, [
    {
      url: 'https://http-collector.example/v1/traces',
      protocol: 'http/protobuf',
      headers: { authorization: 'Bearer first-token', 'x-tenant': 'one' },
      timeoutMs: 5_000,
    },
    {
      url: 'grpc-collector.example:4317',
      protocol: 'grpc',
      headers: { authorization: 'Bearer second-token' },
      timeoutMs: 2_000,
    },
  ])
})

test('OTEL_SERVICE_NAME overrides profile service name', () => {
  const resolved = resolveConfig({ serviceName: 'profile-service' }, {
    OTEL_SERVICE_NAME: 'env-service',
  })
  assert.equal(resolved.serviceName, 'env-service')
})

test('HTTP endpoints must be complete HTTP or HTTPS URLs', () => {
  assert.equal(resolveConfig({ endpoints: [{ url: 'https://collector.example/custom-traces' }] }, {})
    .endpoints[0]?.url, 'https://collector.example/custom-traces')
  assert.throws(() => resolveConfig({ endpoints: [{ url: 'not a URL' }] }, {}),
    /Invalid OTLP HTTP endpoint URL/)
  assert.throws(() => resolveConfig({ endpoints: [{ url: 'ftp://collector.example/traces' }] }, {}),
    /must use http or https/)
})

test('gRPC accepts HTTP(S), host:port, and unix socket targets', () => {
  assert.equal(resolveConfig({ endpoints: [{ url: 'https://collector.example:4317', protocol: 'grpc' }] }, {})
    .endpoints[0]?.url, 'https://collector.example:4317')
  assert.equal(resolveConfig({ endpoints: [{ url: 'unix:///tmp/otel.sock', protocol: 'grpc' }] }, {})
    .endpoints[0]?.url, 'unix:///tmp/otel.sock')
  assert.throws(() => resolveConfig({ endpoints: [{ url: '', protocol: 'grpc' }] }, {}),
    /target cannot be empty/)
  assert.throws(() => resolveConfig({ endpoints: [{ url: 'ftp://collector.example', protocol: 'grpc' }] }, {}),
    /Invalid OTLP gRPC endpoint target/)
})

test('referenced header environment variables must exist and contain key-value pairs', () => {
  assert.throws(() => resolveConfig({
    endpoints: [{ url: 'https://collector.example/v1/traces', headersEnv: 'MISSING_HEADERS' }],
  }, {}), /MISSING_HEADERS is required/)

  assert.throws(() => resolveConfig({
    endpoints: [{ url: 'https://collector.example/v1/traces', headersEnv: 'BROKEN_HEADERS' }],
  }, { BROKEN_HEADERS: 'not-a-pair' }), /expected comma-separated key=value pairs/)
})

test('endpoint timeouts must be between 100 and 120000 milliseconds', () => {
  assert.throws(() => resolveConfig({
    endpoints: [{ url: 'https://collector.example/v1/traces', timeoutMs: 99 }],
  }, {}), /timeoutMs must be an integer from 100 to 120000/)
  assert.throws(() => resolveConfig({
    endpoints: [{ url: 'https://collector.example/v1/traces', timeoutMs: 120_001 }],
  }, {}), /timeoutMs must be an integer from 100 to 120000/)
})
