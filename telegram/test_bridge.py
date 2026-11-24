import os
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp.test_utils import TestClient, TestServer

from bridge import process, serve


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def test_voice_only_does_not_publish_messaging_routes(self):
        with patch.dict(os.environ, {"RINGER_TELEGRAM_TOKEN": "a" * 64, "RINGER_TELEGRAM_MESSAGING": "0"}):
            app = await serve()
        async with TestClient(TestServer(app)) as client:
            self.assertEqual((await client.post("/status", json={})).status, 401)
            headers = {"Authorization": "Bearer " + "a" * 64}
            self.assertEqual((await client.post("/status", json={}, headers=headers)).status, 200)
            self.assertEqual((await client.post("/read", json={}, headers=headers)).status, 404)
            self.assertEqual((await client.post("/send", json={}, headers=headers)).status, 404)

    async def test_messaging_keeps_unapproved_chats_inaccessible(self):
        from types import SimpleNamespace
        account = SimpleNamespace(is_user_authorized=AsyncMock(return_value=True), get_input_entity=AsyncMock())
        with patch("bridge.read_peers", return_value={"101": "Approved fixture"}):
            peers = await process(account, "peers", {})
            self.assertEqual([p["peer"] for p in peers["peers"]], ["self", "101"])
            for operation in ("read", "send"):
                with self.assertRaisesRegex(ValueError, "not approved"):
                    await process(account, operation, {"peer": "13"})
        account.get_input_entity.assert_not_awaited()

    async def test_approved_chat_can_read_and_send(self):
        account = AsyncMock()
        account.is_user_authorized.return_value = True
        account.get_messages.return_value = []
        with patch("bridge.read_peers", return_value={"101": "Approved fixture"}):
            self.assertEqual((await process(account, "read", {"peer": "101"}))["messages"], [])
            result = await process(account, "send", {
                "peer": "101", "text": "Synthetic greeting",
                "request_id": "889ab839-24f5-48a1-9396-76a3d514dcea",
            })
            self.assertEqual(result["state"], "sent")
        self.assertEqual(account.await_args.args[0].message, "Synthetic greeting")


if __name__ == "__main__":
    unittest.main()
