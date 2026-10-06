/**
 * `getTeamFieldValuesProcedure` against a rejected PAT.
 *
 * Azure DevOps answers an invalid or expired PAT with HTTP 203 and an HTML
 * sign-in page, and `Response.ok` is true for 203. The procedure must return
 * the auth error a 401 gets, not "Unexpected token '<'".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectFindUnique = vi.fn();
const mockResolveProjectPmConfig = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: (...a: unknown[]) => mockProjectFindUnique(...a),
		},
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (value: string) => `decrypted:${value}`,
}));

vi.mock("../../../../lib/gitlab-pm-source", () => ({
	resolveProjectPmConfig: (...a: unknown[]) =>
		mockResolveProjectPmConfig(...a),
}));

vi.mock("../../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {
		route: () => chain,
		input: () => chain,
		output: () => chain,
		use: () => chain,
		handler: (fn: unknown) => ({ handler: fn }),
	};
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: () => (handler: unknown) => handler,
		Permissions: { STORY_READ: "story:read" },
	};
});

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { getTeamFieldValuesProcedure } from "../get-team-field-values";

type Result = {
	defaultArea: string | null;
	areaPaths: string[];
	error: string | null;
};
const handler = (
	getTeamFieldValuesProcedure as unknown as {
		handler: (args: {
			input: { projectId: string; containerId: string; teamId: string };
			context: { user: { id: string } };
		}) => Promise<Result>;
	}
).handler;

const run = () =>
	handler({
		input: { projectId: "p1", containerId: "Proj", teamId: "Team" },
		context: { user: { id: "user-1" } },
	});

beforeEach(() => {
	vi.clearAllMocks();
	mockFetch.mockReset();
	mockProjectFindUnique.mockResolvedValue({
		id: "p1",
		organizationId: "org-1",
		projectManagementMcpServerId: "srv",
		projectManagementMcpConfigId: "cfg",
		projectManagementAdditionalContext: null,
	});
	mockResolveProjectPmConfig.mockResolvedValue({
		mcpServer: { key: "azure-devops", command: null },
		encryptedApiKey: "enc-pat",
		commandArgs: ["example-org"],
		baseUrl: null,
	});
});

describe("getTeamFieldValuesProcedure", () => {
	it("returns the team's area paths on a 200", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					defaultValue: "Proj\\Team",
					values: [{ value: "Proj\\Team" }],
				}),
				{ status: 200 },
			),
		);

		expect(await run()).toEqual({
			defaultArea: "Proj\\Team",
			areaPaths: ["Proj\\Team"],
			error: null,
		});
	});

	it("returns an auth error for a 401", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response("unauthorized", { status: 401 }),
		);

		const result = await run();

		expect(result.areaPaths).toEqual([]);
		expect(result.error).toMatch(/^Azure DevOps API error \(401\)/);
	});

	it("returns the same auth error for ADO's 203 sign-in page", async () => {
		mockFetch.mockResolvedValueOnce(
			new Response("<html>sign in</html>", {
				status: 203,
				headers: { "content-type": "text/html" },
			}),
		);

		const result = await run();

		expect(result.defaultArea).toBeNull();
		expect(result.areaPaths).toEqual([]);
		expect(result.error).toMatch(/^Azure DevOps API error \(401\)/);
		expect(result.error).not.toMatch(/Unexpected token|JSON/i);
	});
});
