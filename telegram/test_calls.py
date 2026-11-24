import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock

from aiohttp import WSMsgType, web
from aiohttp.test_utils import TestClient, TestServer
from telethon.types import User

from calls import CallStream, FRAME_BYTES


class StreamingTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = SimpleNamespace(
            play=AsyncMock(), record=AsyncMock(), leave_call=AsyncMock(), send_frame=AsyncMock())
        account = SimpleNamespace(get_entity=AsyncMock(return_value=User(id=42)))
        self.call = CallStream(account, self.engine)
        app = web.Application()
        app.router.add_get("/calls", self.call.handle)
        self.client = await self.enterAsyncContext(TestClient(TestServer(app)))

    async def test_duplex_pcm_and_hangup(self):
        async with self.client.ws_connect("/calls") as ws:
            await ws.send_json({"to": "@example"})
            self.assertEqual((await ws.receive_json(timeout=2))["type"], "answered")
            await ws.send_bytes(b"\x02\x00" * 480)
            self.call.enqueue_audio(b"\x04\x00" * 480)
            pcm = await ws.receive(timeout=2)
            self.assertEqual(pcm.type, WSMsgType.BINARY)
            self.assertEqual(pcm.data, b"\x04\x00" * 240)
            async with asyncio.timeout(2):
                while not any(
                    args.args[2].startswith(b"\x02\x00") and len(args.args[2]) == FRAME_BYTES
                    for args in self.engine.send_frame.await_args_list
                ):
                    await asyncio.sleep(0.01)
            await ws.send_json({"type": "hangup"})
            async with asyncio.timeout(2):
                async for event in ws:
                    if event.type == WSMsgType.TEXT:
                        self.assertEqual(event.json()["type"], "ended")
                        break
                else:
                    self.fail("No terminal status")
            self.engine.leave_call.assert_awaited_once_with(42)

    async def test_invalid_target_never_dials(self):
        async with self.client.ws_connect("/calls") as ws:
            await ws.send_json({"to": "-1001111111"})
            self.assertEqual((await ws.receive_json(timeout=2))["type"], "failed")
            self.engine.play.assert_not_awaited()


if __name__ == "__main__":
    unittest.main()
