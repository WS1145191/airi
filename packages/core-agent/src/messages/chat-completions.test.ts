import { expect, it } from 'vitest'

import { chatMessagesToTurns, conversationToChatMessages } from './chat-completions'

// https://github.com/moeru-ai/airi/pull/2477
it('preserves nested provider extensions on native Chat replay', () => {
  // ROOT CAUSE:
  // Partial object schemas stripped fields inside tool calls and refusal parts.
  // Native replay now retains the SDK payload within its owning scope.
  const native = [{
    role: 'assistant' as const,
    content: [{ type: 'refusal' as const, refusal: 'Cannot comply', provider_details: { code: 'custom' } }],
    tool_calls: [{ type: 'function' as const, id: 'call', provider_id: 'opaque', function: { name: 'lookup', arguments: '{}', provider_state: 'keep' } }],
  }]
  const result = conversationToChatMessages({ turns: [{ type: 'assistant', id: 'turn', status: 'completed', rounds: [{ id: 'round', content: [], toolInvocations: [], projectionIssues: [], continuation: { protocol: 'chat-completions', scope: 'owner', data: native } }] }] }, true, 'owner')
  expect(result).toEqual(native)
  expect(native[0].tool_calls[0].function.provider_state).toBe('keep')
})

// https://github.com/moeru-ai/airi/pull/2477#discussion_r4002541732
it('serializes portable assistant refusals in string-only mode (PR #2477)', () => {
  // ROOT CAUSE:
  //
  // Assistant refusal parts bypassed the content-array capability check.
  // Flatten text and refusals in order so a string-only retry can succeed.
  const content = [{ type: 'text' as const, text: 'Sorry. ' }, { type: 'refusal' as const, refusal: 'Cannot comply.' }]
  const conversation = { turns: chatMessagesToTurns([{ role: 'assistant', content }]) }
  const before = structuredClone(conversation)
  expect(conversationToChatMessages(conversation, false)).toEqual([{ role: 'assistant', content: 'Sorry. Cannot comply.' }])
  expect(conversationToChatMessages(conversation, true)).toEqual([{ role: 'assistant', content }])
  expect(conversation).toEqual(before)
})

// https://github.com/moeru-ai/airi/pull/2477#discussion_r4002541732
it('serializes native assistant refusals in string-only mode (PR #2477)', () => {
  // ROOT CAUSE:
  //
  // Native replay excluded refusal arrays from conversion even after auto-degrade.
  // Convert the request content while retaining stored parts and provider fields.
  const native = [{
    role: 'assistant' as const,
    content: [{ type: 'text' as const, text: 'Sorry. ' }, { type: 'refusal' as const, refusal: 'Cannot comply.' }],
    provider_state: 'keep',
  }]
  const before = structuredClone(native)
  const conversation = { turns: [{ type: 'assistant' as const, id: 'turn', status: 'completed' as const, rounds: [{ id: 'round', content: [], toolInvocations: [], projectionIssues: [], continuation: { protocol: 'chat-completions' as const, scope: 'owner', data: native } }] }] }
  expect(conversationToChatMessages(conversation, false, 'owner')).toEqual([{ role: 'assistant', content: 'Sorry. Cannot comply.', provider_state: 'keep' }])
  expect(conversationToChatMessages(conversation, true, 'owner')).toEqual(native)
  expect(native).toEqual(before)
})

it('drops holes a provider-indexed tool call leaves in native replay', () => {
  // ROOT CAUSE:
  //
  // A streamed tool call is accumulated by provider index. A provider that
  // starts at index 1 (deepseek does) leaves a hole at index 0, so the array
  // serializes as `[null, {...}]` and the next request fails with
  // `tool call must be an object`. The hole carries no call and must not be
  // replayed.
  const native = [{
    role: 'assistant' as const,
    content: '',
    tool_calls: [null, { type: 'function' as const, id: 'call', function: { name: 'lookup', arguments: '{}' } }],
  }]
  const conversation = { turns: [{ type: 'assistant' as const, id: 'turn', status: 'completed' as const, rounds: [{ id: 'round', content: [], toolInvocations: [], projectionIssues: [], continuation: { protocol: 'chat-completions' as const, scope: 'owner', data: native } }] }] }
  const [message] = conversationToChatMessages(conversation, true, 'owner')
  expect(message.tool_calls).toEqual([{ type: 'function', id: 'call', function: { name: 'lookup', arguments: '{}' } }])
  expect(JSON.stringify(message)).not.toContain('tool_calls":[null')
  // The stored payload stays untouched: only the request is sanitized.
  expect(native[0].tool_calls).toHaveLength(2)
})

it('skips holes when reading stored history that already carries them', () => {
  // ROOT CAUSE:
  //
  // History written before the accumulation fix keeps the hole. Reading it must
  // not throw or invent a call, otherwise the poisoned session stays unusable.
  const turns = chatMessagesToTurns([{
    role: 'assistant',
    content: 'trying',
    tool_calls: [null, { type: 'function', id: 'call', function: { name: 'lookup', arguments: '{}' } }],
  } as never])
  expect(JSON.stringify(turns)).toContain('lookup')
  expect(JSON.stringify(turns)).not.toContain('null')
})
