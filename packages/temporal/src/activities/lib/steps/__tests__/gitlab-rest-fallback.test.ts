import { GitLabMcpMethodNotFoundError } from "@repo/integrations/gitlab";
import { describe, expect, it, vi } from "vitest";

vi.mock("../gitlab-resolver", () => ({
	resolveGitLabSourceForStep: vi.fn(),
	resolveGitLabRestTokenForStep: vi.fn(async () => "rest-token-from-WI"),
}));

// Mock the REST helpers so a successful fallback can complete without
// hitting the network. The bug we are reproducing is that the closure
// in each step file throws *before* these are reached.
vi.mock("@repo/integrations/gitlab", async () => {
	const actual = await vi.importActual<
		typeof import("@repo/integrations/gitlab")
	>("@repo/integrations/gitlab");
	return {
		...actual,
		gitlabFetch: vi.fn(async () => []),
		gitlabPost: vi.fn(async () => ({ id: 99, web_url: "u", title: "t" })),
	};
});

import { executeGitLabCreateIssueStep } from "../gitlab-create-issue";
import { executeGitLabGetFileStep } from "../gitlab-get-file";
import { resolveGitLabSourceForStep } from "../gitlab-resolver";
import { executeGitLabSearchIssuesStep } from "../gitlab-search-issues";

const mockedResolver = vi.mocked(resolveGitLabSourceForStep);

function officialMcpThatThrowsMethodNotFound(method: string) {
	return {
		kind: "official-mcp" as const,
		callTool: vi.fn(async () => {
			throw new GitLabMcpMethodNotFoundError(
				`Method not found: ${method}`,
			);
		}),
	};
}

describe("GitLab Temporal steps — REST fallback after official MCP -32601", () => {
	it("gitlab-search-issues falls back to REST instead of throwing 'REST fallback requires a REST source'", async () => {
		mockedResolver.mockResolvedValueOnce(
			officialMcpThatThrowsMethodNotFound("list_issues"),
		);

		const result = await executeGitLabSearchIssuesStep({
			nodeConfig: { projectId: "g/p", search: "bug" },
			inputs: {},
			userId: "u1",
			organizationId: undefined,
		});

		expect(result.error).not.toBe("REST fallback requires a REST source");
		expect(result.success).toBe(true);
	});

	it("gitlab-get-file falls back to REST instead of throwing 'REST fallback requires a REST source'", async () => {
		mockedResolver.mockResolvedValueOnce(
			officialMcpThatThrowsMethodNotFound("get_file_contents"),
		);

		const result = await executeGitLabGetFileStep({
			nodeConfig: {
				projectId: "g/p",
				filePath: "README.md",
				ref: "main",
			},
			inputs: {},
			userId: "u1",
			organizationId: undefined,
		});

		expect(result.error).not.toBe("REST fallback requires a REST source");
		expect(result.success).toBe(true);
	});

	it("gitlab-create-issue falls back to REST instead of throwing 'REST fallback requires a REST source'", async () => {
		mockedResolver.mockResolvedValueOnce(
			officialMcpThatThrowsMethodNotFound("create_issue"),
		);

		const result = await executeGitLabCreateIssueStep({
			nodeConfig: { projectId: "g/p", title: "hi" },
			inputs: {},
			userId: "u1",
			organizationId: undefined,
		});

		expect(result.error).not.toBe("REST fallback requires a REST source");
		expect(result.success).toBe(true);
	});
});
