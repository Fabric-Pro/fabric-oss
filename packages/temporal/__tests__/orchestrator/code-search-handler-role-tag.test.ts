import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {
		projectRepositoryIntegration: {
			findMany: vi.fn(),
		},
	},
	getMergedSearchProviderConfigs: vi.fn().mockResolvedValue([]),
	getProjectCodeIndexes: vi.fn().mockResolvedValue([]),
	getProjectReposForCodeSearch: vi.fn().mockResolvedValue([
		{
			provider: "GITHUB",
			owner: "fabric-org",
			repo: "auth-service",
			branch: "main",
			roleTag: "Legacy Auth",
		},
	]),
	parseRepoUrl: vi.fn().mockReturnValue({
		provider: "GITHUB",
		owner: "fabric-org",
		name: "auth-service",
	}),
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: vi.fn().mockReturnValue("ghp_decrypted"),
}));

vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: vi.fn().mockResolvedValue({
		token: "ghp_decrypted",
		method: "pat",
	}),
}));

vi.mock("@repo/integrations/github", () => ({
	getGitHubAccessToken: vi.fn(),
}));

vi.mock("@repo/connectors", () => ({
	searchRepositoryCode: vi.fn().mockResolvedValue([
		{
			filePath: "src/auth.ts",
			matchedSnippets: ["export function login() {}"],
		},
	]),
	getRepositoryFile: vi.fn(),
	listRepositoryStructure: vi.fn(),
}));

describe("orchestrator code-search-handler roleTag prefixing", () => {
	it("prefixes roleTag to matched search results header", async () => {
		const { CodeSearchHandler } = await import(
			"../../src/activities/orchestrator/execution/handlers/code-search-handler"
		);

		const handler = new CodeSearchHandler();
		const result = await handler.execute({
			input: {
				step: {
					id: "step-1",
					app: "code_search",
					inputs: { query: "login" },
				},
				projectId: "proj-1",
				userId: "user-1",
				organizationId: "org-1",
			} as any,
			variables: {},
			toolCalls: [],
			startTime: Date.now(),
		});

		expect(result.handled).toBe(true);
		expect(result.output?.response).toContain(
			"### Legacy Auth: src/auth.ts",
		);
		expect(result.output?.response).toContain("export function login() {}");
	});
});
