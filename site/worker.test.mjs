import test from 'node:test';
import assert from 'node:assert/strict';
import { createSiteWorker } from './worker.mjs';

function rpc(worker, env, id, method, params) {
  return worker.fetch(new Request('https://site.example/mcp', {
    method: 'POST',
    headers: {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      ...(id ? { 'oai-authenticated-user-id': id } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
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
  for (const id of [undefined, 'visitor-fixture']) {
    assert.equal((await rpc(worker, env, id, 'tools/call', { name: 'ringer_status' })).isError, true);
  }
  assert.equal((await rpc(worker, env, 'owner-fixture', 'tools/call', { name: 'ringer_status' })).isError, false);
  assert.equal(calls, 1);
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
