/**
 * `POST /api/internal/project-context-search` used to call `hasProjectAccess`
 * and then re-fetch the same `Project` row a second time (`db.project.findUnique`)
 * just to read `organizationId` for the tenant-XOR check. `getProjectAccessContext`
 * now resolves both in one query, so this route no longer imports `db` at all.
 *
 * These tests pin the two responses that must survive the consolidation
 * unchanged — the 403 for no access and the 403 for a tenant-XOR mismatch —
 * and confirm the route resolves access with a single call.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "signed.ai.token";
const PROJECT_ID = "project-1";
const USER_ID = "user-1";
const ORG_ID = "org-1";

const verifyAIToken = vi.fn();
vi.mock("@repo/ai-token", () => ({
	AI_TOKEN_HEADER: "X-AI-Token",
	verifyAIToken: (token: string) => verifyAIToken(token),
}));

const getProjectAccessContext = vi.fn();
vi.mock("@repo/database", () => ({
	getProjectAccessContext: (projectId: string, userId: string) =>
		getProjectAccessContext(projectId, userId),
}));

const retrieveProjectContexts = vi.fn();
const formatContextsForPrompt = vi.fn();
vi.mock("@repo/rag", () => ({
	retrieveProjectContexts: (input: unknown) => retrieveProjectContexts(input),
	formatContextsForPrompt: (contexts: unknown) =>
		formatContextsForPrompt(contexts),
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
		new Request(
			"https://example.test/api/internal/project-context-search",
			{
				method: "POST",
				headers,
				body: JSON.stringify(body),
			},
		),
	);
}

describe("POST /api/internal/project-context-search", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		verifyAIToken.mockResolvedValue({
			valid: true,
			claims: { sub: USER_ID, org: ORG_ID },
		});
		getProjectAccessContext.mockResolvedValue({ organizationId: ORG_ID });
		retrieveProjectContexts.mockResolvedValue([]);
		formatContextsForPrompt.mockReturnValue("");
	});

	const body = { projectId: PROJECT_ID, query: "deploy status" };

	it("403s a valid token for a user without access to the project", async () => {
		getProjectAccessContext.mockResolvedValue(null);
		const { POST } = await import(
			"../../../app/api/internal/project-context-search/route"
		);

		const response = await callRoute(POST, body);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "You do not have access to this project",
		});
		expect(retrieveProjectContexts).not.toHaveBeenCalled();
	});

	it("403s a valid token whose org does not match the project's org (tenant mismatch)", async () => {
		getProjectAccessContext.mockResolvedValue({
			organizationId: "org-other",
		});
		const { POST } = await import(
			"../../../app/api/internal/project-context-search/route"
		);

		const response = await callRoute(POST, body);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Tenant context mismatch",
		});
		expect(retrieveProjectContexts).not.toHaveBeenCalled();
	});

	it("grants access and searches when the token's user/org can access the project", async () => {
		const { POST } = await import(
			"../../../app/api/internal/project-context-search/route"
		);

		const response = await callRoute(POST, body);

		expect(response.status).toBe(200);
		expect(getProjectAccessContext).toHaveBeenCalledTimes(1);
		expect(getProjectAccessContext).toHaveBeenCalledWith(
			PROJECT_ID,
			USER_ID,
		);
		expect(retrieveProjectContexts).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: PROJECT_ID, userId: USER_ID }),
		);
	});
});
