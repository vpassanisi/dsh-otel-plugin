# DSH OpenTelemetry tracing plugin

This standalone DSH bundle exports agent, model, and tool spans over OTLP. Every finished span is sent to each configured destination using that destination's own protocol and batch processor.

## Install

Build or download the package, then install it into a DSH profile:

```sh
npm install
npm run build
dsh plugin --profile sdk add file:/absolute/path/to/dsh-otel-plugin
```

The bundle patch registers the plugin with tracing disabled. Edit the profile patch to enable it and configure one or more destinations. The plugin uses DSH `0.1.5-rc.1` session events and Cordis lifecycle hooks.

## Configuration

```yaml
enabled: true
serviceName: dsh
endpoints:
  - url: https://collector-one.example/v1/traces
    protocol: http/protobuf
    headers:
      authorization: "Bearer <runtime-supplied-token>"
    timeoutMs: 5000
  - url: https://collector-two.example:4317
    protocol: grpc
    headers:
      x-api-key: "<runtime-supplied-key>"
    timeoutMs: 8000
```

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | Enables span creation and export. |
| `serviceName` | `dsh` | Sets the shared OTEL `service.name` resource attribute. |
| `endpoints` | `[]` | Export destinations. An empty list creates no exporters. |
| `endpoints[].url` | required | Complete HTTP trace URL, including `/v1/traces`, or a gRPC target such as `collector:4317` or `unix:///path/to/socket`. |
| `endpoints[].protocol` | `http/protobuf` | Selects `http/protobuf` or `grpc`; `http/json` is not supported. |
| `endpoints[].headers` | `{}` | Optional map of header names to values, sent as HTTP headers or gRPC metadata. |
| `endpoints[].timeoutMs` | `5000` | Per-destination export timeout, from 100 to 120000 milliseconds. |
| `capturePrompts` | `false` | Adds redacted model input messages to `gen_ai.input.messages`. |
| `captureResponses` | `false` | Adds redacted model output messages to `gen_ai.output.messages`. |
| `captureToolArguments` | `false` | Adds redacted arguments to `gen_ai.tool.call.arguments` and captured tool-call messages. |
| `maxContentLength` | `8192` | Maximum serialized length for each captured content attribute. |

Header values are passed through as configured; the plugin does not store credentials or resolve them from environment variables. A host integration can read credentials from its secret store and populate `headers` when it builds runtime config. Avoid committing real credentials in a persistent profile patch.

For gRPC, these headers are sent as request metadata. HTTP headers and gRPC metadata are configured independently for each destination. OTEL's standard `OTEL_EXPORTER_OTLP_*_ENDPOINT` and `*_PROTOCOL` variables do not select destinations; configure destinations in `endpoints`. `OTEL_SERVICE_NAME` continues to override `serviceName`. Standard exporter TLS environment settings may also be applied by the underlying exporters.

All content capture is opt-in. Captured strings redact common credential fields, bearer tokens, token-shaped keys, JWTs, and email addresses. Images and files are represented by their type only. Oversized values are truncated and marked. Tool results are not copied to tool spans.

Spans use `invoke_agent` roots, `chat` children per model attempt, and `execute_tool` children correlated by tool call ID. Retries create separate chat spans. Child agent roots link to a known parent session span. Stream frames record first-token timing. Each destination has its own batch queue; a failed export to one endpoint does not interrupt DSH event handling or another endpoint's processor. Exporter and shutdown failures are contained.

## Migrating from a single endpoint

Replace top-level `endpoint`, `protocol`, and `exportTimeoutMs` settings with an `endpoints` list. Move the old endpoint and protocol values into one item and set its `timeoutMs` if needed. The previous OTEL endpoint and protocol variables no longer select the destination; use per-endpoint URLs and protocols in the profile. Replace each `headersEnv` entry with a `headers` map. Hosts that manage secrets should resolve them from secure storage and supply the header values in runtime config.

## Development

```sh
npm test
npm run typecheck
npm run build
npm pack
```
