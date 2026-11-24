import asyncio
import audioop
import logging
import re

from aiohttp import WSMsgType, web
from pytgcalls import PyTgCalls
from pytgcalls.exceptions import CallBusy, CallDeclined, CallDiscarded, NotInCallError, TimedOutAnswer
from pytgcalls.types import CallConfig, ChatUpdate, Device, Direction, ExternalMedia, MediaStream, RecordStream, StreamFrames
from pytgcalls.types.raw import AudioParameters
from telethon import errors, events, types


TARGET = re.compile(r"(?:@[A-Za-z][A-Za-z0-9_]{3,31}|[1-9][0-9]{0,15})")
TELEGRAM_RATE = 48000
LIVE_RATE = 24000
FRAME_BYTES = TELEGRAM_RATE * 2 // 100
SILENCE = bytes(LIVE_RATE * 2 // 50)
MAX_BUFFER = TELEGRAM_RATE * 2 * 3
PARAMETERS = AudioParameters(bitrate=TELEGRAM_RATE, channels=1)


class TelegramCalls:
    def __init__(self, account):
        self.account = account
        self.engine = PyTgCalls(account)
        self.active = None
        self.engine.on_update()(self.on_update)
        account.add_event_handler(self.on_phone_update, events.Raw(types.UpdatePhoneCall))

    async def start(self):
        await self.engine.start()

    async def on_phone_update(self, update):
        call = update.phone_call
        if isinstance(call, types.PhoneCallRequested):
            # This bridge must never accept inbound calls, even while dialing.
            raise events.StopPropagation
        current = self.active
        if (current and current.dialing and isinstance(call, types.PhoneCallWaiting)
                and call.participant_id == current.peer and call.receive_date and not current.ringing):
            current.ringing = True
            if not current.ws.closed:
                await current.ws.send_json({"type": "ringing"})

    async def on_update(self, _, update):
        current = self.active
        if not current or current.peer != update.chat_id:
            return
        if isinstance(update, ChatUpdate) and update.status & ChatUpdate.Status.DISCARDED_CALL:
            current.remote_ended = True
            current.stop.set()
        elif (current.answered and isinstance(update, StreamFrames)
              and update.direction == Direction.INCOMING and update.device == Device.MICROPHONE):
            for sample in update.frames:
                current.enqueue_audio(sample.frame)

    async def connect(self, request):
        if self.active:
            raise web.HTTPConflict()
        current = CallStream(self.account, self.engine)
        if not current.ws.can_prepare(request).ok:
            raise web.HTTPBadRequest()
        self.active = current
        try:
            return await current.handle(request)
        finally:
            self.active = None

    async def shutdown(self, _):
        if self.active:
            self.active.stop.set()
            await self.active.finished.wait()


class CallStream:
    def __init__(self, account, engine):
        self.account = account
        self.engine = engine
        self.ws = web.WebSocketResponse(heartbeat=10, max_msg_size=MAX_BUFFER)
        self.peer = None
        self.dialing = self.ringing = self.answered = self.remote_ended = False
        self.stop = asyncio.Event()
        self.finished = asyncio.Event()
        self.incoming = asyncio.Queue(maxsize=30)
        self.outgoing = bytearray()
        self.capture_state = self.playback_state = None

    async def handle(self, request):
        tasks = []
        state, reason = "failed", "Telegram did not start the call."
        try:
            await self.ws.prepare(request)
            initial = await self.ws.receive_json(timeout=5)
            target = initial.get("to") if isinstance(initial, dict) else None
            if not isinstance(target, str) or not TARGET.fullmatch(target):
                raise ValueError("Use a Telegram @username or a positive user ID.")
            user = await asyncio.wait_for(
                self.account.get_entity(int(target) if target.isdigit() else target), 8)
            if not isinstance(user, types.User) or user.is_self or user.bot or user.deleted:
                raise ValueError("Telegram calls require another person's account, not a group or bot.")
            self.peer = user.id
            tasks = [asyncio.create_task(fn()) for fn in (self.dial, self.read, self.stop.wait)]
            done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
            state = "ended"
            reason = "The recipient ended or declined the Telegram call." if self.remote_ended else "Telegram call closed."
        except (CallDeclined, CallBusy, CallDiscarded, TimedOutAnswer):
            self.remote_ended = True
            state, reason = "ended", "The Telegram call was declined, busy, or unanswered."
        except (errors.UserPrivacyRestrictedError, errors.UserIsBlockedError):
            self.remote_ended = True
            reason = "Telegram privacy settings prevented this call."
        except ValueError as exc:
            reason = str(exc) if not self.dialing else "Telegram rejected the audio stream."
        except Exception as exc:
            logging.warning("Telegram call failed: %s", type(exc).__name__)
            reason = "The Telegram call or audio connection failed."
        finally:
            try:
                for task in tasks:
                    task.cancel()
                await asyncio.gather(*tasks, return_exceptions=True)
                if self.dialing:
                    try:
                        await asyncio.wait_for(self.engine.leave_call(self.peer), 6)
                    except NotInCallError:
                        if not self.remote_ended:
                            state, reason = "unconfirmed", "Telegram did not confirm the final call state."
                    except Exception as exc:
                        if not self.remote_ended:
                            state, reason = "unconfirmed", "Telegram did not confirm hangup."
                        logging.warning("Telegram hangup failed: %s", type(exc).__name__)
                if self.ws.prepared and not self.ws.closed:
                    try:
                        await self.ws.send_json({"type": state, "reason": reason})
                    except ConnectionError:
                        pass
                    await self.ws.close()
            finally:
                self.finished.set()
        return self.ws

    async def dial(self):
        self.dialing = True
        await asyncio.wait_for(
            self.engine.play(self.peer, MediaStream(ExternalMedia.AUDIO, PARAMETERS), CallConfig(timeout=35)),
            timeout=50)
        await asyncio.wait_for(self.engine.record(self.peer, RecordStream(True, PARAMETERS)), 5)
        await self.ws.send_json({"type": "answered"})
        self.answered = True
        media = [asyncio.create_task(fn()) for fn in (self.write_pcm, self.play_pcm)]
        try:
            done, _ = await asyncio.wait(media, return_when=asyncio.FIRST_COMPLETED)
            for task in done:
                task.result()
        finally:
            for task in media:
                task.cancel()
            await asyncio.gather(*media, return_exceptions=True)

    async def read(self):
        async for frame in self.ws:
            if frame.type == WSMsgType.TEXT:
                if frame.json().get("type") == "hangup":
                    return
            elif frame.type == WSMsgType.BINARY and self.answered:
                if len(frame.data) % 2:
                    raise ValueError("Expected PCM16 audio.")
                pcm, self.playback_state = audioop.ratecv(
                    frame.data, 2, 1, LIVE_RATE, TELEGRAM_RATE, self.playback_state)
                if len(self.outgoing) + len(pcm) > MAX_BUFFER:
                    raise ValueError("The audio playback queue is full.")
                self.outgoing.extend(pcm)

    def enqueue_audio(self, pcm):
        if not pcm or len(pcm) % 2:
            return
        audio, self.capture_state = audioop.ratecv(
            pcm, 2, 1, TELEGRAM_RATE, LIVE_RATE, self.capture_state)
        if self.incoming.full():
            self.incoming.get_nowait()
        self.incoming.put_nowait(audio)

    async def write_pcm(self):
        while True:
            try:
                pcm = await asyncio.wait_for(self.incoming.get(), 0.02)
            except asyncio.TimeoutError:
                pcm = SILENCE
            await self.ws.send_bytes(pcm)

    async def play_pcm(self):
        loop = asyncio.get_running_loop()
        deadline = loop.time()
        while True:
            pcm = bytes(self.outgoing[:FRAME_BYTES])
            del self.outgoing[:FRAME_BYTES]
            await self.engine.send_frame(self.peer, Device.MICROPHONE, pcm.ljust(FRAME_BYTES, b"\0"))
            deadline = max(deadline + 0.01, loop.time())
            await asyncio.sleep(deadline - loop.time())
