import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { LiveCall, loadConfig, model, withCallerId } from './live.mjs';
import { TelegramCall } from './telegram-call.mjs';
import { requestRelay } from './relay-client.mjs';
import { callerSetting } from './settings.mjs';

const host = '127.0.0.1';
const port = 47831;
const origin = `http://${host}:${port}`;
const help = `Caller controls for ${model}
  node --env-file-if-exists=.env caller.mjs serve
  node caller.mjs status
  node caller.mjs telegram-status
  node caller.mjs call E164_NUMBER "Call purpose and allowed decisions" [default|alternate]
  node caller.mjs telegram-call @username "Call purpose and allowed decisions"
  node caller.mjs events CALL_ID [CURSOR]
  node caller.mjs watch CALL_ID [CURSOR] [all|important]
  node caller.mjs steer CALL_ID "Updated instructions"
  node caller.mjs say CALL_ID "Information to relay" [DELEGATION_ID]
  node caller.mjs dtmf CALL_ID 2
  node caller.mjs hangup CALL_ID`;

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const size = Number(req.headers['content-length']);
  if (req.headers['content-type'] !== 'application/json' || !Number.isSafeInteger(size) || size < 2 || size > 16_384) {
    throw new Error('Expected a JSON body of at most 16 KB.');
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = JSON.parse(Buffer.concat(chunks));
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Expected a JSON object.');
  return body;
}

export function createCaller(config, options, { cloudToken, telegram, telegramBridge, telegramMessaging = false } = {}) {
  const expected = cloudToken && Buffer.from(`Bearer ${cloudToken}`);
  let call;
  let starting;
  let stopping = false;
  const requests = new Map();
  const server = createServer(async (req, res) => {
    const localHost = `${host}:${req.socket.localPort}`;
    if (expected) {
      const actual = Buffer.from(req.headers.authorization ?? '');
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        return json(res, 401, { error: 'Unauthorized.' });
      }
    } else if (req.headers.host !== localHost || req.headers.origin || req.headers['sec-fetch-site']) {
      return json(res, 403, { error: 'Use the local Caller CLI.' });
    }
    try {
      const url = new URL(req.url, `http://${localHost}`);
      const tg = url.pathname.match(/^\/telegram\/(status|peers|read|send)$/);
      if (req.method === 'POST' && tg) {
        const body = await readJson(req);
        if (tg[1] !== 'status' && !telegramMessaging) return json(res, 403, { error: 'Telegram messaging is disabled.' });
        if (!telegram) return json(res, 200, tg[1] === 'status'
          ? { connected: false, native_calls: false }
          : { error: 'The Telegram service is not configured.' });
        return json(res, 200, await telegram(tg[1], body));
      }
      if (call?.finishedAt && Date.now() - call.finishedAt > 15 * 60_000) call = undefined;
      if (req.method === 'GET' && url.pathname === '/status') {
        const latest = call ? { id: call.id, state: call.state, cursor: call.cursor } : null;
        const caller_ids = !config.trunk ? [] : config.alternateCallerNumber ? ['default', 'alternate'] : ['default'];
        return json(res, 200, { model, busy: call?.active ?? false, latest, caller_ids,
          dial_prefixes: config.dialPrefixes ?? [], telegram_configured: Boolean(telegramBridge) });
      }
      if (req.method === 'POST' && url.pathname === '/calls') {
        const { number, brief, requestId, callerId, telegramPeer } = await readJson(req);
        if (requestId !== undefined) {
          if (typeof requestId !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(requestId)) {
            throw new Error('Invalid request ID.');
          }
          const previousId = requests.get(requestId);
          if (previousId) {
            if (previousId === call?.id) {
              const previousCall = call;
              await starting;
              return json(res, 200, previousCall.snapshot(previousCall.cursor));
            }
            return json(res, 409, { error: 'This request already started a call and cannot be redialed.', id: previousId });
          }
        }
        if (stopping) return json(res, 503, { error: 'Caller is shutting down.' });
        if (call?.active) return json(res, 409, { error: 'A call is already running.' });
        if (telegramPeer !== undefined) {
          if (number !== undefined || callerId !== undefined) throw new Error('Choose either Telegram or a telephone destination.');
          if (!telegramBridge) throw new Error('Telegram calls are not configured.');
          call = new TelegramCall(config, telegramPeer, brief, telegramBridge, { ...options, id: requestId });
        } else {
          call = new LiveCall(withCallerId(config, callerId), number, brief, { ...options, id: requestId });
        }
        if (requestId) {
          requests.set(requestId, call.id);
          if (requests.size > 1000) requests.delete(requests.keys().next().value);
        }
        starting = call.start();
        return json(res, 200, await starting);
      }
      const match = url.pathname.match(/^\/calls\/([\da-f-]+)(?:\/(steer|say|dtmf|hangup))?$/);
      if (!match || !call || match[1] !== call.id) return json(res, 404, { error: 'Call not found.' });
      const [, , action] = match;
      // Capture the call before awaiting request I/O.
      const current = call;
      if (req.method === 'GET' && !action) {
        const after = Number(url.searchParams.get('after') ?? '0');
        if (!Number.isSafeInteger(after) || after < 0 || after > current.cursor) throw new Error('Invalid event cursor.');
        const waitMs = Number(url.searchParams.get('wait_ms') ?? 0);
        if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 12_000) throw new Error('Invalid wait duration.');
        const mode = url.searchParams.get('wait_for') ?? 'all';
        if (!['all', 'important'].includes(mode)) throw new Error('Invalid wait mode.');
        const abort = new AbortController();
        const disconnected = () => abort.abort();
        res.once('close', disconnected);
        try {
          const result = await current.waitForEvents(after, { waitMs, important: mode === 'important', signal: abort.signal });
          if (!res.destroyed) return json(res, 200, result);
          return;
        } finally {
          res.off('close', disconnected);
        }
      }
      if (req.method === 'POST' && action === 'hangup') {
        return json(res, 200, await current.hangup());
      }
      if (req.method === 'POST' && action) {
        const { text, delegationId } = await readJson(req);
        return json(res, 200, current.send(action, text, delegationId));
      }
      return json(res, 405, { error: 'Unsupported method.' });
    } catch (error) {
      return json(res, 400, { error: error instanceof SyntaxError ? 'Invalid JSON.' : error.message });
    }
  });
  return {
    server,
    async stop() {
      stopping = true;
      await starting;
      try {
        if (call?.active || call?.state === 'unconfirmed') await call.hangup();
      } finally {
        server.close();
      }
    },
  };
}

async function request(path, body) {
  let data;
  try {
    data = await requestRelay(path, body);
  } catch {
    throw new Error('Caller is unavailable or timed out. Check the local server and call status before retrying.');
  }
  if (data.error) throw new Error(data.error);
  return data;
}

async function main([command, id, value, delegationId]) {
  if (!command || command === '--help' || command === 'help') return console.log(help);
  if (command === 'serve') {
    const { server, stop } = createCaller(loadConfig(process.env));
    const shutdown = () => {
      stop().catch(error => { console.error(error.message); process.exitCode = 1; });
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
    server.on('error', error => { console.error(error.message); process.exitCode = 1; });
    server.listen(port, host, () => console.log(`Caller listening on ${origin}.`));
    return;
  }
  let result;
  switch (command) {
    case 'status':
      result = await request('/status');
      break;
    case 'telegram-status':
      result = await request('/telegram/status', {});
      break;
    case 'telegram-call':
      result = await request('/calls', { telegramPeer: id, brief: value, requestId: crypto.randomUUID() });
      break;
    case 'call':
      result = await request('/calls', { number: id, brief: value, callerId: delegationId });
      break;
    case 'events':
    case 'watch': {
      const params = new URLSearchParams({ after: value ?? '0' });
      if (command === 'watch') {
        params.set('wait_ms', '12000');
        params.set('wait_for', delegationId ?? 'all');
      }
      result = await request(`/calls/${encodeURIComponent(id)}?${params}`);
      break;
    }
    case 'hangup':
    case 'steer':
    case 'say':
    case 'dtmf':
      result = await request(`/calls/${encodeURIComponent(id)}/${command}`, { text: value, delegationId });
      break;
    default:
      throw new Error(`Unknown command: ${command}. Run node caller.mjs --help.`);
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.state === 'failed' || result.state === 'unconfirmed') process.exitCode = 1;
}

export function serveCloud(env = process.env, bindAddress = '0.0.0.0') {
  const cloudToken = callerSetting(env, 'CALLER_CLOUD_TOKEN');
  const telegramOrigin = callerSetting(env, 'CALLER_TELEGRAM_ORIGIN');
  const telegramToken = callerSetting(env, 'CALLER_TELEGRAM_TOKEN');
  if (!/^[a-f0-9]{64}$/.test(cloudToken ?? '')) throw new Error('Missing or invalid CALLER_CLOUD_TOKEN.');
  const telegram = telegramOrigin && /^[a-f0-9]{64}$/.test(telegramToken ?? '')
    ? async (operation, body) => {
      const response = await fetch(new URL('/' + operation, telegramOrigin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${telegramToken}` },
        body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(7500),
      });
      if (!response.ok) return { error: 'The Telegram service did not confirm the operation.' };
      return response.json();
    }
    : undefined;
  let telegramBridge;
  if (telegram && callerSetting(env, 'CALLER_TELEGRAM_CALLS') === '1') {
    const url = new URL('/calls', telegramOrigin);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid Telegram bridge protocol.');
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    telegramBridge = { url: url.href, token: telegramToken, status: () => telegram('status', {}) };
  }
  const { server, stop } = createCaller(loadConfig(env), undefined, { cloudToken, telegram, telegramBridge,
    telegramMessaging: callerSetting(env, 'CALLER_TELEGRAM_MESSAGING') === '1' });
  const shutdown = () => stop().catch(() => { process.exitCode = 1; });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, shutdown);
  server.listen(Number(env.PORT ?? '8080'), bindAddress);
}

export function runCli() {
  return main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runCli();
}
