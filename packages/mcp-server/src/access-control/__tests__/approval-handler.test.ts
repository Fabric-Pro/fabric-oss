import assert from "node:assert/strict";
import { test } from "node:test";
import type { Redis } from "@upstash/redis";
import type { McpSession } from "../../session/types";
import { ApprovalHandler } from "../approval-handler";

test("generates a cryptographic approval ID without Math.random", async (t) => {
	const random = t.mock.method(Math, "random", () => 0.5);
	const set = t.mock.fn(async (_key: string) => {});
	const handler = new ApprovalHandler({ set } as unknown as Redis);
	const session = {
		sessionId: "example-session",
		userId: "example-user",
		organizationId: "example-org",
	} as McpSession;

	const request = await handler.createApprovalRequest(session, "example", {});

	assert.match(
		request.id,
		/^apr_\d+_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);
	assert.equal(random.mock.callCount(), 0);
	assert.equal(set.mock.calls[0]?.arguments[0], `mcp:approval:${request.id}`);
});
