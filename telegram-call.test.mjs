import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramCall } from './telegram-call.mjs';

function setup() {
  const sockets = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    readyState = 0;
    bufferedAmount = 0;
    sent = [];
    constructor(url, options) {
      super();
      this.url = url;
      this.headers = options.headers;
      sockets.push(this);
    }
    open() {
      this.readyState = Socket.OPEN;
      this.dispatchEvent(new Event('open'));
    }
    close() {
      this.readyState = 3;
      this.dispatchEvent(new Event('close'));
    }
    send(value) {
      this.sent.push(typeof value === 'string' ? JSON.parse(value) : value);
    }
    message(value) {
      this.dispatchEvent(new MessageEvent('message', {
        data: value instanceof ArrayBuffer ? value : JSON.stringify(value),
      }));
    }
  }
  const call = new TelegramCall({ apiKey: 'test-key' }, '@example', 'Say hello.',
    { url: 'ws://telegram.example/calls', token: 'bridge-key' }, { WebSocket: Socket });
  return { call, sockets };
}

test('Telegram audio and transcript are relayed only after answer, with shared call controls', async () => {
  const { call, sockets } = setup();
  assert.equal((await call.start()).state, 'dialing');
  const [voice] = sockets;
  voice.open();
  assert.equal(voice.sent[0].type, 'session.start');
  assert.deepEqual(voice.sent[0].session.audio.format, { type: 'audio/pcm', rate: 24000 });
  assert.equal(sockets.length, 1);
  voice.message({ type: 'session.started', session: { id: 'live_test' } });
  const media = sockets[1];
  media.open();
  assert.equal(media.headers.Authorization, 'Bearer bridge-key');
  assert.deepEqual(media.sent, [{ to: '@example' }]);
  voice.message({ type: 'session.output_audio.delta', delta: 'CAABAA==' });
  assert.equal(media.sent.length, 1);
  media.message({ type: 'ringing' });
  assert.equal(call.state, 'ringing');
  media.message({ type: 'answered' });
  assert.equal(call.state, 'answered');
  assert.equal(voice.sent[1].type, 'session.instructions.append');
  assert.equal(voice.sent[2].type, 'session.input_audio.append');
  media.message(Uint8Array.of(1, 0, 2, 0).buffer);
  assert.deepEqual(voice.sent.at(-1), { type: 'session.input_audio.append', audio: 'AQACAA==' });
  voice.message({ type: 'session.output_audio.delta', delta: 'CAABAA==' });
  assert.deepEqual(media.sent.at(-1), Buffer.from([8, 0, 1, 0]));
  voice.message({ type: 'session.input_transcript.delta', delta: 'Hello' });
  voice.message({ type: 'session.delegation.created', delegation: { id: 'd1', target: 'client' } });
  assert.deepEqual(call.snapshot().events.map(event => event.type),
    ['transport.ringing', 'transport.answered', 'transcript', 'decision_requested']);
  call.send('say', 'Nice to meet you.', 'd1');
  assert.equal(voice.sent.at(-1).delegation_id, 'd1');
  assert.throws(() => call.send('dtmf', '1'), /do not have a telephone keypad/);
  assert.equal((await call.hangup()).state, 'ending');
  assert.deepEqual(media.sent.at(-1), { type: 'hangup' });
  media.message({ type: 'ended', reason: 'Remote leg closed.' });
  assert.equal(call.state, 'ended');
  assert.equal(voice.readyState, 3);
});

test('a failed Live startup never opens the Telegram connection', async () => {
  const { call, sockets } = setup();
  await call.start();
  sockets[0].open();
  sockets[0].message({ type: 'error' });
  assert.equal(call.state, 'failed');
  assert.equal(sockets.length, 1);
});

test('lost Telegram signaling after a dial does not report a confirmed end', async () => {
  const { call, sockets } = setup();
  await call.start();
  sockets[0].open();
  sockets[0].message({ type: 'session.started' });
  sockets[1].open();
  sockets[1].close();
  assert.equal(call.state, 'unconfirmed');
});
