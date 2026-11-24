# ChatGPT Phone Calls

**Self-hosted AI phone and Telegram calls from ChatGPT or another MCP client.** [OpenAI GPT-Live 1.1](https://developers.openai.com/api/docs/models/gpt-live-1.1) (`gpt-live-1.1`) is the voice model for both channels. Follow the live transcript and steer the conversation from the same chat when a decision or a missing fact requires it.

## Let an agent set it up

Paste this into **Codex or another coding agent with terminal access**. Pick the options you want, or let the agent ask. You do not need to clone the repo first.

```text
Set up https://github.com/Daaaaave/chatgpt-phone-calls for me.

I want [phone calls / Telegram voice calls / both] from
[ChatGPT Web with my own @Call / Codex / the terminal].
Run it on [this computer / a VPS I already have]. Ask only about choices
I haven't specified.

Clone the current main branch, read SETUP.md, and run the offline demo first.
Set up only my chosen channels and client. For @Call, follow docs/chatgpt-web.md
and keep my Site private. If Sites isn't available, tell me and offer local MCP.

Stop when I need to sign in, verify a caller ID, scan a Telegram QR, or enter
keys directly into a provider, local config file, or private Site settings.
Generate local relay tokens without printing them. Never ask me to paste a
credential or login code into chat.

Finish by checking status from my chosen client without dialing. Tell me
what passed and what's still unverified. Do not place a call until I give
you the exact destination and ask you to dial it.
```

The agent can run the install and checks. You still need to sign in to your accounts and complete any provider verification. [Read the setup guide](SETUP.md) if you prefer to follow the commands yourself.

## Try without keys

Install Node.js 24+ and run:

```sh
git clone https://github.com/Daaaaave/chatgpt-phone-calls.git
cd chatgpt-phone-calls
npm run demo
```

No dependency install, Docker, accounts, or keys are needed for the demo. It shows a counteroffer and a reply from the same chat without using a voice model or dialing anyone.

## What you need for real calls

| Requirement | When you need it |
| --- | --- |
| **Your computer or a VPS** | Run the relay with Docker Compose v2. Your computer works if it stays awake while you call. Use an always-on VPS if you want to call when your computer is off. |
| **Node.js 24+** | Run the CLI or local MCP client launcher, and build the optional Web adapter. |
| **An OpenAI API key with access to GPT-Live 1.1** | Required for both real call channels. [Create a project API key](https://platform.openai.com/api-keys) and make sure its organization has [API credits](https://platform.openai.com/settings/organization/billing/overview). Eligible subscribers can [claim and link ChatGPT API credits](https://developers.openai.com/api/docs/guides/chatgpt-api-credits). A ChatGPT login alone is not enough. |
| **A SIP provider, such as Twilio Elastic SIP Trunking** | Required **only** for ordinary phone numbers. Use SIP credentials and a verified outgoing caller ID; another provider must support the same outbound SIP setup. |
| **A Telegram account, API ID and API hash** | Required **only** for Telegram. Sign in via QR. A BotFather token is not a substitute; Twilio is not needed. |
| **A ChatGPT account with access to Sites and MCP plugins** | Required if you want to control calls from **ChatGPT Web** using your own private Site. Not required for the command-line dialer or a different compatible MCP client. |

## Manual setup

1. [Configure the relay](SETUP.md#1-configure-the-relay): create `.env` and set `OPENAI_API_KEY` and a relay token.
2. Set up [ordinary phone calls](SETUP.md#2a-set-up-ordinary-phone-calls), [Telegram voice calls](SETUP.md#2b-set-up-telegram-voice-calls), or both. [Telegram messaging](SETUP.md#optional-telegram-messages) is off by default.
3. [Check relay status](SETUP.md#3-check-status-and-make-a-test-call) without dialing.
4. Connect [a local MCP client](SETUP.md#4-connect-your-agent) or [your own private plugin for ChatGPT Web](docs/chatgpt-web.md). The terminal can use the relay directly.

## How to make phone calls with ChatGPT

**Cloning this repo does not add `@Call` to ChatGPT.** The repo includes the relay, a local CLI and stdio MCP server, and a buildable [ChatGPT Sites adapter](docs/chatgpt-web.md). It does not include a shared public plugin or a hosted call service.

To get your own `@Call` in ChatGPT Web, run the relay, publish the adapter on an owner-only Site you control, and install and connect that Site's plugin. Name the plugin `Call` and select it from the `@` menu. This requires Sites and MCP plugin creation access. Without Sites, use the CLI or [local MCP setup](SETUP.md#4-connect-your-agent).

## How to make real Telegram calls with an AI agent

Follow [Telegram setup](SETUP.md#2b-set-up-telegram-voice-calls), then ask the same chat: “Call `@example` in Telegram and ask whether Monday works. Check with me before agreeing to a different day.” Use the username of an actual recipient you authorize, not the placeholder. Telegram calls are outgoing 1:1 voice calls only: no video, groups, or automatic answers. The release has synthetic audio tests; a real Telegram call is still a release verification item.

## FAQ

**Can it call internationally?** Enter approved prefixes in `CALLER_ALLOWED_DIAL_PREFIXES` and use E.164 numbers. Your SIP provider, account, verified caller ID, and dialing permissions still decide which destinations are reachable.

**What does it cost?** The source is MIT-licensed. Live calls can incur OpenAI and SIP-provider charges billed to your own accounts.

**Do I need a VPS or a ChatGPT subscription?** No VPS is needed to run the relay on your own machine. The CLI does not require a ChatGPT subscription, but real calls use your OpenAI API project and its balance. ChatGPT Web uses your own Site and requires access to that feature.

**Is everything local?** The relay and credentials are self-hosted. Live audio is processed by OpenAI and travels over the selected calling service. The release does not enable raw audio recording. Transcript data can appear in the controlling client's history.

**Can it read all my Telegram history?** No. [Messaging setup](SETUP.md#optional-telegram-messages) exposes only `Saved Messages` and chats approved on that installation, on demand.
