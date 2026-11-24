import assert from 'node:assert/strict';
import { LiveConversation } from './live.mjs';

const commands = [];
const call = new LiveConversation({
  WebSocket: { OPEN: 1 },
});
call.socket = { readyState: 1, send: data => commands.push(JSON.parse(data)), close() {} };
call.handleEvent({ type: 'transport.answered' });
const watch = call.waitForEvents(call.cursor, {
  waitMs: 1000, important: true, signal: new AbortController().signal,
});
call.handleEvent({ type: 'session.input_transcript.delta', delta: 'Friday is full. Does Monday work?' });
call.handleEvent({ type: 'session.delegation.created', delegation: { target: 'client', id: 'demo-approval' } });
const handoff = (await watch).events.at(-1);
console.log('Simulated call. No credentials, network, or real dialing.');
console.log('Recipient:', handoff.transcriptTail[0].text);
console.log('Chat: The recipient offered Monday. Should I accept?');
console.log('User (fixture): Yes, Monday works.');
const answer = call.send('say', 'Monday works for the caller.', handoff.delegationId);
assert.equal(commands[0].delegation_id, 'demo-approval');
call.handleEvent({ type: 'session.commentary.appended', client_event_id: answer.commandId });
call.handleEvent({ type: 'session.input_transcript.delta', delta: 'Monday is confirmed.' });
call.handleEvent({ type: 'session.closed', reason: 'Synthetic demo complete.' });
assert.equal(call.state, 'ended');
console.log('Recipient (fixture): Monday is confirmed.');
console.log('PASS: The chat replied to the correct delegation during the same call.');
