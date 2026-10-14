import type { ResolvedConfig } from './config.ts'

const secretAssignment = /(["']?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth(?:orization)?|password|passwd|secret|client[_-]?secret)["']?\s*[:=]\s*)(["'][^"']*["']|[^\s,;)}]+)/gi
const authorizationBearer = /(authorization\s*[:=]\s*["']?Bearer\s+)[^\s"',;)}]+/gi
const bearerToken = /\b(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi
const jwt = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const apiKeyLike = /\b(?:sk|rk|pk|ghp|github_pat|AKIA)[-_][A-Za-z0-9_-]{16,}\b/gi
const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi

export function redactText(value: string): string {
  return value
    .replace(authorizationBearer, '$1[REDACTED]')
    .replace(secretAssignment, '$1"[REDACTED]"')
    .replace(bearerToken, '$1[REDACTED]')
    .replace(jwt, '[REDACTED_TOKEN]')
    .replace(apiKeyLike, '[REDACTED_KEY]')
    .replace(email, '[REDACTED_EMAIL]')
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactText(value)
  if (Array.isArray(value)) return value.map(redactValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      /^(?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password|passwd|secret|client[_-]?secret)$/i.test(key)
        ? '[REDACTED]'
        : redactValue(child),
    ]))
  }
  return value
}

export function serializeCapturedContent(value: unknown, limit: number): string {
  const serialized = JSON.stringify(redactValue(value)) ?? 'null'
  if (serialized.length <= limit) return serialized

  let preview = serialized.slice(0, limit)
  let result = ''
  do {
    result = JSON.stringify({ truncated: true, preview })
    if (result.length > limit) preview = preview.slice(0, Math.max(0, preview.length - (result.length - limit)))
  } while (result.length > limit && preview.length > 0)
  return result.length <= limit ? result : '{"truncated":true}'
}

interface ContentBlock {
  type?: string
  text?: string
  id?: string
  name?: string
  arguments?: string
  toolCallId?: string
  content?: ContentBlock[]
}

interface ConversationMessage {
  id?: string
  role?: string
  content?: any[]
}

function mapBlock(block: ContentBlock, includeToolArguments: boolean): Record<string, unknown> {
  switch (block.type) {
    case 'text':
    case 'reasoning':
      return { type: block.type, text: block.text ?? '' }
    case 'image':
      return { type: 'image' }
    case 'file':
      return { type: 'file' }
    case 'tool-call':
      return {
        type: 'tool_call',
        id: block.id,
        name: block.name,
        ...(includeToolArguments ? { arguments: block.arguments } : { arguments: '[REDACTED]' }),
      }
    case 'tool-result':
      return {
        type: 'tool_result',
        id: block.toolCallId,
        content: (block.content ?? []).map(item => mapBlock(item, includeToolArguments)),
      }
    default:
      return { type: block.type ?? 'unknown' }
  }
}

export function capturedMessages(
  messages: readonly ConversationMessage[],
  config: ResolvedConfig,
): string | undefined {
  const mapped = messages.map(message => ({
    role: message.role ?? 'unknown',
    content: (message.content ?? []).map(block => mapBlock(block, config.captureToolArguments)),
  }))
  return serializeCapturedContent(mapped, config.maxContentLength)
}

export function capturedToolArguments(argumentsJson: string, config: ResolvedConfig): string {
  let value: unknown = argumentsJson
  try {
    value = JSON.parse(argumentsJson)
  } catch {
    // Keep malformed model output as a redacted string so it remains inspectable.
  }
  return serializeCapturedContent(value, config.maxContentLength)
}
