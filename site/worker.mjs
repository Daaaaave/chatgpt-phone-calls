import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createMcpHandler, isLegacyRequest, McpServer } from '@modelcontextprotocol/server';
import { createMcp } from '../mcp.mjs';

const maxRequestBodySize = 16_384;

function createRelayRequest(env, relayFetch = fetch) {
  return async (path, body) => {
    if (!env.RINGER_CLOUD_ORIGIN || !env.RINGER_CLOUD_TOKEN) {
      if (path === '/status') return { ready: false, reason: 'The cloud voice service is not connected.' };
      throw new Error('The cloud voice service is not connected.');
    }
    const origin = new URL(env.RINGER_CLOUD_ORIGIN);
    if (origin.protocol !== 'https:' || origin.origin !== env.RINGER_CLOUD_ORIGIN) {
      throw new Error('Invalid cloud voice service configuration.');
    }
    if (path === '/calls' && body?.requestId) {
      const now = Date.now();
      await env.DB.prepare('CREATE TABLE IF NOT EXISTS dial_requests (id TEXT PRIMARY KEY, created INTEGER NOT NULL)').run();
      await env.DB.prepare('DELETE FROM dial_requests WHERE created < ?').bind(now - 86_400_000).run();
      const claim = await env.DB.prepare('INSERT INTO dial_requests (id, created) VALUES (?, ?) ON CONFLICT DO NOTHING RETURNING id')
        .bind(body.requestId, now).first();
      if (!claim) {
        return { id: body.requestId, state: 'previous_request', message: 'This request was already submitted. Use get_call with this ID. Do not redial automatically.' };
      }
    }
    try {
      const response = await relayFetch(origin.origin + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Authorization: `Bearer ${env.RINGER_CLOUD_TOKEN}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(path === '/calls' ? 23_000 : path.includes('&wait_ms=') ? 15_000 : 9_000),
      });
      if ((response.status >= 300 && response.status < 400) || response.status === 401 || response.status >= 500) {
        throw new Error('Relay unavailable');
      }
      const result = await response.json();
      return path === '/status' && response.ok ? { ready: true, ...result } : result;
    } catch {
      if (path === '/status') return { ready: false, reason: 'The cloud voice service did not respond.' };
      if (path === '/calls') return { id: body.requestId, state: 'unconfirmed', message: 'Check get_call before retrying. A call may have started.' };
      throw new Error('The cloud voice service did not respond.');
    }
  };
}

export function createSiteWorker(relayFetch) {
  return {
    async fetch(request, env) {
      const { pathname } = new URL(request.url);
      if (pathname === '/' && request.method === 'GET') {
        return new Response('Private ChatGPT Phone Calls connector. Open the associated plugin to call.', {
          headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      if (pathname !== '/mcp') return new Response('Not found.', { status: 404 });
      // Sites supplies this identity. Do not deploy this worker outside the trusted Sites gateway.
      const requestRelay = env.RINGER_SITE_OWNER_ID && request.headers.get('oai-authenticated-user-id') === env.RINGER_SITE_OWNER_ID
        ? createRelayRequest(env, relayFetch)
        : () => { throw new Error('Connect the plugin with the configured Site owner account.'); };
      const options = { telegramMessaging: env.RINGER_TELEGRAM_MESSAGING === '1' };
      if (await isLegacyRequest(request, undefined, { maxRequestBodySize })) {
        const server = createMcp(requestRelay, options);
        const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true, maxRequestBodySize });
        await server.connect(transport);
        return transport.handleRequest(request);
      }
      const handler = createMcpHandler(() => createMcp(requestRelay, { ...options, Server: McpServer }), {
        legacy: 'reject', maxRequestBodySize,
      });
      return handler.fetch(request);
    },
  };
}

export default createSiteWorker();
