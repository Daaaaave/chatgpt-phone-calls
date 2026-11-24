# How to make phone calls from ChatGPT web

The [self-hosted relay](../SETUP.md) keeps running on your server. The optional ChatGPT Sites worker is only an authenticated MCP front end; it does not replace the voice relay or Telegram container. Use it only on a Site restricted to you, behind the trusted Sites identity gateway. Do not deploy this adapter as a standalone public worker.

## Before you start

- Sign in to a ChatGPT account with **Sites access and permission to publish MCP plugins**. A local Codex MCP entry will not appear in ChatGPT Web. If your account or workspace does not allow this path, use [local MCP](../SETUP.md#4-connect-your-agent).
- Set up at least one calling channel on your computer or VPS. You still need your own OpenAI API project and either a SIP account for telephone numbers or a Telegram user account for Telegram calls.
- Have a private Site you own and an HTTPS route to the relay. The computer or VPS hosting the relay must stay on. Do not share the Site or plug in anyone else's account.

## Connect the Site

1. Set up and verify the relay via CLI first. Make its loopback endpoint reachable to your Site through an HTTPS reverse proxy or tunnel you control. Keep the relay token enabled; never expose the Telegram container or session volume.
2. Create a private ChatGPT Site with MCP support as described in [Hosting a plugin with ChatGPT Sites](https://help.openai.com/en/articles/20001547-hosting-a-plugin-with-chatgpt-sites). Use its own project ID and the D1 binding named `DB` for call idempotency. Do not use another owner's project ID.
3. Run `npm ci` and `SITE_PROJECT_ID=YOUR_PRIVATE_PROJECT_ID npm run build:site`. This creates `dist/server/index.js` and `dist/.openai/hosting.json`. In your private Site checkout, use that manifest as `.openai/hosting.json`. Package the manifest and the built Worker at `dist/server/index.js` using the Sites deploy workflow. Keep account-specific files out of public forks.
4. Configure Site runtime secrets: `RINGER_CLOUD_ORIGIN` (HTTPS origin, no trailing slash), `RINGER_CLOUD_TOKEN` (the relay token), and `RINGER_SITE_OWNER_ID` (your authenticated account user ID as supplied by the Sites gateway). Use the owner account ID from your Site's access settings; do not substitute an email, project ID or workspace ID. For optional messaging, set `RINGER_TELEGRAM_MESSAGING=1` here and on the relay and Telegram containers.
5. Publish privately, install or connect the resulting plugin as the owner, and call `ringer_status` before dialing. Confirm a non-owner cannot call tools. If the status says the owner account is not configured, review the owner ID and the plugin's signed-in account. Never remove the identity check to troubleshoot it.

The manifest path is ignored by default to prevent leaking a personal Site ID. If the Sites workflow requires a committed manifest, stage it only in the private deployment repository. Do not commit tokens, session databases, or audio.

The toolkit supports both telephone and Telegram with the same call controls. The adapter has local build and authorization checks; this release branch has not been independently tested with a newly provisioned Site. Local stdio MCP is the simpler supported path if Sites is unavailable.
