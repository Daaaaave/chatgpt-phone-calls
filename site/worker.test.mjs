import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteWorker } from './worker.mjs';

function rpc(worker, env, id, method, params, modern = false) {
  const version = '2026-07-28';
  return worker.fetch(new Request('https://site.example/mcp', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...(id ? { 'oai-authenticated-user-id': id } : {}),
      ...(modern ? { 'MCP-Protocol-Version': version, 'Mcp-Method': method } : {}),
      ...(modern && params?.name ? { 'Mcp-Name': params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: modern ? {
      ...params,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': version,
        'io.modelcontextprotocol/clientInfo': { name: 'test', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    } : params }),
  }), env).then(result => result.json()).then(result => result.result);
}

test('only the configured Site owner can reach the authenticated relay', async () => {
  let calls = 0;
  const worker = createSiteWorker((url, options) => {
    calls += 1;
    assert.equal(url, 'https://relay.example/status');
    assert.equal(options.headers.Authorization, 'Bearer fixture-token');
    return Response.json({ busy: false });
  });
  const env = { RINGER_SITE_OWNER_ID: 'owner-fixture', RINGER_CLOUD_ORIGIN: 'https://relay.example', RINGER_CLOUD_TOKEN: 'fixture-token' };
  for (const modern of [false, true]) {
    for (const id of [undefined, 'visitor-fixture']) {
      assert.equal((await rpc(worker, env, id, 'tools/call', { name: 'ringer_status' }, modern)).isError, true);
    }
    assert.equal((await rpc(worker, env, 'owner-fixture', 'tools/call', { name: 'ringer_status' }, modern)).isError, false);
  }
  assert.equal(calls, 2);
});

test('modern Sites clients can discover the server and list the same tools', async () => {
  const worker = createSiteWorker(() => assert.fail('Discovery must not consult the relay'));
  const discovery = await rpc(worker, {}, null, 'server/discover', {}, true);
  assert.ok(discovery.supportedVersions.includes('2026-07-28'));
  assert.ok(discovery.capabilities.tools);
  const legacy = await rpc(worker, {}, null, 'tools/list', {});
  const modern = await rpc(worker, {}, null, 'tools/list', {}, true);
  assert.deepEqual(modern.tools.map(tool => tool.name), legacy.tools.map(tool => tool.name));
});

test('both local and hosted MCP opt into the scoped messaging surface', async () => {
  const worker = createSiteWorker(() => assert.fail('Discovery must not consult the relay'));
  const disabled = await rpc(worker, {}, null, 'tools/list', {});
  const enabled = await rpc(worker, { RINGER_TELEGRAM_MESSAGING: '1' }, null, 'tools/list', {});
  assert.ok(!disabled.tools.some(tool => tool.name === 'telegram_send'));
  assert.ok(enabled.tools.some(tool => tool.name === 'telegram_read'));
  assert.ok(enabled.tools.some(tool => tool.name === 'telegram_send'));
  assert.ok(!enabled.tools.some(tool => tool.name === 'telegram_delete'));
});
