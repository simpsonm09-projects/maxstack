// A model-free OpenAI-compatible server for the Pi harness smoke check. It serves only what Pi's
// openai-completions mode calls: GET /v1/models and POST /v1/chat/completions (streamed as SSE when
// the request asks for it). It binds to 127.0.0.1 on an ephemeral port and keeps every request in
// memory, so a caller can assert on what Pi sent.
//
// Every chat request gets one fixed text. No model runs, and nothing is downloaded.
import { createServer } from 'node:http';

export const STUB_HOST = '127.0.0.1';
export const STUB_MODEL_ID = 'stub-1';
export const PLAIN_TEXT = 'PI_SMOKE_PLAIN_ANSWER';

function completionJson(text, model) {
  return {
    id: 'chatcmpl-stub-1',
    object: 'chat.completion',
    created: 0,
    model,
    choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

function completionSse(text, model) {
  const frames = [];
  const chunk = (delta, finishReason = null) => ({
    id: 'chatcmpl-stub-1',
    object: 'chat.completion.chunk',
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
  frames.push(chunk({ role: 'assistant', content: '' }));
  frames.push(chunk({ content: text }));
  frames.push(chunk({}, 'stop'));
  frames.push({
    ...chunk({}),
    choices: [],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  });
  return `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`;
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

// Parses a request body, or returns null when it is not JSON. Only the chat route reads one.
function parseBody(raw) {
  try {
    return raw === '' ? {} : JSON.parse(raw);
  } catch {
    return null;
  }
}

function handleChat(res, record, model) {
  if (record.body === null) return sendJson(res, 400, { error: 'request body is not JSON' });
  if (record.body.stream === true) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    return res.end(completionSse(PLAIN_TEXT, model));
  }
  return sendJson(res, 200, completionJson(PLAIN_TEXT, model));
}

// Starts the stub. The caller must call close() on every path, success or failure.
export async function startStubModelServer({ model = STUB_MODEL_ID } = {}) {
  const requests = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      const path = new URL(req.url ?? '/', `http://${STUB_HOST}`).pathname;
      const record = { method: req.method ?? '', path, body: parseBody(raw) };
      requests.push(record);
      if (req.method === 'GET' && path === '/v1/models') {
        return sendJson(res, 200, {
          object: 'list',
          data: [{ id: model, object: 'model', created: 0, owned_by: 'stub' }],
        });
      }
      if (req.method === 'POST' && path === '/v1/chat/completions')
        return handleChat(res, record, model);
      return sendJson(res, 404, { error: 'not found' });
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, STUB_HOST, resolve);
  });
  const { port } = server.address();
  return {
    baseUrl: `http://${STUB_HOST}:${port}/v1`,
    port,
    model,
    requests,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
