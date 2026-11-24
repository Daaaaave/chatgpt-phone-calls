import { liveSession, LiveConversation } from './live.mjs';
import { telegramTarget } from './dialing.mjs';

const primaryUrl = 'wss://api.openai.com/v1/live/sessions';
const pcmRate = 24000;
const maxBufferedBytes = pcmRate * 2 * 3;
const silentFrame = Buffer.alloc(pcmRate * 2 / 50);

function parseEvent(data) {
  if (typeof data !== 'string') return;
  try { return JSON.parse(data); } catch { return undefined; }
}

export class TelegramCall extends LiveConversation {
  constructor(config, target, brief, bridge, options = {}) {
    super({ ...options, keypad: false });
    if (typeof target !== 'string' || !telegramTarget.test(target)) {
      throw new Error('Use a Telegram @username or a positive user ID from the chat list.');
    }
    this.session = liveSession(brief, { keypad: false });
    this.session.audio.format = { type: 'audio/pcm', rate: pcmRate };
    this.session.input[0].content[0].text = `Wait until told the recipient has answered before speaking. Authorized call brief:\n${brief.trim()}`;
    this.headers = { Authorization: `Bearer ${config.apiKey}` };
    this.target = target;
    this.bridge = bridge;
  }

  async start() {
    if (this.bridge.status) {
      const status = await this.bridge.status().catch(() => null);
      if (!this.active) return this.snapshot();
      if (!status?.connected || !status.native_calls) {
        this.finish('failed', 'Telegram calling is unavailable. Check telegram_status. No call was started.');
        return this.snapshot();
      }
    }
    try {
      this.socket = new this.WebSocket(primaryUrl, { headers: this.headers });
      this.socket.addEventListener('open', () => {
        if (!this.active) return;
        this.socket.send(JSON.stringify({ type: 'session.start', session: this.session }));
        this.session = undefined;
      });
      this.socket.addEventListener('message', ({ data }) => this.onVoice(parseEvent(data)));
      const voiceLost = () => this.voiceLost('The Live voice session disconnected.');
      this.socket.addEventListener('error', voiceLost);
      this.socket.addEventListener('close', voiceLost);
      this.attachTimer = setTimeout(() => this.voiceLost('The Live voice session did not start.'), 10_000);
      this.startLimit();
    } catch {
      this.finish('failed', 'The Live voice session could not open. No Telegram call was started.');
    }
    return this.snapshot();
  }

  onVoice(event) {
    if (!event || !this.active || this.state === 'ending') return;
    if (event.type === 'session.started' && !this.media) {
      clearTimeout(this.attachTimer);
      this.startTelegram();
    } else if (event.type === 'error' && !this.media) {
      this.voiceLost('Live rejected the voice session.');
    } else if (event.type === 'session.closed') {
      this.voiceLost('The Live voice session closed.');
    } else if (this.state === 'answered') {
      if (event.type === 'session.output_audio.delta' && typeof event.delta === 'string') {
        const pcm = Buffer.from(event.delta, 'base64');
        if (pcm.length && this.media?.readyState === this.WebSocket.OPEN) {
          if (this.media.bufferedAmount + pcm.length > maxBufferedBytes) {
            this.voiceLost('The Telegram audio connection could not keep up.');
          } else {
            this.media.send(pcm);
          }
        }
      } else {
        this.handleEvent(event);
      }
    }
  }

  startTelegram() {
    try {
      this.media = new this.WebSocket(this.bridge.url, { headers: { Authorization: `Bearer ${this.bridge.token}` } });
      this.media.binaryType = 'arraybuffer';
      this.media.addEventListener('open', () => {
        if (!this.active) return;
        clearTimeout(this.attachTimer);
        this.media.send(JSON.stringify({ to: this.target }));
        this.attempted = true;
      });
      this.media.addEventListener('message', ({ data }) => this.onTelegram(data));
      const mediaLost = () => {
        if (!this.active) return;
        this.finish(this.attempted ? 'unconfirmed' : 'failed', 'The Telegram connection closed without a final call status.');
      };
      this.media.addEventListener('error', mediaLost);
      this.media.addEventListener('close', mediaLost);
      this.attachTimer = setTimeout(mediaLost, 8000);
    } catch {
      this.finish('failed', 'The Telegram bridge could not open.');
    }
  }

  onTelegram(data) {
    if (!this.active) return;
    if (data instanceof ArrayBuffer) {
      if (this.state === 'answered') this.sendAudio(Buffer.from(data));
      return;
    }
    const event = parseEvent(data);
    if (event?.type === 'ringing' && this.state === 'dialing') {
      this.handleEvent({ type: 'transport.ringing' });
    } else if (event?.type === 'answered' && ['dialing', 'ringing'].includes(this.state)) {
      this.handleEvent({ type: 'transport.answered' });
      this.send('steer', 'The recipient has answered. Greet them now.');
      this.sendAudio(silentFrame);
    } else if (['ended', 'failed', 'unconfirmed'].includes(event?.type)) {
      this.finish(event.type, this.stopReason ?? event.reason);
    }
  }

  sendAudio(pcm) {
    if (this.socket?.readyState !== this.WebSocket.OPEN) return;
    if (this.socket.bufferedAmount + pcm.length > maxBufferedBytes) {
      this.voiceLost('The Live audio connection could not keep up.');
      return;
    }
    this.socket.send(JSON.stringify({ type: 'session.input_audio.append', audio: pcm.toString('base64') }));
  }

  voiceLost(reason) {
    if (!this.active || this.state === 'ending') return;
    this.stopReason = reason;
    if (this.attempted) void this.hangup();
    else this.finish('failed', `${reason} No Telegram call was started.`);
  }

  async hangup() {
    if (!this.active || this.state === 'ending') return this.snapshot(this.cursor);
    if (!this.attempted) {
      this.finish('ended', 'Cancelled before dialing.');
    } else if (this.media?.readyState === this.WebSocket.OPEN) {
      this.state = 'ending';
      this.media.send(JSON.stringify({ type: 'hangup' }));
      this.closeTimer = setTimeout(() => this.finish('unconfirmed', 'Telegram did not confirm hangup.'), 10_000);
    } else {
      this.finish('unconfirmed', 'The Telegram connection is lost; hangup cannot be verified.');
    }
    return this.snapshot(this.cursor);
  }

  finish(state, reason) {
    super.finish(state, reason);
    this.media?.close();
    this.session = undefined;
  }
}
