/**
 * `POST /api/internal/slack-tools` used to call `hasProjectAccess` and then
 * re-fetch the same `Project` row a second time just to read
 * `organizationId` for the tenant-XOR check.
 *
 * `getProjectAccessContext` now resolves the access decision and
 * `organizationId` in one query. `isAuthorizedChannel` still runs
 * sequentially, after access and the tenant-XOR check pass — same as
 * before — so a channel unlinked at scoping-check time is never honoured
 * just because it happened to look linked earlier, and no channel-scoping
 * query runs for a caller who fails access or XOR.
 *
 * These tests pin the responses that must survive unchanged (403 no access,
 * 403 tenant-XOR mismatch, 403 channel-not-linked) and confirm the project
 * is resolved with a single access-context call.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "signed.ai.token";
const PROJECT_ID = "project-1";
const USER_ID = "user-1";
const ORG_ID = "org-1";
const CHANNEL_ID = "C123";

const verifyAIToken = vi.fn();
vi.mock("@repo/ai-token", () => ({
	AI_TOKEN_HEADER: "X-AI-Token",
	verifyAIToken: (token: string) => verifyAIToken(token),
}));

const getProjectAccessContext = vi.fn();
const projectContextCount = vi.fn();
const projectContextFindMany = vi.fn();
vi.mock("@repo/database", () => ({
	db: {
		projectContext: {
			count: (args: unknown) => projectContextCount(args),
			findMany: (args: unknown) => projectContextFindMany(args),
		},
	},
	getProjectAccessContext: (projectId: string, userId: string) =>
		getProjectAccessContext(projectId, userId),
}));

const executeSlackTool = vi.fn();
vi.mock("@repo/integrations/slack", () => ({
	executeSlackTool: (...a: unknown[]) => executeSlackTool(...a),
}));

function callRoute(
	handler: (req: Request) => Promise<Response>,
	body: unknown,
	token: string | null = TOKEN,
) {
	const headers = new Headers({ "content-type": "application/json" });
	if (token) {
		headers.set("X-AI-Token", token);
	}
	return handler(
		new Request("https://example.test/api/internal/slack-tools", {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		}),
	);
}

describe("POST /api/internal/slack-tools", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		verifyAIToken.mockResolvedValue({
			valid: true,
			claims: { sub: USER_ID, org: ORG_ID },
		});
		getProjectAccessContext.mockResolvedValue({ organizationId: ORG_ID });
		projectContextCount.mockResolvedValue(1);
		executeSlackTool.mockResolvedValue({ ok: true });
	});

	const body = {
		toolName: "get_channel_messages",
		args: { channel: CHANNEL_ID },
		projectId: PROJECT_ID,
	};

	it("403s a valid token for a user without access to the project, without running the channel-authorization check", async () => {
		getProjectAccessContext.mockResolvedValue(null);
		const { POST } = await import(
			"../../../app/api/internal/slack-tools/route"
		);

		const response = await callRoute(POST, body);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "You do not have access to this project",
		});
		expect(executeSlackTool).not.toHaveBeenCalled();
		// The channel-authorization query runs only after access and the
		// tenant-XOR check pass — no speculative work for a denied caller.
		expect(projectContextCount).not.toHaveBeenCalled();
	});

	it("403s a valid token whose org does not match the project's org (tenant mismatch)", async () => {
		getProjectAccessContext.mockResolvedValue({
			organizationId: "org-other",
		});
		const { POST } = await import(
			"../../../app/api/internal/slack-tools/route"
		);

		const response = await callRoute(POST, body);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Tenant context mismatch",
		});
		expect(executeSlackTool).not.toHaveBeenCalled();
	});

	it("403s when the channel is not linked to the project", async () => {
		projectContextCount.mockResolvedValue(0);
		const { POST } = await import(
			"../../../app/api/internal/slack-tools/route"
		);

		const response = await callRoute(POST, body);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "The specified channel is not linked to this project",
		});
		expect(executeSlackTool).not.toHaveBeenCalled();
	});

	it("grants access and runs the tool when access and channel authorization both succeed", async () => {
		const { POST } = await import(
			"../../../app/api/internal/slack-tools/route"
		);

		const response = await callRoute(POST, body);

		expect(response.status).toBe(200);
		expect(getProjectAccessContext).toHaveBeenCalledTimes(1);
		expect(getProjectAccessContext).toHaveBeenCalledWith(
			PROJECT_ID,
			USER_ID,
		);
		expect(executeSlackTool).toHaveBeenCalledWith(
			"get_channel_messages",
			body.args,
			USER_ID,
			ORG_ID,
		);
	});
});
