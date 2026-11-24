import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcp } from './mcp.mjs';
import { callerSetting } from './settings.mjs';

await createMcp(undefined, { telegramMessaging: callerSetting(process.env, 'CALLER_TELEGRAM_MESSAGING') === '1' }).connect(new StdioServerTransport());
