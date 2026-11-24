# Set up your own @Call in ChatGPT Web

`@Call` is the display name you give **your own private plugin**, not a preinstalled ChatGPT feature or a plugin shared by this repository. The included Worker forwards MCP requests to your [self-hosted relay](../SETUP.md). The relay stays on your computer or VPS and runs the calls.

## Let an agent set it up

If you're starting from scratch, use the [README prompt](../README.md#let-an-agent-set-it-up) and choose **ChatGPT Web with my own @Call**. If your relay is already running, paste this into a coding agent with the Sites tools:

```text
My relay is already running. Read docs/chatgpt-web.md in
https://github.com/Daaaaave/chatgpt-phone-calls and set up my own @Call.
Confirm I have Sites and MCP plugin creation access. Build the adapter using
my Site's project ID and publish it privately, for my account only.
Walk me through /setup and entering the Site settings without sharing secrets
in chat. Help me install and name the plugin Call, then check caller_status
from a new ChatGPT conversation. Do not place a call.
```

Without Sites access, a coding agent can still connect the local MCP server. It can't add a plugin to ChatGPT Web in that mode.

## Before you start

- Sign in to a ChatGPT account with **Sites access and permission to publish MCP plugins**. A local Codex MCP entry will not appear in ChatGPT Web. If your account or workspace does not allow this path, use [local MCP](../SETUP.md#4-connect-your-agent).
- Set up at least one calling channel on your computer or VPS. You still need your own OpenAI API project and either a SIP account for telephone numbers or a Telegram user account for Telegram calls.
- Use the current `main` branch for this guide. Keep the Site owner-only and behind the Sites identity gateway. Do not deploy the Worker as a standalone public endpoint.

## 1. Start the relay

Follow [SETUP.md](../SETUP.md) through the CLI status check. Expose only the relay's loopback endpoint to your Site through an HTTPS reverse proxy or tunnel you control. Keep the relay token enabled. Never expose the Telegram container or session volume. The computer or VPS must stay on during calls.

## 2. Build and publish a private Site

Create an owner-only Site in your ChatGPT account. Follow the [Sites publishing workflow](https://help.openai.com/en/articles/20001547-hosting-a-plugin-with-chatgpt-sites) and use the project ID returned for that Site.

```sh
npm ci
SITE_PROJECT_ID=YOUR_PRIVATE_PROJECT_ID npm run build:site
```

This builds the Worker at `dist/server/index.js` and generates `dist/.openai/hosting.json`. The manifest enables MCP and configures the `DB` database binding used to avoid submitting the same call twice. Use that manifest as `.openai/hosting.json` in your private Site checkout, and publish the built Worker through Sites.

The manifest is ignored in this repo. If your Sites workflow requires a committed copy, commit it only to the private Site source repository. Do not commit tokens or Telegram session files.

## 3. Set the owner and relay credentials

On the published **private** Site, sign in as the owner and open `/setup` in your browser. It shows the Site-scoped ID of the signed-in account. Tool execution is blocked until that ID is configured. Set these values in Site runtime settings, not in code or a chat message:

| Site runtime setting | Value |
| --- | --- |
| `CALLER_SITE_OWNER_ID` | The value shown at `/setup` on this Site. It is not your email, general account ID, or project ID. |
| `CALLER_CLOUD_ORIGIN` | Your relay's HTTPS origin, without a trailing slash. |
| `CALLER_CLOUD_TOKEN` | The same token as on your relay. This is not the OpenAI key or Telegram token. |

Apply the settings and republish the private Site if needed for the runtime to pick them up. After the owner ID takes effect, `/setup` returns 404. Keep optional Telegram messaging off unless you enabled it on both the relay and Telegram container and intend to enable it on the Site too (`CALLER_TELEGRAM_MESSAGING=1`).

## 4. Connect and test @Call

1. Open the plugin created by your Site. In ChatGPT, look under **Plugins > Personal > Created by you**, then install or connect it with the owner account.
2. In the plugin's settings, edit the **App name** to `Call`. Neither the GitHub name nor the Site URL controls the mention.
3. In a new ChatGPT conversation, type `@`, select **Call**, and ask it to check `caller_status` without dialing. Look for `ready: true`. The status checks relay connectivity, not whether your carrier or Telegram can complete a call.

If `Call` is missing, verify that the private Site was published and the plugin was installed in this account. If `/setup` is already closed but status says the owner is not configured, check the account you used to connect the plugin and the Site-scoped ID you entered. Do not remove the owner check to troubleshoot. If the owner is correct but the relay is unreachable, check the HTTPS route and that the Site and relay use the same token.

The public template has local build, MCP, and authorization tests. A fresh end-to-end deployment from this guide on another account has not yet been verified. Without Sites, use [local stdio MCP](../SETUP.md#4-connect-your-agent) or the CLI.
