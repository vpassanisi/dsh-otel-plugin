import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveConfig } from '../src/config.ts'
import { capturedMessages, capturedToolArguments, redactText, serializeCapturedContent } from '../src/privacy.ts'

const options = resolveConfig({ enabled: true, captureToolArguments: false }, {})

test('redacts credentials, token-shaped keys, and email addresses', () => {
  const result = redactText('api_key="abc123" Authorization: Bearer abc.def email user@example.com sk_live_123456789012345678')
  assert.doesNotMatch(result, /abc123|abc\.def|user@example\.com|sk_live/)
  assert.match(result, /REDACTED/)
})

test('captured messages hide tool arguments unless the separate option is enabled', () => {
  const value = capturedMessages([{
    role: 'assistant',
    content: [{ type: 'tool-call', id: 'call-1', name: 'lookup', arguments: '{"email":"user@example.com"}' }],
  }], options)!
  assert.match(value, /\[REDACTED\]/)
  assert.doesNotMatch(value, /user@example\.com/)

  const withArguments = capturedToolArguments('{"api_key":"secret-value"}', {
    ...options,
    captureToolArguments: true,
  })
  assert.doesNotMatch(withArguments, /secret-value/)
})

test('content serialization stays valid JSON and within the configured limit', () => {
  const result = serializeCapturedContent({ text: 'x'.repeat(500) }, 80)
  assert.ok(result.length <= 80)
  assert.equal(JSON.parse(result).truncated, true)
})
