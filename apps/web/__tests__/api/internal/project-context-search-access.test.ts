/** Project context search binds one permission decision to the token's organization. */

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

const getProjectPermissionDecision = vi.fn();
vi.mock("@repo/api/lib/project-permission-decision", () => ({
	getProjectPermissionDecision: (input: unknown) =>
		getProjectPermissionDecision(input),
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
		getProjectPermissionDecision.mockResolvedValue({
			allowed: true,
			organizationId: ORG_ID,
		});
		retrieveProjectContexts.mockResolvedValue([]);
		formatContextsForPrompt.mockReturnValue("");
	});

	const body = { projectId: PROJECT_ID, query: "deploy status" };

	it("403s a valid token for a user without access to the project", async () => {
		getProjectPermissionDecision.mockResolvedValue({
			allowed: false,
			organizationId: ORG_ID,
		});
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
		getProjectPermissionDecision.mockResolvedValue({
			allowed: true,
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
		expect(getProjectPermissionDecision).toHaveBeenCalledTimes(1);
		expect(getProjectPermissionDecision).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			userId: USER_ID,
			permission: "context:read",
		});
		expect(retrieveProjectContexts).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: PROJECT_ID, userId: USER_ID }),
		);
	});

	it("returns the guidance retrieval resolved, including a document folder's description", async () => {
		// Retrieval fills a folder file's guidance from its folder; the route
		// passes it through to the agent unchanged.
		retrieveProjectContexts.mockResolvedValue([
			{
				id: "file-1",
				type: "DOCUMENT",
				content: "Case study body",
				score: 0.8,
				filename: "case-study.docx",
				aiInstructions: "Signed case studies",
			},
		]);
		const { POST } = await import(
			"../../../app/api/internal/project-context-search/route"
		);

		const response = await callRoute(POST, body);

		expect((await response.json()).contexts).toEqual([
			{
				type: "DOCUMENT",
				source: "case-study.docx",
				relevance: 0.8,
				content: "Case study body",
				aiInstructions: "Signed case studies",
			},
		]);
	});
});
