import type { MiddlewareHandler } from "hono";

export const AGENT_RESULT_RPC_PATH = "/rpc/contextQuality/agentResults/*";
/** Runs at HTTP entry, before session, schema and object-permission failures. */
export const agentResultResponsePrivacy: MiddlewareHandler = async (
	c,
	next,
) => {
	c.header("Cache-Control", "private, no-store");
	await next();
};
