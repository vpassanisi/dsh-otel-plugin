# DSH OpenTelemetry tracing plugin

This standalone DSH bundle exports agent, model, and tool spans over OTLP.

## Install

Build or download the package, then install it into a DSH profile:

```sh
npm install
npm run build
dsh plugin --profile sdk add file:/absolute/path/to/dsh-otel-plugin
```

The bundle patch registers the plugin with tracing disabled. Edit the profile patch to enable it and set nonsecret options. The plugin uses DSH `0.1.5-rc.1` session events and Cordis lifecycle hooks.

## Configuration

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `false` | Enables span creation and export. |
| `serviceName` | `dsh` | Sets the OTEL `service.name` resource attribute. |
| `protocol` | `http/protobuf` | Selects OTLP HTTP/protobuf or `grpc`. `http/json` is rejected. |
| `endpoint` | protocol default | Complete endpoint URL. For HTTP, include `/v1/traces`. |
| `exportTimeoutMs` | `5000` | Export timeout, from 100 to 120000 milliseconds. |
| `capturePrompts` | `false` | Adds redacted model input messages to `gen_ai.input.messages`. |
| `captureResponses` | `false` | Adds redacted model output messages to `gen_ai.output.messages`. |
| `captureToolArguments` | `false` | Adds redacted arguments to `gen_ai.tool.call.arguments` and captured tool-call messages. |
| `maxContentLength` | `8192` | Maximum serialized length for each captured content attribute. |

All content capture is opt-in. Captured strings redact common credential fields, bearer tokens, token-shaped keys, JWTs, and email addresses. Images and files are represented by their type only. Oversized values are truncated and marked. Tool results are not copied to tool spans.

Spans use `invoke_agent` roots, `chat` children per model attempt, and `execute_tool` children correlated by tool call ID. Retries create separate chat spans. Child agent roots link to a known parent session span. Stream frames record first-token timing. Export runs in a private batch provider; exporter and shutdown failures are contained so they do not escape into DSH event handling.

## Environment variables

Environment settings override profile settings. Trace-specific OTEL variables take precedence over generic variables.

| Variable | Behavior |
| --- | --- |
| `OTEL_SERVICE_NAME` | Overrides `serviceName`. |
| `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL` | Overrides protocol. Accepts `http/protobuf` or `grpc`. |
| `OTEL_EXPORTER_OTLP_PROTOCOL` | Generic protocol fallback. |
| `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` | Complete trace URL; HTTP values are used as given. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Generic base URL; HTTP adds `/v1/traces`. |
| `OTEL_EXPORTER_OTLP_TRACES_TIMEOUT` | Overrides export timeout in milliseconds. |
| `OTEL_EXPORTER_OTLP_TIMEOUT` | Generic timeout fallback in milliseconds. |
| `OTEL_EXPORTER_OTLP_TRACES_HEADERS` | Trace exporter headers, formatted as comma-separated `key=value` pairs. |
| `OTEL_EXPORTER_OTLP_HEADERS` | Generic header fallback. |

HTTP defaults to `http://localhost:4318/v1/traces`; gRPC defaults to `http://localhost:4317`. Keep authentication headers in environment variables or a host secret store. Do not put credentials in the profile patch.

## Development

```sh
npm test
npm run typecheck
npm run build
npm pack
```
