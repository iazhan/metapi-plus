import { describe, expect, it } from 'vitest';

import { createResponsesProxyStreamSession } from './proxyStream.js';

function parseSseEvents(output: string): Array<{ event: string | null; payload: Record<string, unknown> | '[DONE]' }> {
  return output
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split('\n');
      const eventLine = lines.find((line) => line.startsWith('event: '));
      const dataLine = lines.find((line) => line.startsWith('data: '));
      if (!dataLine) return null;
      if (dataLine === 'data: [DONE]') {
        return {
          event: eventLine ? eventLine.slice('event: '.length) : null,
          payload: '[DONE]' as const,
        };
      }
      try {
        return {
          event: eventLine ? eventLine.slice('event: '.length) : null,
          payload: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>,
        };
      } catch {
        return null;
      }
    })
    .filter((item): item is { event: string | null; payload: Record<string, unknown> | '[DONE]' } => !!item);
}

describe('createResponsesProxyStreamSession', () => {
  it('serializes non-SSE fallback payloads into canonical responses SSE closeout events', () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const payload = {
      id: 'resp_fallback_1',
      object: 'response',
      status: 'completed',
      model: 'gpt-5.2',
      output_text: 'hello from responses upstream',
      output: [
        {
          id: 'msg_fallback_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'hello from responses upstream' }],
        },
      ],
      usage: {
        input_tokens: usage.promptTokens,
        output_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5.2',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = session.consumeUpstreamFinalPayload(
      payload,
      JSON.stringify(payload),
      {
        end() {
          ended = true;
        },
      },
    );

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    expect(ended).toBe(true);

    const output = lines.join('');
    expect(output).toContain('event: response.created');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('"type":"response.completed"');
    expect(output).toContain('"output_text":"hello from responses upstream"');
    expect(output).toContain('data: [DONE]');
  });

  it('preserves the canonical [DONE] terminator after an explicit response.completed SSE event', async () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const chunk = [
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"resp_stream_1","model":"gpt-5","usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const reader = {
      reads: 0,
      async read() {
        if (this.reads > 0) return { done: true };
        this.reads += 1;
        return { done: false, value: new TextEncoder().encode(chunk) };
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, {
      end() {
        ended = true;
      },
    });

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    expect(ended).toBe(true);
    const output = lines.join('');
    expect(output).toContain('event: response.completed');
    expect(output).toContain('data: [DONE]');
  });

  it('does not replay completed message and custom tool items when terminal output omits reasoning', async () => {
    const lines: string[] = [];
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const messageText = 'The command completed successfully.';
    const toolInput = '{"command":"Get-Date"}';
    const upstreamEvents: Array<Record<string, unknown>> = [
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: {
          id: 'rs_stream_1',
          type: 'reasoning',
          status: 'in_progress',
          summary: [],
        },
      },
      {
        type: 'response.output_item.done',
        output_index: 0,
        item: {
          id: 'rs_stream_1',
          type: 'reasoning',
          status: 'completed',
          summary: [],
        },
      },
      {
        type: 'response.output_item.added',
        output_index: 1,
        item: {
          id: 'msg_commentary_1',
          type: 'message',
          role: 'assistant',
          status: 'in_progress',
          content: [],
        },
      },
      {
        type: 'response.content_part.added',
        output_index: 1,
        item_id: 'msg_commentary_1',
        content_index: 0,
        part: {
          type: 'output_text',
          text: '',
        },
      },
      {
        type: 'response.output_text.done',
        output_index: 1,
        item_id: 'msg_commentary_1',
        content_index: 0,
        text: messageText,
      },
      {
        type: 'response.content_part.done',
        output_index: 1,
        item_id: 'msg_commentary_1',
        content_index: 0,
        part: {
          type: 'output_text',
          text: messageText,
        },
      },
      {
        type: 'response.output_item.done',
        output_index: 1,
        item: {
          id: 'msg_commentary_1',
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: messageText,
            },
          ],
        },
      },
      {
        type: 'response.output_item.added',
        output_index: 2,
        item: {
          id: 'ct_exec_1',
          type: 'custom_tool_call',
          status: 'in_progress',
          call_id: 'call_exec_1',
          name: 'exec',
          input: '',
        },
      },
      {
        type: 'response.custom_tool_call_input.done',
        output_index: 2,
        item_id: 'ct_exec_1',
        call_id: 'call_exec_1',
        name: 'exec',
        input: toolInput,
      },
      {
        type: 'response.output_item.done',
        output_index: 2,
        item: {
          id: 'ct_exec_1',
          type: 'custom_tool_call',
          status: 'completed',
          call_id: 'call_exec_1',
          name: 'exec',
          input: toolInput,
        },
      },
      {
        type: 'response.completed',
        response: {
          id: 'resp_compacted_terminal_1',
          model: 'gpt-5',
          status: 'completed',
          output: [
            {
              type: 'message',
              role: 'assistant',
              status: 'completed',
              content: [
                {
                  type: 'output_text',
                  text: messageText,
                },
              ],
            },
            {
              id: 'ct_exec_1',
              type: 'custom_tool_call',
              status: 'completed',
              call_id: 'call_exec_1',
              name: 'exec',
              input: toolInput,
            },
          ],
          usage: {
            input_tokens: usage.promptTokens,
            output_tokens: usage.completionTokens,
            total_tokens: usage.totalTokens,
          },
        },
      },
    ];
    const chunk = [
      ...upstreamEvents.flatMap((payload) => [
        `event: ${String(payload.type)}`,
        `data: ${JSON.stringify(payload)}`,
        '',
      ]),
      'data: [DONE]',
      '',
    ].join('\n');
    const reader = {
      reads: 0,
      async read() {
        if (this.reads > 0) return { done: true };
        this.reads += 1;
        return { done: false, value: new TextEncoder().encode(chunk) };
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    };
    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, { end() {} });

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    const events = parseSseEvents(lines.join(''));
    const addedItemIds = events
      .filter((entry) => entry.event === 'response.output_item.added' && entry.payload !== '[DONE]')
      .map((entry) => (entry.payload as { item?: { id?: unknown } }).item?.id);
    const doneItems = events
      .filter((entry) => entry.event === 'response.output_item.done' && entry.payload !== '[DONE]')
      .map((entry) => (entry.payload as { item?: Record<string, unknown> }).item);

    expect(addedItemIds).toEqual(['rs_stream_1', 'msg_commentary_1', 'ct_exec_1']);
    expect(doneItems.map((item) => item?.id)).toEqual(['rs_stream_1', 'msg_commentary_1', 'ct_exec_1']);
    expect(doneItems.filter((item) => item?.type === 'message')).toHaveLength(1);
    expect(doneItems.filter((item) => item?.type === 'custom_tool_call')).toHaveLength(1);
    expect(events.filter((entry) => (
      entry.event === 'response.output_text.done'
      && entry.payload !== '[DONE]'
      && (entry.payload as { item_id?: unknown }).item_id === 'msg_commentary_1'
    ))).toHaveLength(1);
    expect(events.filter((entry) => (
      entry.event === 'response.content_part.done'
      && entry.payload !== '[DONE]'
      && (entry.payload as { item_id?: unknown }).item_id === 'msg_commentary_1'
    ))).toHaveLength(1);
    expect(events.filter((entry) => (
      entry.event === 'response.custom_tool_call_input.done'
      && entry.payload !== '[DONE]'
      && (entry.payload as { call_id?: unknown }).call_id === 'call_exec_1'
    ))).toHaveLength(1);
    expect(events.filter((entry) => entry.payload === '[DONE]')).toHaveLength(1);
  });

  it('preserves response.incomplete SSE terminals instead of coercing them to response.failed', async () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const chunk = [
      'event: response.incomplete',
      'data: {"type":"response.incomplete","response":{"id":"resp_incomplete_1","model":"gpt-5","status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":5,"output_tokens":3,"total_tokens":8}}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const reader = {
      reads: 0,
      async read() {
        if (this.reads > 0) return { done: true };
        this.reads += 1;
        return { done: false, value: new TextEncoder().encode(chunk) };
      },
      async cancel() {
        return undefined;
      },
      releaseLock() {},
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = await session.run(reader as any, {
      end() {
        ended = true;
      },
    });

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    expect(ended).toBe(true);
    const output = lines.join('');
    expect(output).toContain('event: response.incomplete');
    expect(output).toContain('"status":"incomplete"');
    expect(output).toContain('"incomplete_details":{"reason":"max_output_tokens"}');
    expect(output).not.toContain('event: response.failed');
    expect(output).toContain('data: [DONE]');
  });

  it('preserves non-SSE incomplete fallback payloads as response.incomplete', () => {
    const lines: string[] = [];
    let ended = false;
    const usage = {
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      promptTokensIncludeCache: null,
    };
    const payload = {
      id: 'resp_incomplete_fallback_1',
      object: 'response',
      status: 'incomplete',
      incomplete_details: {
        reason: 'max_output_tokens',
      },
      model: 'gpt-5.2',
      output_text: 'partial answer',
      output: [
        {
          id: 'msg_incomplete_1',
          type: 'message',
          role: 'assistant',
          status: 'incomplete',
          content: [{ type: 'output_text', text: 'partial answer' }],
        },
      ],
      usage: {
        input_tokens: usage.promptTokens,
        output_tokens: usage.completionTokens,
        total_tokens: usage.totalTokens,
      },
    };

    const session = createResponsesProxyStreamSession({
      modelName: 'gpt-5.2',
      successfulUpstreamPath: '/v1/responses',
      getUsage: () => usage,
      writeLines: (nextLines) => {
        lines.push(...nextLines);
      },
      writeRaw: () => {},
    });

    const result = session.consumeUpstreamFinalPayload(
      payload,
      JSON.stringify(payload),
      {
        end() {
          ended = true;
        },
      },
    );

    expect(result).toEqual({
      status: 'completed',
      errorMessage: null,
    });
    expect(ended).toBe(true);

    const output = lines.join('');
    expect(output).toContain('event: response.incomplete');
    expect(output).toContain('"status":"incomplete"');
    expect(output).toContain('"output_text":"partial answer"');
    expect(output).not.toContain('event: response.completed');
    expect(output).toContain('data: [DONE]');
  });
});
