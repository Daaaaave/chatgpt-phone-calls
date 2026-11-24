import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createMcp } from './mcp.mjs';

await createMcp(undefined, { telegramMessaging: process.env.RINGER_TELEGRAM_MESSAGING === '1' }).connect(new StdioServerTransport());
