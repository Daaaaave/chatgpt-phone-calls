# ChatGPT Phone Calls

**Self-hosted AI phone and Telegram calls from ChatGPT or another MCP client.** [OpenAI GPT-Live 1.1](https://developers.openai.com/api/docs/models/gpt-live-1.1) (`gpt-live-1.1`) is the voice model for both channels. Follow the live transcript and steer the conversation from the same chat when a decision or a missing fact requires it.

| What you want to do | How it works |
| --- | --- |
| Make a real AI phone call | Your OpenAI API project and a supported outbound SIP trunk. Destination prefixes are configured per installation. |
| Make a real Telegram voice call | Your Telegram user account via MTProto and a native audio adapter. This is a private 1:1 call, not a bot voice note. |
| Read or send Telegram messages from chat | Optional MCP tools for explicitly approved chats. Off by default; no bulk export, edits or deletion. |
| Control an active call from chat | Live transcript, handoff questions, steering, hangup, and telephone keypad tones. |
| Try it without accounts or keys | `npm run demo` replays an offline call and a mid-call decision. |

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

## Install

Start in the checkout from the demo above, then:

1. Follow [local configuration](SETUP.md#1-configure-the-relay) to create `.env` from `.env.example`. Set `OPENAI_API_KEY` in `.env` to your project key and generate a relay token. Keep the key out of chat and Git.
2. Choose [ordinary phone calls](SETUP.md#2a-set-up-ordinary-phone-calls), [Telegram voice calls](SETUP.md#2b-set-up-telegram-voice-calls), or both. [Telegram messaging](SETUP.md#optional-telegram-messages) is separate and optional.
3. Check status and make [one authorized test call from the CLI](SETUP.md#3-check-status-and-make-a-test-call).
4. Connect [Codex or another local MCP client](SETUP.md#4-connect-your-agent), or follow the separate [ChatGPT Web setup](docs/chatgpt-web.md).

Or give a coding agent this prompt:

> Set up ChatGPT Phone Calls from this checkout. Read SETUP.md and start with the offline demo. Help me connect the calling channels I choose and register the local MCP server. Let me enter all credentials and codes myself outside chat. Do not dial until I give you an exact test destination and authorize the call.

## How to make phone calls with ChatGPT

Start with the local CLI or stdio MCP in a compatible coding agent. For ChatGPT web, use the [private ChatGPT Sites adapter](docs/chatgpt-web.md) with your own deployment and account, where Sites MCP plugins are available. Type `@` and select your plugin by its display name, such as `Call`. This repository does not include a shared public plugin or hosted call service.

## How to make real Telegram calls with an AI agent

Follow [Telegram setup](SETUP.md#2b-set-up-telegram-voice-calls), then ask the same chat: “Call `@example` in Telegram and ask whether Monday works. Check with me before agreeing to a different day.” Use the username of an actual recipient you authorize, not the placeholder. Telegram calls are outgoing 1:1 voice calls only: no video, groups, or automatic answers. The release has synthetic audio tests; a real Telegram call is still a release verification item.

## FAQ

**Can it call internationally?** Enter approved prefixes in `CALLER_ALLOWED_DIAL_PREFIXES` and use E.164 numbers. Your SIP provider, account, verified caller ID, and dialing permissions still decide which destinations are reachable.

**What does it cost?** The source is MIT-licensed. Live calls can incur OpenAI and SIP-provider charges billed to your own accounts.

**Do I need a VPS or a ChatGPT subscription?** No VPS is needed to run the relay on your own machine. The CLI does not require a ChatGPT subscription, but real calls use your OpenAI API project and its balance. ChatGPT Web uses your own Site and requires access to that feature.

**Is everything local?** The relay and credentials are self-hosted. Live audio is processed by OpenAI and travels over the selected calling service. The release does not enable raw audio recording. Transcript data can appear in the controlling client's history.

**Can it read all my Telegram history?** No. [Messaging setup](SETUP.md#optional-telegram-messages) exposes only `Saved Messages` and chats approved on that installation, on demand.
