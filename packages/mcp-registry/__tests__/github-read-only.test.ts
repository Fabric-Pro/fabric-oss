import { expect, it } from "vitest";
import { GITHUB_ACCOUNT } from "../src/conditional-accounts";
const reads = [
	"list_repositories",
	"get_repository",
	"list_issues",
	"get_issue",
	"get_pull_request",
	"list_pull_requests",
	"get_file_contents",
	"list_branches",
	"get_authenticated_user",
	"search_commits",
	"get_commit",
];
it("declares GitHub reads and leaves its two writes unflagged", () => {
	const tools = GITHUB_ACCOUNT.mcps.flatMap((mcp) => mcp.tools ?? []);
	expect(
		tools
			.filter(
				(tool) => (tool as { readOnly?: boolean }).readOnly === true,
			)
			.map((tool) => tool.name)
			.sort(),
	).toEqual([...reads].sort());
	expect(
		tools
			.filter(
				(tool) => (tool as { readOnly?: boolean }).readOnly !== true,
			)
			.map((tool) => tool.name)
			.sort(),
	).toEqual(["create_issue", "create_pull_request"]);
});
