/**
 * Dynamic Worker Sandbox API Router
 *
 * Provides a stateless JS/TS execution endpoint backed by Cloudflare
 * Dynamic Workers.
 */

import { executeCode } from "./procedures/execute-code";

export const sandboxRouter = {
	execute: executeCode,
};
