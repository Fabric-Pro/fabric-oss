/**
 * `POST /api/internal/slack-search` and `POST /api/internal/teams-search`
 * previously passed the request body's `projectId` straight into the search
 * activity after only verifying the AI token's signature — an authenticated
 * caller from any project (or organization) could search another project's
 * Slack/Teams messages just by naming its id. The fix copies the
 * `hasProjectAccess` + tenant-org-equality check that
 * `/api/internal/project-context-search` already runs after
 * `verifyAIToken` and before the activity call.
 *
 * Mocking style follows `apps/web/__tests__/api/mcp-organization-header.test.ts`:
 * module-level `vi.fn()`s wired through `vi.mock`, requests built with
 * `new Request(...)`.
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

const hasProjectAccess = vi.fn();
const projectFindUnique = vi.fn();
vi.mock("@repo/database", () => ({
	db: { project: { findUnique: (args: unknown) => projectFindUnique(args) } },
	hasProjectAccess: (
		projectId: string,
		userId: string,
		organizationId: string | undefined,
	) => hasProjectAccess(projectId, userId, organizationId),
}));

const searchProjectSlackMessages = vi.fn();
const searchProjectTeamsMessages = vi.fn();
vi.mock("@repo/temporal/activities", () => ({
	searchProjectSlackMessages: (input: unknown) =>
		searchProjectSlackMessages(input),
	searchProjectTeamsMessages: (input: unknown) =>
		searchProjectTeamsMessages(input),
}));

function callRoute(
	handler: (req: Request) => Promise<Response>,
	url: string,
	body: unknown,
	token: string | null = TOKEN,
) {
	const headers = new Headers({ "content-type": "application/json" });
	if (token) {
		headers.set("X-AI-Token", token);
	}
	return handler(
		new Request(url, {
			method: "POST",
			headers,
			body: JSON.stringify(body),
		}),
	);
}

describe.each([
	{
		name: "slack-search",
		url: "https://example.test/api/internal/slack-search",
		routeModule: () =>
			import("../../../app/api/internal/slack-search/route"),
		activityMock: searchProjectSlackMessages,
		body: { projectId: PROJECT_ID, query: "deploy status" },
	},
	{
		name: "teams-search",
		url: "https://example.test/api/internal/teams-search",
		routeModule: () =>
			import("../../../app/api/internal/teams-search/route"),
		activityMock: searchProjectTeamsMessages,
		body: { projectId: PROJECT_ID, query: "deploy status" },
	},
])("POST /api/internal/$name", ({ url, routeModule, activityMock, body }) => {
	beforeEach(() => {
		vi.clearAllMocks();
		verifyAIToken.mockResolvedValue({
			valid: true,
			claims: { sub: USER_ID, org: ORG_ID },
		});
		hasProjectAccess.mockResolvedValue(true);
		projectFindUnique.mockResolvedValue({ organizationId: ORG_ID });
		activityMock.mockResolvedValue({ messages: [], totalCount: 0 });
	});

	it("403s a valid token for a user without access to the project", async () => {
		hasProjectAccess.mockResolvedValue(false);
		const { POST } = await routeModule();

		const response = await callRoute(POST, url, body);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "You do not have access to this project",
		});
		expect(activityMock).not.toHaveBeenCalled();
	});

	it("403s a valid token whose org does not match the project's org (tenant mismatch)", async () => {
		projectFindUnique.mockResolvedValue({ organizationId: "org-other" });
		const { POST } = await routeModule();

		const response = await callRoute(POST, url, body);

		expect(response.status).toBe(403);
		expect(await response.json()).toEqual({
			error: "Tenant context mismatch",
		});
		expect(activityMock).not.toHaveBeenCalled();
	});

	it("404s when the project no longer exists", async () => {
		projectFindUnique.mockResolvedValue(null);
		const { POST } = await routeModule();

		const response = await callRoute(POST, url, body);

		expect(response.status).toBe(404);
		expect(await response.json()).toEqual({ error: "Project not found" });
		expect(activityMock).not.toHaveBeenCalled();
	});

	it("grants access and calls the search activity when the token's user/org can access the project", async () => {
		const { POST } = await routeModule();

		const response = await callRoute(POST, url, body);

		expect(response.status).toBe(200);
		expect(hasProjectAccess).toHaveBeenCalledWith(
			PROJECT_ID,
			USER_ID,
			ORG_ID,
		);
		expect(activityMock).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT_ID,
				userId: USER_ID,
				organizationId: ORG_ID,
			}),
		);
	});
});
