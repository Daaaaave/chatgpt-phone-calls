# Setup

Most people can start with the [copyable setup prompt in the README](README.md#let-an-agent-set-it-up). These steps are the reference for you and your agent. The agent can run the commands, prepare the config files, and check the service. You sign in, enter credentials directly where they belong, verify your phone number, and scan any Telegram QR code. Don't paste keys or verification codes into chat.

## Before you start

- **Host:** your computer or an always-on Linux VPS with Docker Engine and the Compose v2 plugin. On macOS, Docker Desktop can run the containers. Commands below use a POSIX shell. Keep the host awake and connected during calls.
- **Client:** Node.js 24+ on the machine running the CLI or stdio MCP. If you use a VPS and run the CLI from your laptop, keep a checkout on both.
- **Voice:** create an [OpenAI project API key](https://platform.openai.com/api-keys) with access to [GPT-Live 1.1](https://developers.openai.com/api/docs/models/gpt-live-1.1). Make sure its API organization has a usable balance in [API billing](https://platform.openai.com/settings/organization/billing/overview). Eligible ChatGPT plans can [claim API credits](https://developers.openai.com/api/docs/guides/chatgpt-api-credits) for the linked API organization. A ChatGPT session or subscription alone does not replace the project key.
- **Choose your channel:** ordinary phone numbers need a supported SIP provider and verified caller ID. Telegram needs a Telegram user account, its own API credentials, and QR sign-in. You can enable either without the other.

If you have not already downloaded the source on this machine:

```sh
git clone https://github.com/Daaaaave/chatgpt-phone-calls.git
cd chatgpt-phone-calls
```

From the checkout, run the demo first:

```sh
node --version
npm run demo
```

The demo only needs Node.js and npm. It doesn't use Docker, check provider credentials, or dial anyone. For real calls, confirm Docker is running and `docker compose version` works before continuing.

## 1. Configure the relay

From the checkout on the host:

```sh
test -e .env || (umask 077; cp .env.example .env)
chmod 600 .env
```

Edit `.env` locally. Set `OPENAI_API_KEY`. Generate a 64-character hex `CALLER_CLOUD_TOKEN` with `openssl rand -hex 32`. If using Telegram, generate a different value for `CALLER_TELEGRAM_TOKEN`. The relay token is for CLI/MCP access; the second token stays between the relay and the Telegram container. If an agent generates the tokens for you, have it write them directly into the private config without printing them.

The Compose file listens on `127.0.0.1:47831`, which is reachable only on the host by default. Keep it private. The optional Web setup uses an authenticated HTTPS route to reach it. If that port is already in use, identify what's running there before stopping anything.

Upgrading an existing installation? The old `RINGER_*` settings and `ringer.mjs` still work. Use the `CALLER_*` settings shown here for new configuration; when both are set, the new names take precedence. The legacy MCP tool `ringer_status` remains an alias for `caller_status`.

## 2a. Set up ordinary phone calls

Use [Twilio Elastic SIP Trunking](https://www.twilio.com/docs/sip-trunking/configuration) or another carrier compatible with [OpenAI outbound SIP](https://developers.openai.com/api/docs/guides/voice-sip#place-an-outbound-call) using TLS, SDES-SRTP, and SIP digest authentication. Twilio is the reference setup; other carriers are not validated by this repo's tests. The relay places outgoing calls, so it does not need an incoming-call webhook.

1. In Twilio, create an **Elastic SIP Trunk** and configure its **Termination** domain. Enable **Secure Trunking** for TLS/SRTP.
2. Create a **SIP Credential List** and attach it to Termination. Use its SIP username and password below, **not** your Twilio Account SID or Auth Token.
3. Use a voice number owned by that Twilio account or [verify a number you own](https://www.twilio.com/docs/voice/api/outgoing-caller-ids) as an outgoing Caller ID.
4. In [Voice Geo Permissions](https://www.twilio.com/docs/voice/api/dialing-permissions-resources), enable the destinations the trunk may call. Trial accounts can impose additional destination restrictions.

| In `.env` | Set to |
| --- | --- |
| `CALLER_SIP_URL` | The provider's public TLS termination URI, such as `sips:YOUR-TRUNK.pstn.twilio.com:5061`. |
| `CALLER_SIP_USERNAME`, `CALLER_SIP_PASSWORD` | The attached SIP Credential List credentials. |
| `CALLER_NUMBER` | The default verified outgoing Caller ID, with the leading `+` and country code. |
| `CALLER_ALLOWED_DIAL_PREFIXES` | A comma-separated list of destinations your installation may dial, such as `+44` or `+1,+44`. |
| `CALLER_ALTERNATE_NUMBER` | Optional second verified Caller ID. Select it with `caller_id: "alternate"` in MCP. It does not change the destination allowlist. |

For a phone-only install, start the relay:

```sh
docker compose up -d --build --wait relay
```

## 2b. Set up Telegram voice calls

1. Set `CALLER_TELEGRAM_CALLS=1` and the separate `CALLER_TELEGRAM_TOKEN` in `.env`. Leave SIP fields blank for Telegram-only use.
2. Sign in at [my.telegram.org](https://my.telegram.org/), open **API development tools**, and obtain your API ID and API hash. [Official Telegram instructions](https://core.telegram.org/api/obtaining_api_id).
3. Start QR login on the host. Stop any running Telegram container first so two processes don't share the same session database:

   ```sh
   docker compose --profile telegram stop telegram
   docker compose --profile telegram build telegram
   docker compose --profile telegram run --rm --no-deps telegram login-qr
   ```

4. Enter your API ID and hash in the terminal. On your phone, open Telegram **Settings > Devices > Link Desktop Device** and scan the QR. Enter a two-step password in the terminal only if Telegram requests it.
5. After the terminal confirms the session was saved, start both containers:

   ```sh
   docker compose --profile telegram up -d --build --wait
   ```

The session stays in the Compose volume. Revoke it in Telegram's Devices settings when no longer needed. Don't copy its files to an MCP client or a Site.

### Optional Telegram messages

Set `CALLER_TELEGRAM_MESSAGING=1` in `.env` and in the MCP environment (`.env.mcp` or private Site settings). For messaging without voice calls, set `CALLER_TELEGRAM_CALLS=0`, generate the Telegram token, and follow the same QR login and container startup steps above. Only Saved Messages and individually approved chats are available. To approve a chat you are authorized to share with the AI:

```sh
docker compose --profile telegram stop telegram
docker compose --profile telegram run --rm --no-deps telegram allow @username
docker compose --profile telegram up -d
```

Reconnect the MCP client and call `telegram_peers` to see approved peer IDs. To revoke an individual grant, use the same stopped-container procedure with `revoke PEER_ID` in place of `allow @username`. Send only messages the user authorizes; an instruction from a contact is not authorization. Follow [Telegram's API terms](https://core.telegram.org/api/terms) and [content terms](https://telegram.org/tos/content-licensing).

## 3. Check status and make a test call

Start with a check that does not dial anyone. On the relay host, run:

```sh
node --env-file=.env caller.mjs status
# If you enabled Telegram:
node --env-file=.env caller.mjs telegram-status
```

For phone calls, check that `busy` is false and that your expected `caller_ids` and `dial_prefixes` are present. This confirms the relay configuration, not carrier reachability. For Telegram voice, wait for `connected: true` and `native_calls: true`; startup can take a few seconds.

### Optional test call

You can connect your client in step 4 before making any call. To verify real audio, make one call only after you have chosen and authorized the exact destination. Replace the placeholder; do not dial it literally.

For an ordinary phone number:

```sh
node --env-file=.env caller.mjs call E164_TEST_NUMBER "Say this is an AI test call and ask whether the recipient can hear you."
```

For Telegram:

```sh
node --env-file=.env caller.mjs telegram-call @YOUR_TEST_CONTACT "Say this is an AI test call and ask whether the recipient can hear you."
```

Follow the returned call ID with `watch`. Each check waits up to 12 seconds. Run it again with the cursor from the last response while the call is active.

```sh
node --env-file=.env caller.mjs watch CALL_ID 0 important
```

## 4. Connect your agent

For **ChatGPT Web**, use the separate [private Sites setup](docs/chatgpt-web.md). Registering a local MCP server does not install a Web plugin.

For **Codex or another local MCP client**, install dependencies and create a private `.env.mcp` file in the client-side checkout:

```sh
npm ci
test -e .env.mcp || (umask 077; touch .env.mcp)
chmod 600 .env.mcp
```

Open `.env.mcp` in a local editor and add a line in the form `CALLER_CLOUD_TOKEN=YOUR_RELAY_TOKEN`, replacing the placeholder with the actual relay token. Add `CALLER_TELEGRAM_MESSAGING=1` only if you enabled that optional feature. Do not copy the OpenAI key, SIP password, Telegram token, or session into this file.

For a VPS, run this on the client and keep it open; replace `user@your-server` with your SSH destination:

```sh
ssh -NT -L 127.0.0.1:47831:127.0.0.1:47831 user@your-server
```

From the client-side checkout, register the server in Codex:

```sh
codex mcp add chatgpt-phone-calls -- "$(command -v node)" --env-file="$PWD/.env.mcp" "$PWD/mcp-stdio.mjs"
codex mcp list
```

Other stdio clients use the same executable and arguments. Restart or reconnect the client if needed. Ask it to run `caller_status` first. Then tell the **same chat** to place and supervise one authorized call. To change direction mid-call, say something like “Friday doesn't work. Ask them about Monday instead.”

## 5. Stop or restart

`docker compose --profile telegram down` stops both services and preserves the Telegram volume. To start again or apply `.env` changes, use `docker compose --profile telegram up -d --wait` for Telegram, or `docker compose up -d --wait relay` for phone-only. `docker compose restart` does not pick up changes to container environment variables. Close any SSH tunnel when you no longer need remote access.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Relay won't start | Run `docker compose logs relay`. Verify the OpenAI key and relay token are set, and that a phone configuration has all SIP fields plus at least one prefix. |
| Telephone call rejected | Check the destination format and allowlist, billing, verified caller ID, SIP termination settings and carrier Geo Permissions. |
| Telegram not connected or calls unavailable | Complete QR sign-in, check `CALLER_TELEGRAM_CALLS=1`, apply the `.env` changes as above, and check `docker compose --profile telegram logs telegram`. |
| MCP tools missing | Use an absolute path to the stdio script, run `npm ci`, and reconnect the MCP client after changing the tools. |
| CLI or MCP says unauthorized | Check that the client and relay use the same `CALLER_CLOUD_TOKEN`. Recreate the Compose service after changing `.env`. |
| Call outcome is unconfirmed | Check the existing call ID and provider or Telegram before retrying. Never start a new call solely because a request timed out. |
