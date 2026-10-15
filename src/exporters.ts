import { Metadata } from '@grpc/grpc-js'
import { OTLPTraceExporter as GrpcTraceExporter } from '@opentelemetry/exporter-trace-otlp-grpc'
import { OTLPTraceExporter as HttpTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { BatchSpanProcessor, type SpanExporter } from '@opentelemetry/sdk-trace'
import type { ResolvedEndpoint } from './config.ts'

export type ExporterFactory = (endpoint: ResolvedEndpoint) => SpanExporter

export function createOtlpExporter(endpoint: ResolvedEndpoint): SpanExporter {
  const exporterConfig = { url: endpoint.url, timeoutMillis: endpoint.timeoutMs }
  if (endpoint.protocol === 'grpc') {
    const metadata = new Metadata()
    for (const [key, value] of Object.entries(endpoint.headers ?? {})) {
      metadata.set(key.toLowerCase(), value)
    }
    return new GrpcTraceExporter({ ...exporterConfig, metadata })
  }
  return new HttpTraceExporter({ ...exporterConfig, headers: endpoint.headers })
}

export function createSpanProcessors(
  endpoints: ResolvedEndpoint[],
  exporterFactory: ExporterFactory = createOtlpExporter,
): BatchSpanProcessor[] {
  return endpoints.map(endpoint => new BatchSpanProcessor({
    exporter: exporterFactory(endpoint),
    maxExportBatchSize: 128,
    maxQueueSize: 1024,
    scheduledDelayMillis: 1_000,
    exportTimeoutMillis: endpoint.timeoutMs,
  }))
}
