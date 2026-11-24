import asyncio
import hmac
import json
import logging
import os
from pathlib import Path
import re
import sys
from uuid import UUID

from aiohttp import web
from telethon import TelegramClient, errors, functions, utils


STATE = Path("/state")
APP = STATE / "app.json"
PEERS = STATE / "peers.json"


def read_peers():
    return json.loads(PEERS.read_text()) if PEERS.exists() else {}



def write_private(path, value):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value))
    temp.replace(path)


def client(*, receive_updates=False):
    app = json.loads(APP.read_text())
    return TelegramClient(str(STATE / "account"), app["id"], app["hash"],
                          flood_sleep_threshold=0, receive_updates=receive_updates,
                          device_model="ChatGPT Phone Calls")


async def sign_in_with_qr(account):
    from getpass import getpass
    from qrcode import QRCode

    if not sys.stdin.isatty() or not sys.stdout.isatty():
        raise ValueError("QR login must run in an interactive terminal.")
    await account.connect()
    if await account.is_user_authorized():
        return
    qr = await account.qr_login()
    for attempt in range(10):
        if attempt:
            await qr.recreate()
        print("\x1b[2J\x1b[HTelegram > Settings > Devices > Link Desktop Device")
        code = QRCode(border=4)
        code.add_data(qr.url)
        code.print_ascii()
        sys.stdout.flush()
        try:
            await qr.wait()
        except asyncio.TimeoutError:
            continue
        except errors.SessionPasswordNeededError:
            print("\x1b[2J\x1b[H", end="")
            await account.sign_in(password=getpass("Telegram two-step password: "))
        print("\x1b[2J\x1b[H", end="")
        return
    raise ValueError("QR login expired. Run login-qr again.")


async def configure(action):
    if action in {"login", "login-qr"} and not APP.exists():
        from getpass import getpass

        app_id = int(input("Telegram API ID: ").strip())
        app_hash = getpass("Telegram API hash: ").strip()
        if app_id < 1 or not re.fullmatch("[a-f0-9]{32}", app_hash):
            raise ValueError("Invalid Telegram API credentials.")
        write_private(APP, {"id": app_id, "hash": app_hash})
    account = client(receive_updates=action == "login-qr")
    try:
        if action in {"login", "login-qr"}:
            if action == "login-qr":
                await sign_in_with_qr(account)
            else:
                from getpass import getpass

                await account.start(code_callback=lambda: getpass("Telegram login code: "))
            print("Telegram session saved.")
            return
        await account.connect()
        if not await account.is_user_authorized():
            raise ValueError("Sign in with the login command first.")
        if len(sys.argv) != 3:
            raise ValueError("Pass the peer username or numeric ID.")
        peers = read_peers()
        if action == "allow":
            if input("All relevant participants approved AI access to this chat? Type YES: ") != "YES":
                raise ValueError("Peer not added.")
            peer = await account.get_entity(sys.argv[2])
            peer_id = str(utils.get_peer_id(peer))
            peers[peer_id] = utils.get_display_name(peer)
            write_private(PEERS, peers)
            print(f"Approved peer {peer_id}.")
        else:
            peers.pop(sys.argv[2], None)
            write_private(PEERS, peers)
            print("Peer revoked.")
    finally:
        await account.disconnect()


async def process(account, op, body):
    if op == "status":
        return {"connected": bool(account and await account.is_user_authorized()), "native_calls": False}
    if not account or not await account.is_user_authorized():
        raise ValueError("Sign in to Telegram on the server first.")
    peers = read_peers()
    if op == "peers":
        return {"peers": [{"peer": "self", "name": "Saved Messages"}] +
                [{"peer": key, "name": name} for key, name in peers.items()]}
    peer_id = body.get("peer")
    if not isinstance(peer_id, str) or (peer_id != "self" and not re.fullmatch(r"-?[0-9]{1,20}", peer_id)):
        raise ValueError("Use a peer ID from the chat list.")
    if peer_id != "self" and peer_id not in peers:
        raise ValueError("This peer is not approved for access through Ringer.")
    peer = await account.get_input_entity("me" if peer_id == "self" else int(peer_id))
    if op == "read":
        limit = body.get("limit", 10)
        if type(limit) is not int or not 1 <= limit <= 20:
            raise ValueError("Limit must be between 1 and 20.")
        query = body.get("query")
        if query is not None and (not isinstance(query, str) or len(query) > 200):
            raise ValueError("Invalid search query.")
        before = body.get("before_message_id", 0)
        if type(before) is not int or not 0 <= before <= 2_147_483_647:
            raise ValueError("Invalid message cursor.")
        items = await account.get_messages(peer, limit=limit + 1, search=query, offset_id=before)
        return {"messages": [{"id": m.id, "date": m.date.isoformat(), "outgoing": bool(m.out),
                              "text": m.message or "", "has_media": bool(m.media)} for m in items[:limit]],
                "next_before_message_id": items[limit - 1].id if len(items) > limit else None}
    if op == "send":
        message = body.get("text")
        if not isinstance(message, str) or not 1 <= len(message.strip()) <= 4000:
            raise ValueError("Invalid message text.")
    if op == "send":
        rid = UUID(body.get("request_id", ""))
        random_id = int.from_bytes(rid.bytes[:8], "big", signed=True)
        if not random_id:
            raise ValueError("Invalid request ID.")
        try:
            await account(functions.messages.SendMessageRequest(peer=peer, message=message,
                                                                 random_id=random_id, no_webpage=True))
        except errors.RandomIdDuplicateError:
            return {"state": "already_submitted"}
        return {"state": "sent"}
    raise ValueError("Unsupported Telegram operation.")


async def serve():
    token = os.environ["RINGER_TELEGRAM_TOKEN"]
    if not re.fullmatch("[a-f0-9]{64}", token):
        raise ValueError("Invalid Telegram service token.")
    use_calls = os.environ.get("RINGER_TELEGRAM_CALLS") == "1"
    messaging = os.environ.get("RINGER_TELEGRAM_MESSAGING") == "1"
    account = client(receive_updates=use_calls) if APP.exists() and (STATE / "account.session").exists() else None
    calls = None
    if account:
        await account.connect()
        if use_calls and await account.is_user_authorized():
            try:
                from calls import TelegramCalls
                calls = TelegramCalls(account)
                await calls.start()
            except Exception as exc:
                calls = None
                logging.warning("Telegram calling unavailable: %s", type(exc).__name__)

    def authorized(req):
        return hmac.compare_digest(req.headers.get("Authorization", "").encode(),
                                   ("Bearer " + token).encode())

    async def request(req):
        if not authorized(req):
            return web.json_response({"error": "Unauthorized."}, status=401)
        try:
            body = await req.json()
            if not isinstance(body, dict):
                raise ValueError("Invalid request body.")
            op = req.match_info["op"]
            result = await asyncio.wait_for(process(account, op, body), 6)
            if op == "status":
                result["native_calls"] = bool(calls and result["connected"])
                result["messaging_enabled"] = messaging
            return web.json_response(result)
        except errors.FloodWaitError as exc:
            return web.json_response({"error": f"Telegram rate limit. Wait {exc.seconds} seconds."})
        except (ValueError, TypeError, AttributeError) as exc:
            return web.json_response({"error": str(exc)})
        except Exception as exc:
            logging.warning("Telegram operation failed: %s", type(exc).__name__)
            return web.json_response({"error": "Telegram did not confirm the operation. Check before retrying."})

    app = web.Application(client_max_size=16384)
    operations = "status|peers|read|send" if messaging else "status"
    app.router.add_post("/{op:" + operations + "}", request)
    if calls:
        async def call_route(req):
            if not authorized(req):
                raise web.HTTPUnauthorized()
            return await calls.connect(req)
        app.router.add_get("/calls", call_route)
        app.on_shutdown.append(calls.shutdown)
    if account:
        async def close(_):
            await account.disconnect()

        app.on_cleanup.append(close)
    return app


if __name__ == "__main__":
    os.umask(0o077)
    if len(sys.argv) > 1 and sys.argv[1] in {"login", "login-qr", "allow", "revoke"}:
        asyncio.run(configure(sys.argv[1]))
    else:
        web.run_app(serve(), host="0.0.0.0", port=8090, access_log=None, print=None)
