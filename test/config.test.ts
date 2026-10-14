import assert from 'node:assert/strict'
import test from 'node:test'
import { ConfigSchema, resolveConfig } from '../src/config.ts'

test('config defaults to disabled metadata-only HTTP protobuf tracing', () => {
  const config = ConfigSchema({})
  assert.equal(config.enabled, false)
  assert.equal(config.protocol, 'http/protobuf')
  assert.equal(config.serviceName, 'dsh')
  assert.equal(config.capturePrompts, false)
  assert.equal(config.captureResponses, false)
  assert.equal(config.captureToolArguments, false)
  assert.equal(config.maxContentLength, 8_192)
})

test('specific environment variables override generic variables and profile config', () => {
  const resolved = resolveConfig({
    enabled: true,
    protocol: 'grpc',
    serviceName: 'profile-service',
    endpoint: 'https://profile.example/v1/traces',
    exportTimeoutMs: 2_000,
  }, {
    OTEL_SERVICE_NAME: 'env-service',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc',
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/protobuf',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://generic.example/otlp',
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'https://specific.example/custom-traces',
    OTEL_EXPORTER_OTLP_TIMEOUT: '8000',
    OTEL_EXPORTER_OTLP_TRACES_TIMEOUT: '3000',
  })
  assert.equal(resolved.protocol, 'http/protobuf')
  assert.equal(resolved.endpoint, 'https://specific.example/custom-traces')
  assert.equal(resolved.serviceName, 'env-service')
  assert.equal(resolved.exportTimeoutMs, 3_000)
})

test('generic HTTP endpoints receive the trace path while configured endpoints are complete', () => {
  assert.equal(resolveConfig({ endpoint: 'https://collector.example/custom' }, {}).endpoint,
    'https://collector.example/custom')
  assert.equal(resolveConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example/otlp/' }).endpoint,
    'https://collector.example/otlp/v1/traces')
  assert.equal(resolveConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example/v1/traces' }).endpoint,
    'https://collector.example/v1/traces')
  assert.equal(resolveConfig({}, { OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example/otlp?tenant=1' }).endpoint,
    'https://collector.example/otlp/v1/traces?tenant=1')
})

test('gRPC endpoint is not given an HTTP signal path', () => {
  assert.equal(resolveConfig({ protocol: 'grpc' }, {}).endpoint, 'http://localhost:4317')
  assert.equal(resolveConfig({ protocol: 'grpc' }, {
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example:4317',
  }).endpoint, 'https://collector.example:4317')
})

test('unsupported JSON protocol and invalid endpoints are rejected', () => {
  assert.throws(() => resolveConfig({}, {
    OTEL_EXPORTER_OTLP_TRACES_PROTOCOL: 'http/json',
  }), /http\/json is not supported/)
  assert.throws(() => resolveConfig({}, {
    OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: 'not a URL',
  }), /Invalid OTLP endpoint URL/)
})
