import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { LiveCall, LiveConversation, loadConfig, withCallerId } from './live.mjs';
import { createRinger } from './ringer.mjs';

const config = {
  apiKey: 'test-key',
  dialPrefixes: ['+1', '+44'],
  trunk: {
    provider_url: 'sips:test.example.com:5061', caller_number: '+14155550100',
    auth: { type: 'digest', username: 'test-user', password: 'test-password' },
  },
};

test('Telegram-only configuration does not need SIP credentials', () => {
  const telegramOnly = loadConfig({ OPENAI_API_KEY: 'test-key' });
  assert.equal(telegramOnly.trunk, undefined);
  assert.throws(() => withCallerId(telegramOnly), /Telephone calls are not configured/);
  assert.throws(() => loadConfig({ OPENAI_API_KEY: 'test-key', RINGER_CALLER_NUMBER: '+17545550100' }),
    /Missing settings/);
});

test('telephone setup requires explicit prefixes and deduplicates them', () => {
  const env = {
    OPENAI_API_KEY: 'test-key', RINGER_SIP_URL: 'sips:sip.example.com:5061',
    RINGER_SIP_USERNAME: 'test-user', RINGER_SIP_PASSWORD: 'test-password',
    RINGER_CALLER_NUMBER: '+447700900100',
  };
  assert.throws(() => loadConfig(env), /RINGER_ALLOWED_DIAL_PREFIXES/);
  assert.throws(() => loadConfig({ ...env, RINGER_ALLOWED_DIAL_PREFIXES: '+44,*' }), /RINGER_ALLOWED_DIAL_PREFIXES/);
  assert.deepEqual(loadConfig({ ...env, RINGER_ALLOWED_DIAL_PREFIXES: '+44, +1, +44' }).dialPrefixes, ['+44', '+1']);
});

test('the release relay blocks Telegram messaging even for authenticated clients', async t => {
  const { server, stop } = createRinger(config, {}, {
    cloudToken: 'test-token',
    telegram: () => assert.fail('Messaging request forwarded to Telegram'),
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(stop);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/telegram/read`, {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json' },
    body: '{}',
  });
  assert.equal(response.status, 403);
});

class FakeSocket extends EventTarget {
  static OPEN = 1;
  readyState = 0;
  commands = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
  }

  open() {
    this.readyState = FakeSocket.OPEN;
    this.dispatchEvent(new Event('open'));
  }

  send(raw) { this.commands.push(JSON.parse(raw)); }

  close() {
    this.readyState = 3;
    this.dispatchEvent(new Event('close'));
  }

  emit(data) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(data) }));
  }
}

function fakeProvider() {
  const provider = { requests: [] };
  provider.options = {
    WebSocket: class extends FakeSocket {
      constructor(url, options) {
        super(url, options);
        provider.socket = this;
        queueMicrotask(() => this.open());
      }
    },
    async fetch(url, options) {
      provider.requests.push({ url, options });
      if (url.endsWith('/hangup')) {
        provider.socket?.emit({ type: 'session.closed', reason: 'close_requested' });
        return new Response();
      }
      return Response.json({ session: { id: 'live_test' }, transport: { type: 'sip' } });
    },
  };
  return provider;
}

test('call flow allows the chat to react to phone speech and delegation', async t => {
  const provider = fakeProvider();
  const { server, stop } = createRinger(config, provider.options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(stop);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(origin + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await post('/calls', { number: '+61255500100', brief: 'Test' })).status, 400);
  assert.equal((await post('/calls', { number: '+18005', brief: 'Test' })).status, 400);
  const unavailable = await post('/calls', { number: '+447700900100', brief: 'Test', callerId: 'alternate' });
  assert.equal(unavailable.status, 400);
  assert.match((await unavailable.json()).error, /not configured/);
  assert.equal(provider.requests.length, 0);
  assert.equal((await fetch(origin + '/status', { headers: { Origin: 'https://example.com' } })).status, 403);

  const newCall = () => post('/calls', { number: '+447700900100', brief: 'Book a table.' });
  const [first, second] = await Promise.all([newCall(), newCall()]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409]);
  const { id, cursor, state, answered } = await (first.ok ? first : second).json();
  assert.deepEqual({ state, answered }, { state: 'dialing', answered: false });
  assert.equal(provider.requests.length, 1);
  const payload = JSON.parse(provider.requests[0].options.body);
  assert.equal(payload.session.model, 'gpt-live-1.1');
  assert.equal(payload.session.delegation.type, 'client');
  assert.equal(payload.session.store, false);
  assert.equal(payload.transport.destination, '+447700900100');
  assert.equal(payload.transport.trunk.caller_number, config.trunk.caller_number);
  assert.equal(provider.socket.url, 'wss://api.openai.com/v1/live/sessions/live_test/attach');
  assert.equal(provider.socket.options.headers.Authorization, 'Bearer test-key');

  const path = `/calls/${id}`;
  assert.equal((await post(path + '/say', { text: 'Too early' })).status, 400);
  provider.socket.emit({ type: 'transport.answered', event_id: 'answered' });
  const watch = fetch(`${origin}${path}?after=${cursor}&wait_ms=12000&wait_for=important`);
  const transcript = { type: 'session.input_transcript.delta', delta: 'Only 20:00.', event_id: 't1' };
  provider.socket.emit(transcript);
  provider.socket.emit(transcript);
  provider.socket.emit({
    type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' },
  });
  const snapshot = await (await watch).json();
  assert.equal(snapshot.state, 'answered');
  assert.deepEqual(snapshot.events.map(event => event.type), ['transport.answered', 'transcript', 'decision_requested']);
  assert.equal(snapshot.events[1].text, 'Only 20:00.');
  assert.equal(snapshot.events[2].transcriptTail[0].text, 'Only 20:00.');
  assert.equal(snapshot.events[2].delegationId, 'd1');

  const spoken = await (await post(path + '/say', { text: '20:00 works.', delegationId: 'd1' })).json();
  const steer = await (await post(path + '/steer', { text: 'Repeat the date.' })).json();
  const keypad = await (await post(path + '/dtmf', { text: '2' })).json();
  assert.deepEqual(provider.socket.commands, [
    { type: 'session.commentary.append', content: '20:00 works.', delegation_id: 'd1', event_id: spoken.commandId },
    { type: 'session.instructions.append', content: 'Repeat the date.', delegation_id: null, event_id: steer.commandId },
    { type: 'transport.dtmf.send', event: '2', event_id: keypad.commandId },
  ]);
  provider.socket.emit({ type: 'transport.dtmf.sent', client_event_id: keypad.commandId });
  assert.equal((await (await post(path + '/hangup', {})).json()).state, 'ended');
  assert.equal(provider.requests.at(-1).url, 'https://api.openai.com/v1/live/sessions/live_test/hangup');
  const final = await (await fetch(`${origin}${path}?after=${snapshot.cursor}`)).json();
  assert.deepEqual(final.events.map(event => event.type), ['transport.dtmf.sent', 'call_finished']);
  assert.ok(final.events[0].commandAckMs >= 0);
});

test('event waits wake on decisions while keeping transcript cursors lossless', async () => {
  const call = new LiveConversation();
  const signal = new AbortController().signal;
  const wait = call.waitForEvents(0, { waitMs: 500, important: true, signal });
  call.handleEvent({ type: 'session.input_transcript.delta', delta: 'Only Thursday', start_ms: 1, end_ms: 100 });
  call.handleEvent({ type: 'session.input_transcript.delta', delta: ' works.', start_ms: 101, end_ms: 200 });
  assert.equal(call.waiters.size, 1);
  const event = { type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' } };
  call.handleEvent(event);
  call.handleEvent(event);
  const snapshot = await wait;
  assert.equal(call.waiters.size, 0);
  assert.equal(call.cursor, 3);
  assert.deepEqual(snapshot.events.map(e => e.type), ['transcript', 'transcript', 'decision_requested']);
  assert.deepEqual(snapshot.events[2].transcriptTail, [
    { speaker: 'recipient', text: 'Only Thursday works.', startMs: 1, endMs: 200 },
  ]);
  const result = await call.waitForEvents(snapshot.cursor, { waitMs: 1, important: true, signal });
  assert.equal(result.cursor, snapshot.cursor);
  assert.equal(call.waiters.size, 0);
});

test('aborted listeners are removed and call completion releases important waits', async () => {
  const call = new LiveConversation();
  const abort = new AbortController();
  const cancelled = call.waitForEvents(0, { waitMs: 500, important: false, signal: abort.signal });
  abort.abort();
  assert.equal(await cancelled, undefined);
  assert.equal(call.waiters.size, 0);
  const done = call.waitForEvents(0, { waitMs: 500, important: true, signal: new AbortController().signal });
  call.finish('ended', 'Test finished');
  assert.equal((await done).events[0].type, 'call_finished');
});

test('a +1 toll-free call can select the alternate caller ID without changing the default', async t => {
  const provider = fakeProvider();
  const alternateCallerNumber = '+17545550100';
  const { server, stop } = createRinger({ ...config, alternateCallerNumber }, provider.options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(stop);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const status = await (await fetch(origin + '/status')).json();
  assert.deepEqual(status.caller_ids, ['default', 'alternate']);
  const start = callerId => fetch(origin + '/calls', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ number: '+18005550100', brief: 'Test', callerId }),
  });
  assert.equal((await start('+17545550123')).status, 400);
  assert.equal(provider.requests.length, 0);
  const first = await start('alternate');
  assert.equal(first.status, 200);
  const { id } = await first.json();
  const alternate = JSON.parse(provider.requests[0].options.body);
  assert.equal(alternate.transport.destination, '+18005550100');
  assert.equal(alternate.transport.trunk.caller_number, alternateCallerNumber);
  await fetch(origin + '/calls/' + id + '/hangup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  assert.equal((await start()).status, 200);
  const defaultCall = JSON.parse(provider.requests.at(-1).options.body);
  assert.equal(defaultCall.transport.trunk.caller_number, config.trunk.caller_number);
});

test('a repeated plugin request does not dial twice', async t => {
  const provider = fakeProvider();
  const { server, stop } = createRinger(config, provider.options);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(stop);
  const url = `http://127.0.0.1:${server.address().port}/calls`;
  const body = JSON.stringify({ number: '+447700900100', brief: 'Test', requestId: 'e944c8a5-9268-4294-a22e-39ce127dbac4' });
  const post = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).then(r => r.json());
  const [first, repeated] = await Promise.all([post(), post()]);
  assert.equal(first.id, repeated.id);
  assert.equal(provider.requests.length, 1);
});

test('sideband disconnect triggers a hangup', async () => {
  const provider = fakeProvider();
  const call = new LiveCall(config, '+447700900100', 'Test', provider.options);
  await call.start();
  provider.socket.close();
  await call.hangingUp;
  assert.equal(call.state, 'ended');
  assert.equal(provider.requests.length, 2);
});

test('a missed handoff is advisory and can be recovered without a delegation ID', async () => {
  const provider = fakeProvider();
  const call = new LiveCall(config, '+447700900100', 'Test', { ...provider.options, handoffWaitMs: 5 });
  await call.start();
  provider.socket.emit({ type: 'transport.answered' });
  provider.socket.emit({ type: 'session.output_transcript.delta', delta: 'One moment. I\u2019ll ask' });
  provider.socket.emit({ type: 'session.output_transcript.delta', delta: ' Alex for the reference.' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(call.events.filter(event => event.type === 'possible_missed_handoff').length, 1);
  assert.equal(provider.socket.commands.length, 0);
  const command = call.send('say', 'The reference is 739.');
  assert.deepEqual(provider.socket.commands, [
    { type: 'session.commentary.append', delegation_id: null, content: 'The reference is 739.', event_id: command.commandId },
  ]);
  await call.hangup();
});

test('ordinary questions and real delegations do not cause a missed-handoff alert', async () => {
  const provider = fakeProvider();
  const call = new LiveCall(config, '+447700900100', 'Test', { ...provider.options, handoffWaitMs: 5 });
  await call.start();
  provider.socket.emit({ type: 'transport.answered' });
  provider.socket.emit({ type: 'session.output_transcript.delta', delta: "I'll ask you one question." });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(call.events.some(event => event.type === 'possible_missed_handoff'), false);
  provider.socket.emit({ type: 'session.output_transcript.delta', delta: " I'll check with Alex." });
  provider.socket.emit({ type: 'session.delegation.created', delegation: { id: 'request', target: 'client' } });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(call.events.some(event => event.type === 'possible_missed_handoff'), false);
  await call.hangup();
});

test('the recipient requirement and a missing answer together can raise an advisory', async () => {
  const provider = fakeProvider();
  const call = new LiveCall(config, '+447700900100', 'Test', { ...provider.options, handoffWaitMs: 5 });
  await call.start();
  provider.socket.emit({ type: 'transport.answered' });
  provider.socket.emit({ type: 'session.output_transcript.delta', delta: "I don't have it yet.", start_ms: 100, end_ms: 300 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(call.events.some(event => event.type === 'possible_missed_handoff'), false);
  provider.socket.emit({ type: 'session.input_transcript.delta', delta: 'The reference is mandatory.', start_ms: 3000, end_ms: 3500 });
  provider.socket.emit({ type: 'session.output_transcript.delta', delta: "I don't have that reference.", start_ms: 4000, end_ms: 4400 });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(call.events.filter(event => event.type === 'possible_missed_handoff').length, 1);
  assert.equal(provider.socket.commands.length, 0);
  await call.hangup();
});

test('a spoken keypad menu is surfaced without pressing a key', async () => {
  const provider = fakeProvider();
  const call = new LiveCall(config, '+447700900100', 'Test', { ...provider.options, handoffWaitMs: 5 });
  await call.start();
  provider.socket.emit({ type: 'transport.answered' });
  provider.socket.emit({ type: 'session.input_transcript.delta', delta: 'For a new inquiry, press one. For an existing inquiry, press' });
  provider.socket.emit({ type: 'session.input_transcript.delta', delta: ' two.' });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(call.events.find(event => event.type === 'possible_missed_handoff')?.kind, 'keypad');
  assert.equal(provider.socket.commands.length, 0);
  await call.hangup();
});

test('the cloud relay requires its service credential before reading or dialing', async t => {
  const provider = fakeProvider();
  const { server, stop } = createRinger(config, provider.options, { cloudToken: 'test-token' });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(stop);
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(origin + '/status')).status, 401);
  const headers = { Authorization: 'Bearer test-token' };
  assert.equal((await fetch(origin + '/status', { headers })).status, 200);
  assert.equal(provider.requests.length, 0);
});

test('uncertain create response is not retried', async () => {
  let requests = 0;
  const call = new LiveCall(config, '+447700900100', 'Test', {
    async fetch() { requests++; return new Response(null, { status: 504 }); },
  });
  assert.equal((await call.start()).state, 'unconfirmed');
  assert.equal(requests, 1);
});

test('Node WebSocket sends the authorization header used by sideband', async t => {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const upgrade = once(server, 'upgrade');
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}`, { headers: { Authorization: 'Bearer test-key' } });
  await Promise.race([upgrade.then(([req, connection]) => {
    connection.destroy();
    assert.equal(req.headers.authorization, 'Bearer test-key');
  }), once(socket, 'error').then(() => { throw new Error('WebSocket failed before upgrade'); })]);
});
