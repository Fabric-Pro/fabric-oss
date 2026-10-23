import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	access: vi.fn(),
	repositories: vi.fn(),
	project: vi.fn(),
	token: vi.fn(),
	search: vi.fn(),
	file: vi.fn(),
	tree: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getProjectAccessContext: h.access,
	getProjectReposForCodeSearch: h.repositories,
	db: { project: { findUnique: h.project } },
	parseRepoUrl: vi.fn(),
}));
vi.mock("@repo/utils", () => ({ decryptApiKey: vi.fn() }));
vi.mock("@repo/integrations/repo-auth", () => ({
	resolveFreshRepoTokenForRow: h.token,
}));
vi.mock("@repo/integrations/github", () => ({ getGitHubAccessToken: vi.fn() }));
vi.mock("@repo/connectors", () => ({
	searchRepositoryCode: h.search,
	getRepositoryFile: h.file,
	listRepositoryStructure: h.tree,
}));

import { CodeSearchHandler } from "../../src/activities/orchestrator/execution/handlers/code-search-handler";

async function read(toolName: string) {
	return new CodeSearchHandler().execute({
		input: {
			step: {
				id: "step-example",
				app: toolName,
				inputs: { query: "example", path: "src/example.ts" },
			},
			projectId: "project-example",
			userId: "user-example",
			organizationId: "example-org",
		} as never,
		variables: {},
		toolCalls: [],
		startTime: 0,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	h.access.mockResolvedValue({ organizationId: "example-org" });
	h.repositories.mockResolvedValue([
		{
			provider: "GITHUB",
			owner: "example-org",
			repo: "app",
			branch: "main",
		},
	]);
	h.project.mockResolvedValue(null);
	h.token.mockResolvedValue({ token: "example-token", method: "pat" });
	h.search.mockResolvedValue({ results: [] });
	h.file.mockResolvedValue({
		content: "export const example = true;",
		path: "src/example.ts",
	});
	h.tree.mockResolvedValue({
		entries: [{ path: "src/example.ts", type: "file" }],
		totalFiles: 1,
		totalDirectories: 0,
		truncated: false,
	});
});

describe.each(["code_tree", "code_file_get", "code_search"])(
	"%s project access",
	(toolName) => {
		it("reads the repository when access is granted", async () => {
			const result = await read(toolName);
			expect(result.handled).toBe(true);
			expect(result.output?.toolCalls?.at(-1)?.status).toBe("success");
			expect(h.access).toHaveBeenCalledWith(
				"project-example",
				"user-example",
			);
			expect(h.repositories).toHaveBeenCalledWith("project-example");
			const connector =
				toolName === "code_tree"
					? h.tree
					: toolName === "code_file_get"
						? h.file
						: h.search;
			expect(connector).toHaveBeenCalledTimes(1);
		});
	},
);

describe.each([
	"code_tree",
	"code_file_get",
	"code_search",
	"code_search_semantic",
])("%s denies before repository reads", (toolName) => {
	it.each(["missing access", "other organization", "lookup throws"])(
		"denies %s",
		async (denial) => {
			if (denial === "lookup throws") {
				h.access.mockRejectedValue(new Error("lookup unavailable"));
			} else {
				h.access.mockResolvedValue(
					denial === "missing access"
						? null
						: { organizationId: "another-example-org" },
				);
			}
			const result = await read(toolName);
			expect(result.handled).toBe(true);
			expect(result.output?.response).toBe(
				"You do not have access to this project's code.",
			);
			expect(result.output?.toolCalls).toEqual([
				expect.objectContaining({
					name: toolName,
					status: "error",
					result: {
						message:
							"You do not have access to this project's code.",
					},
				}),
			]);
			expect(h.repositories).not.toHaveBeenCalled();
			expect(h.project).not.toHaveBeenCalled();
			expect(h.token).not.toHaveBeenCalled();
			expect(h.tree).not.toHaveBeenCalled();
			expect(h.file).not.toHaveBeenCalled();
			expect(h.search).not.toHaveBeenCalled();
		},
	);
});

// A bound tool must not retain the access decision from an earlier read.
describe.each(["code_tree", "code_file_get"])(
	"%s after access revocation",
	(toolName) => {
		it("checks again before the next read", async () => {
			await read(toolName);
			vi.clearAllMocks();
			h.access.mockResolvedValue(null);
			const result = await read(toolName);
			expect(result.output?.response).toBe(
				"You do not have access to this project's code.",
			);
			expect(h.access).toHaveBeenCalledWith(
				"project-example",
				"user-example",
			);
			expect(h.repositories).not.toHaveBeenCalled();
			expect(h.token).not.toHaveBeenCalled();
			expect(h.tree).not.toHaveBeenCalled();
			expect(h.file).not.toHaveBeenCalled();
		});
	},
);
