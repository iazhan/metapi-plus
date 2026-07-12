import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import {
  authorizeDownstreamToken,
  consumeManagedKeyRequest,
  isModelAllowedByPolicyOrAllowedRoutes,
  type DownstreamTokenAuthSuccess,
} from '../../services/downstreamApiKeyService.js';
import { tokenRouter } from '../../services/tokenRouter.js';
import { openAiResponsesTransformer } from '../../transformers/openai/responses/index.js';
import { config } from '../../config.js';
import { applyOpenAiServiceTierPolicy } from '../../proxy-core/serviceTierPolicy.js';

const installedApps = new WeakSet<FastifyInstance>();
const WS_TURN_STATE_HEADER = 'x-codex-turn-state';
const RESPONSES_WEBSOCKET_MODE_HEADER = 'x-metapi-responses-websocket-mode';
const RESPONSES_WEBSOCKET_TRANSPORT_HEADER = 'x-metapi-responses-websocket-transport';

type SelectedChannel = NonNullable<Awaited<ReturnType<typeof tokenRouter.selectChannel>>>;
type ResponsesWebsocketAuthContext = DownstreamTokenAuthSuccess;

type NormalizedResponsesWebsocketRequest =
  | {
    ok: true;
    request: Record<string, unknown>;
    nextRequestSnapshot: Record<string, unknown>;
  }
  | {
    ok: false;
    status: number;
    message: string;
  };

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getServiceTierPolicyRules(): unknown {
  return (config as typeof config & { openAiServiceTierRules?: unknown }).openAiServiceTierRules;
}

function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function headerValueToTrimmedString(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed) return trimmed;
    }
  }
  return '';
}

function shouldReuseSelectedChannel(
  selectedChannel: SelectedChannel | null,
  requestModel: string,
): boolean {
  if (!selectedChannel) return false;
  const selectedModel = asTrimmedString(selectedChannel.actualModel).toLowerCase();
  const normalizedRequestModel = asTrimmedString(requestModel).toLowerCase();
  if (!selectedModel || !normalizedRequestModel) return true;
  return selectedModel === normalizedRequestModel;
}

function parseJsonObject(raw: RawData): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(String(raw));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cloneJsonObject<T>(value: T): T {
  return structuredClone(value);
}

function toResponseInputArray(value: unknown): unknown[] {
  return Array.isArray(value) ? cloneJsonObject(value) : [];
}

function normalizeResponsesWebsocketRequest(
  parsed: Record<string, unknown>,
  lastRequest: Record<string, unknown> | null,
  lastResponseOutput: unknown[],
  supportsIncrementalInput: boolean,
): NormalizedResponsesWebsocketRequest {
  const requestType = asTrimmedString(parsed.type);
  if (requestType !== 'response.create' && requestType !== 'response.append') {
    return {
      ok: false,
      status: 400,
      message: `unsupported websocket request type: ${requestType || 'unknown'}`,
    };
  }

  if (!lastRequest) {
    if (requestType !== 'response.create') {
      return {
        ok: false,
        status: 400,
        message: 'websocket request received before response.create',
      };
    }
    const next = cloneJsonObject(parsed);
    delete next.type;
    if (!supportsIncrementalInput && parsed.generate === false) {
      delete next.generate;
    }
    next.stream = true;
    if (!Array.isArray(next.input)) next.input = [];
    const modelName = asTrimmedString(next.model);
    if (!modelName) {
      return {
        ok: false,
        status: 400,
        message: 'missing model in response.create request',
      };
    }
    return {
      ok: true,
      request: next,
      nextRequestSnapshot: cloneJsonObject(next),
    };
  }

  if (!Array.isArray(parsed.input)) {
    return {
      ok: false,
      status: 400,
      message: 'websocket request requires array field: input',
    };
  }

  const next = cloneJsonObject(parsed);
  delete next.type;
  next.stream = true;
  if (!('model' in next) && typeof lastRequest.model === 'string') {
    next.model = lastRequest.model;
  }
  if (!('instructions' in next) && lastRequest.instructions !== undefined) {
    next.instructions = cloneJsonObject(lastRequest.instructions);
  }

  if (supportsIncrementalInput && requestType === 'response.create' && asTrimmedString(parsed.previous_response_id)) {
    return {
      ok: true,
      request: next,
      nextRequestSnapshot: cloneJsonObject(next),
    };
  }

  const mergedInput = [
    ...toResponseInputArray(lastRequest.input),
    ...cloneJsonObject(lastResponseOutput),
    ...cloneJsonObject(parsed.input),
  ];
  delete next.previous_response_id;
  next.input = mergedInput;

  return {
    ok: true,
    request: next,
    nextRequestSnapshot: cloneJsonObject(next),
  };
}

function shouldHandleResponsesWebsocketPrewarmLocally(
  parsed: Record<string, unknown>,
  lastRequest: Record<string, unknown> | null,
  supportsIncrementalInput: boolean,
): boolean {
  if (supportsIncrementalInput || lastRequest) return false;
  if (asTrimmedString(parsed.type) !== 'response.create') return false;
  return parsed.generate === false;
}

function writeResponsesWebsocketError(
  socket: WebSocket,
  status: number,
  message: string,
  errorPayload?: unknown,
) {
  socket.send(JSON.stringify({
    type: 'error',
    status,
    error: isRecord(errorPayload) && isRecord(errorPayload.error)
      ? errorPayload.error
      : {
        type: status >= 500 ? 'server_error' : 'invalid_request_error',
        message,
      },
  }));
}

function synthesizePrewarmResponsePayloads(request: Record<string, unknown>) {
  const responseId = `resp_prewarm_${randomUUID()}`;
  const modelName = asTrimmedString(request.model) || 'unknown';
  const createdAt = Math.floor(Date.now() / 1000);
  return [
    {
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'in_progress',
        model: modelName,
        output: [],
      },
    },
    {
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        created_at: createdAt,
        status: 'completed',
        model: modelName,
        output: [],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          total_tokens: 0,
        },
      },
    },
  ];
}

function collectResponsesOutput(payloads: unknown[]): unknown[] {
  const outputByIndex = new Map<number, unknown>();
  let completedOutput: unknown[] | null = null;
  const fallbackStatusForType = (type: string): string => {
    if (type === 'response.completed') return 'completed';
    if (type === 'response.failed') return 'failed';
    return 'incomplete';
  };

  for (const payload of payloads) {
    if (!isRecord(payload)) continue;
    const type = asTrimmedString(payload.type);
    if ((type === 'response.output_item.added' || type === 'response.output_item.done')
      && Number.isInteger(payload.output_index)
      && payload.item !== undefined) {
      outputByIndex.set(Number(payload.output_index), cloneJsonObject(payload.item));
      continue;
    }
    if (
      (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed')
      && isRecord(payload.response)
      && Array.isArray(payload.response.output)
    ) {
      const terminalOutput = cloneJsonObject(payload.response.output);
      if (terminalOutput.length > 0 || outputByIndex.size === 0) {
        completedOutput = terminalOutput;
      }
      continue;
    }
    if (
      (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed')
      && isRecord(payload.response)
      && typeof payload.response.output_text === 'string'
      && payload.response.output_text.trim()
    ) {
      completedOutput = [{
        id: `msg_${asTrimmedString(payload.response.id) || type}`,
        type: 'message',
        role: 'assistant',
        status: asTrimmedString(payload.response.status) || fallbackStatusForType(type),
        content: [{
          type: 'output_text',
          text: payload.response.output_text,
        }],
      }];
      continue;
    }
    if (Array.isArray(payload.output)) {
      const terminalOutput = cloneJsonObject(payload.output);
      if (terminalOutput.length > 0 || outputByIndex.size === 0) {
        completedOutput = terminalOutput;
      }
      continue;
    }
    if (typeof payload.output_text === 'string' && payload.output_text.trim()) {
      const fallbackStatus = asTrimmedString(payload.status) || fallbackStatusForType(type || 'response.completed');
      completedOutput = [{
        id: `msg_${type || 'response'}`,
        type: 'message',
        role: 'assistant',
        status: fallbackStatus,
        content: [{
          type: 'output_text',
          text: payload.output_text,
        }],
      }];
    }
  }

  if (completedOutput) return completedOutput;
  return [...outputByIndex.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, value]) => value);
}

async function forwardResponsesRequestViaHttp(input: {
  app: FastifyInstance;
  socket: WebSocket;
  request: IncomingMessage;
  payload: Record<string, unknown>;
  preserveIncrementalMode: boolean;
  authToken: string;
}): Promise<unknown[] | null> {
  const injectHeaders: Record<string, string | string[]> = {
    ...buildInjectHeaders(input.request),
    [RESPONSES_WEBSOCKET_TRANSPORT_HEADER]: '1',
    ...(input.preserveIncrementalMode ? { [RESPONSES_WEBSOCKET_MODE_HEADER]: 'incremental' } : {}),
  };
  if (
    !headerValueToTrimmedString(injectHeaders.authorization)
    && !headerValueToTrimmedString(injectHeaders['x-api-key'])
    && !headerValueToTrimmedString(injectHeaders['x-goog-api-key'])
  ) {
    injectHeaders.authorization = `Bearer ${input.authToken}`;
  }

  const response = await input.app.inject({
    method: 'POST',
    url: '/v1/responses',
    headers: injectHeaders,
    payload: input.payload,
  });

  if (response.statusCode < 200 || response.statusCode >= 300) {
    let payload: unknown = null;
    try {
      payload = JSON.parse(response.body);
    } catch {
      payload = null;
    }
    writeResponsesWebsocketError(
      input.socket,
      response.statusCode,
      response.statusMessage || 'Upstream error',
      payload,
    );
    return null;
  }

  const contentType = String(response.headers['content-type'] || '').toLowerCase();
  if (!contentType.includes('text/event-stream')) {
    try {
      const payload = JSON.parse(response.body);
      const output = collectResponsesOutput([payload]);
      input.socket.send(JSON.stringify(payload));
      return output;
    } catch {
      writeResponsesWebsocketError(input.socket, 502, 'Unexpected non-JSON websocket proxy response');
      return null;
    }
  }

  const pulled = openAiResponsesTransformer.pullSseEvents(response.body);
  const forwardedPayloads: unknown[] = [];
  let sawTerminalPayload = false;
  for (const event of pulled.events) {
    if (event.data === '[DONE]') continue;
    try {
      const payload = JSON.parse(event.data);
      forwardedPayloads.push(payload);
      const type = isRecord(payload) ? asTrimmedString(payload.type) : '';
      if (type === 'response.completed' || type === 'response.failed' || type === 'response.incomplete') {
        sawTerminalPayload = true;
      }
      input.socket.send(JSON.stringify(payload));
    } catch {
      // Ignore malformed SSE frames; the HTTP route already normalizes them.
    }
  }
  if (!sawTerminalPayload) {
    writeResponsesWebsocketError(input.socket, 408, 'stream closed before response.completed');
  }
  return collectResponsesOutput(forwardedPayloads);
}

function buildInjectHeaders(request: IncomingMessage): Record<string, string | string[]> {
  const headers: Record<string, string | string[]> = {};
  for (const [rawKey, rawValue] of Object.entries(request.headers)) {
    const key = rawKey.toLowerCase();
    if (!rawValue) continue;
    if (
      key === 'host'
      || key === 'connection'
      || key === 'upgrade'
      || key === 'sec-websocket-key'
      || key === 'sec-websocket-version'
      || key === 'sec-websocket-extensions'
      || key === 'sec-websocket-protocol'
    ) {
      continue;
    }
    headers[rawKey] = rawValue as string | string[];
  }
  return headers;
}

function extractWebsocketAuthToken(request: IncomingMessage, url: URL): string {
  const auth = headerValueToTrimmedString(request.headers.authorization);
  if (auth) return auth.replace(/^Bearer\s+/i, '').trim();
  const apiKey = headerValueToTrimmedString(request.headers['x-api-key']);
  if (apiKey) return apiKey;
  const googApiKey = headerValueToTrimmedString(request.headers['x-goog-api-key']);
  if (googApiKey) return googApiKey;
  return asTrimmedString(url.searchParams.get('key'));
}

function writeUpgradeHttpError(socket: Duplex, status: number, message: string): void {
  const statusText = status === 401
    ? 'Unauthorized'
    : status === 403
      ? 'Forbidden'
      : status === 400
        ? 'Bad Request'
        : 'Error';
  const body = JSON.stringify({ error: message });
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\n`
    + 'Content-Type: application/json\r\n'
    + `Content-Length: ${Buffer.byteLength(body)}\r\n`
    + 'Connection: close\r\n'
    + '\r\n'
    + body,
  );
}

async function handleResponsesWebsocketConnection(
  app: FastifyInstance,
  socket: WebSocket,
  request: IncomingMessage,
  authContext: ResponsesWebsocketAuthContext,
) {
  let lastRequest: Record<string, unknown> | null = null;
  let lastResponseOutput: unknown[] = [];
  let selectedChannel: SelectedChannel | null = null;
  let messageQueue = Promise.resolve();

  socket.on('message', (raw) => {
    messageQueue = messageQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          const parsed = parseJsonObject(raw);
          if (!parsed) {
            writeResponsesWebsocketError(socket, 400, 'Invalid websocket JSON payload');
            return;
          }

          const requestModel = asTrimmedString(parsed.model) || asTrimmedString(lastRequest?.model);
          if (requestModel && !await isModelAllowedByPolicyOrAllowedRoutes(requestModel, authContext.policy)) {
            writeResponsesWebsocketError(socket, 403, 'model is not allowed for this downstream key');
            return;
          }
          const serviceTierPolicy = applyOpenAiServiceTierPolicy({
            body: parsed,
            context: {
              requestedModel: requestModel,
            },
            rules: getServiceTierPolicyRules(),
          });
          if (!serviceTierPolicy.ok) {
            writeResponsesWebsocketError(
              socket,
              serviceTierPolicy.statusCode,
              serviceTierPolicy.payload.error.message,
              serviceTierPolicy.payload,
            );
            return;
          }
          parsed.service_tier = serviceTierPolicy.body.service_tier;
          if (serviceTierPolicy.body.service_tier === undefined) delete parsed.service_tier;
          const supportsIncrementalInput = false;
          const shouldHandleLocalPrewarm = shouldHandleResponsesWebsocketPrewarmLocally(
            parsed,
            lastRequest,
            supportsIncrementalInput,
          );
          const normalized = normalizeResponsesWebsocketRequest(
            parsed,
            lastRequest,
            lastResponseOutput,
            supportsIncrementalInput,
          );
          if (!normalized.ok) {
            writeResponsesWebsocketError(socket, normalized.status, normalized.message);
            return;
          }

          if (authContext.source === 'managed' && authContext.key?.id) {
            await consumeManagedKeyRequest(authContext.key.id);
          }

          if (shouldHandleLocalPrewarm) {
            lastRequest = normalized.nextRequestSnapshot;
            lastResponseOutput = [];
            for (const payload of synthesizePrewarmResponsePayloads(normalized.request)) {
              socket.send(JSON.stringify(payload));
            }
            return;
          }

          if (!shouldReuseSelectedChannel(selectedChannel, requestModel)) {
            selectedChannel = requestModel
              ? await tokenRouter.selectChannel(requestModel, authContext.policy)
              : null;
          }

          const selectedServiceTierPolicy = applyOpenAiServiceTierPolicy({
            body: normalized.request,
            context: {
              requestedModel: requestModel,
              actualModel: asTrimmedString(selectedChannel?.actualModel),
              sitePlatform: asTrimmedString(selectedChannel?.site?.platform),
              accountType: undefined,
            },
            rules: getServiceTierPolicyRules(),
          });
          if (!selectedServiceTierPolicy.ok) {
            writeResponsesWebsocketError(
              socket,
              selectedServiceTierPolicy.statusCode,
              selectedServiceTierPolicy.payload.error.message,
              selectedServiceTierPolicy.payload,
            );
            return;
          }
          normalized.request = selectedServiceTierPolicy.body;
          normalized.nextRequestSnapshot = {
            ...normalized.nextRequestSnapshot,
            service_tier: selectedServiceTierPolicy.body.service_tier,
          };
          if (selectedServiceTierPolicy.body.service_tier === undefined) {
            delete normalized.nextRequestSnapshot.service_tier;
          }
          lastRequest = normalized.nextRequestSnapshot;

          const forwarded = await forwardResponsesRequestViaHttp({
            app,
            socket,
            request,
            payload: normalized.request,
            preserveIncrementalMode: supportsIncrementalInput,
            authToken: authContext.token,
          });
          if (forwarded) {
            lastResponseOutput = forwarded;
          }
        } catch {
          writeResponsesWebsocketError(socket, 500, 'internal websocket proxy error');
        }
      });
  });
}

export function ensureResponsesWebsocketTransport(app: FastifyInstance) {
  if (installedApps.has(app)) return;
  installedApps.add(app);

  const websocketServer = new WebSocketServer({ noServer: true });
  websocketServer.on('headers', (headers, request) => {
    const turnState = headerValueToTrimmedString(request.headers[WS_TURN_STATE_HEADER]);
    if (!turnState) return;
    headers.push(`${WS_TURN_STATE_HEADER}: ${turnState}`);
  });

  app.server.on('upgrade', (request, socket, head) => {
    void (async () => {
      const url = new URL(request.url || '/', 'http://localhost');
      if (url.pathname !== '/v1/responses') return;
      const token = extractWebsocketAuthToken(request, url);
      if (!token) {
        writeUpgradeHttpError(socket, 401, 'Missing Authorization, x-api-key, x-goog-api-key, or key query parameter');
        return;
      }
      const authResult = await authorizeDownstreamToken(token);
      if (!authResult.ok) {
        writeUpgradeHttpError(socket, authResult.statusCode, authResult.error);
        return;
      }
      websocketServer.handleUpgrade(request, socket, head, (client) => {
        void handleResponsesWebsocketConnection(app, client, request, authResult);
      });
    })().catch(() => {
      writeUpgradeHttpError(socket, 500, 'internal websocket proxy error');
    });
  });

  app.addHook('onClose', async () => {
    await new Promise<void>((resolve) => {
      websocketServer.close(() => resolve());
    });
  });
}
