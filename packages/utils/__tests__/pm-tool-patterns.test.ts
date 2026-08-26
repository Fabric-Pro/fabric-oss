/**
 * PM Tool Patterns Tests
 *
 * Tests for shared PM tool patterns used across:
 * - packages/temporal/src/activities/pm-integration/story-sync.ts
 * - packages/temporal/src/activities/pm-integration/tool-analyzer.ts
 * - apps/web/modules/saas/projects/lib/pm-tool-analyzer.ts
 * - packages/api/modules/projects/procedures/stories/sync/import-from-pm.ts
 *
 * These patterns are critical for the story sync workflow - if they break,
 * pushing/pulling stories to PM tools will fail.
 */

import { describe, expect, it } from "vitest";
import {
	// Constants
	COMMON_ID_FIELDS,
	detectPMType,
	extractContainerType,
	extractIdFromResponse,
	extractNameFromResponse,
	extractUrlFromResponse,
	findBacklogsListTool,
	// Utility functions
	findBestMatchingParam,
	hasNativeTestCaseSupport,
	isContainerListingTool,
	isTaskCreationTool,
	isTaskGetTool,
	isTaskListTool,
	isTaskUpdateTool,
	isTestCaseTool,
	KNOWN_PM_DOMAINS,
	normalizeUrl,
	PM_TOOL_TYPES,
	pmDetectedTypeDisplayName,
	pmServerKeyToDetectedType,
	TASK_ID_PARAM_PATTERNS,
} from "../lib/pm-tool-patterns";

// =============================================================================
// ID Extraction Tests
// =============================================================================

describe("extractIdFromResponse", () => {
	describe("with idParamHint (dynamic discovery)", () => {
		it("should extract ID using hint from Fizzy (card_number)", () => {
			const response = { id: 123, number: 456, card_number: 789 };
			const id = extractIdFromResponse(response, "number");
			expect(id).toBe("456");
		});

		it("should extract ID using hint from Jira (issue_key)", () => {
			const response = {
				id: "10001",
				key: "PROJ-123",
				issue_key: "PROJ-456",
			};
			const id = extractIdFromResponse(response, "issue_key");
			expect(id).toBe("PROJ-456");
		});

		it("should extract ID using hint from GitHub (issue_number)", () => {
			const response = { id: 999, number: 42, issue_number: 42 };
			const id = extractIdFromResponse(response, "issue_number");
			expect(id).toBe("42");
		});

		it("should fall back to common fields when hint not found", () => {
			const response = { id: "fallback-id", name: "Test" };
			const id = extractIdFromResponse(response, "nonexistent_field");
			expect(id).toBe("fallback-id");
		});
	});

	describe("without idParamHint (fallback patterns)", () => {
		it("should extract 'number' first (Fizzy priority)", () => {
			const response = { id: "123", number: "456" };
			const id = extractIdFromResponse(response);
			expect(id).toBe("456");
		});

		it("should extract 'card_number' for explicit Fizzy field", () => {
			const response = { id: "123", card_number: "789" };
			const id = extractIdFromResponse(response);
			expect(id).toBe("789");
		});

		it("should extract 'issue_number' for GitHub", () => {
			const response = { id: "123", issue_number: "42" };
			const id = extractIdFromResponse(response);
			expect(id).toBe("42");
		});

		it("should fall back to 'id' when specific fields not found", () => {
			const response = { id: "fallback", name: "Test" };
			const id = extractIdFromResponse(response);
			expect(id).toBe("fallback");
		});

		it("should extract 'key' for Jira", () => {
			const response = { key: "PROJ-123", summary: "Test issue" };
			const id = extractIdFromResponse(response);
			expect(id).toBe("PROJ-123");
		});

		it("should return undefined for empty response", () => {
			const id = extractIdFromResponse({});
			expect(id).toBeUndefined();
		});
	});
});

describe("extractNameFromResponse", () => {
	it("should extract 'name' field", () => {
		const response = { name: "Test Name", title: "Test Title" };
		expect(extractNameFromResponse(response)).toBe("Test Name");
	});

	it("should extract 'title' when name not present", () => {
		const response = { title: "Test Title", description: "Desc" };
		expect(extractNameFromResponse(response)).toBe("Test Title");
	});

	it("should extract 'display_name' (snake_case)", () => {
		const response = { display_name: "Display Name" };
		expect(extractNameFromResponse(response)).toBe("Display Name");
	});

	it("should extract 'displayName' (camelCase)", () => {
		const response = { displayName: "Camel Display Name" };
		expect(extractNameFromResponse(response)).toBe("Camel Display Name");
	});
});

describe("extractUrlFromResponse", () => {
	it("should extract 'url' field", () => {
		const response = { url: "https://example.com/item/1" };
		expect(extractUrlFromResponse(response)).toBe(
			"https://example.com/item/1",
		);
	});

	it("should extract 'html_url' (GitHub style)", () => {
		const response = { html_url: "https://github.com/owner/repo/issues/1" };
		expect(extractUrlFromResponse(response)).toBe(
			"https://github.com/owner/repo/issues/1",
		);
	});

	it("should extract 'web_url' (GitLab style)", () => {
		const response = {
			web_url: "https://gitlab.com/owner/repo/-/issues/1",
		};
		expect(extractUrlFromResponse(response)).toBe(
			"https://gitlab.com/owner/repo/-/issues/1",
		);
	});

	it("should extract 'shortUrl' (Trello style)", () => {
		const response = { shortUrl: "https://trello.com/c/abc123" };
		expect(extractUrlFromResponse(response)).toBe(
			"https://trello.com/c/abc123",
		);
	});

	it("should extract 'permalink' field", () => {
		const response = { permalink: "https://example.com/p/item-1" };
		expect(extractUrlFromResponse(response)).toBe(
			"https://example.com/p/item-1",
		);
	});

	// Azure DevOps regression: REST responses carry both a `url` (REST API)
	// and `_links.html.href` (web UI). The web link must win — otherwise
	// stored URLs point to JSON endpoints that render gibberish in the
	// browser. Real-world ADO `wit_get_work_item` payload shape.
	it("should prefer _links.html.href over top-level 'url' (Azure DevOps)", () => {
		const response = {
			id: 149,
			url: "https://dev.azure.com/example-org/proj/_apis/wit/workItems/149",
			_links: {
				self: {
					href: "https://dev.azure.com/example-org/proj/_apis/wit/workItems/149",
				},
				html: {
					href: "https://dev.azure.com/example-org/proj/_workitems/edit/149",
				},
			},
		};
		expect(extractUrlFromResponse(response)).toBe(
			"https://dev.azure.com/example-org/proj/_workitems/edit/149",
		);
	});

	it("should fall back to _links.web.href when _links.html is missing", () => {
		const response = {
			url: "https://dev.azure.com/org/proj/_apis/wit/workItems/42",
			_links: {
				web: {
					href: "https://dev.azure.com/org/proj/_workitems/edit/42",
				},
			},
		};
		expect(extractUrlFromResponse(response)).toBe(
			"https://dev.azure.com/org/proj/_workitems/edit/42",
		);
	});

	it("should keep top-level 'url' when _links is absent", () => {
		const response = { url: "https://example.com/item/1" };
		expect(extractUrlFromResponse(response)).toBe(
			"https://example.com/item/1",
		);
	});

	it("should ignore malformed _links entries", () => {
		const response = {
			url: "https://example.com/fallback",
			_links: { html: "not-an-object", web: { href: 42 } },
		};
		expect(extractUrlFromResponse(response)).toBe(
			"https://example.com/fallback",
		);
	});
});

// =============================================================================
// URL Normalization Tests
// =============================================================================

describe("normalizeUrl", () => {
	describe("absolute URLs", () => {
		it("should return absolute URLs as-is", () => {
			expect(normalizeUrl("https://example.com/path")).toBe(
				"https://example.com/path",
			);
			expect(normalizeUrl("http://example.com/path")).toBe(
				"http://example.com/path",
			);
		});

		it("should remove .json suffix (Fizzy API)", () => {
			expect(
				normalizeUrl("https://fizzy.do/account/board/card.json"),
			).toBe("https://fizzy.do/account/board/card");
		});
	});

	describe("relative URLs with baseUrl", () => {
		it("should construct full URL from relative path", () => {
			const result = normalizeUrl(
				"/account/board/card",
				"https://fizzy.do",
			);
			expect(result).toBe("https://fizzy.do/account/board/card");
		});

		it("should handle baseUrl with trailing path", () => {
			const result = normalizeUrl(
				"/api/v1/cards/123",
				"https://api.example.com/v2/",
			);
			expect(result).toBe("https://api.example.com/api/v1/cards/123");
		});
	});

	describe("known PM domains without protocol", () => {
		it("should add https:// for trello.com", () => {
			expect(normalizeUrl("trello.com/c/abc123")).toBe(
				"https://trello.com/c/abc123",
			);
		});

		it("should add https:// for github.com", () => {
			expect(normalizeUrl("github.com/owner/repo/issues/1")).toBe(
				"https://github.com/owner/repo/issues/1",
			);
		});

		it("should add https:// for linear.app", () => {
			expect(normalizeUrl("linear.app/team/issue")).toBe(
				"https://linear.app/team/issue",
			);
		});

		it("should add https:// for fizzy.do", () => {
			expect(normalizeUrl("fizzy.do/account/board/card")).toBe(
				"https://fizzy.do/account/board/card",
			);
		});

		it("should add https:// for jira subdomain", () => {
			expect(normalizeUrl("company.jira.com/browse/PROJ-123")).toBe(
				"https://company.jira.com/browse/PROJ-123",
			);
		});
	});

	describe("edge cases", () => {
		it("should return undefined for null/undefined", () => {
			expect(normalizeUrl(null)).toBeUndefined();
			expect(normalizeUrl(undefined)).toBeUndefined();
		});

		it("should return undefined for empty string", () => {
			expect(normalizeUrl("")).toBeUndefined();
			expect(normalizeUrl("   ")).toBeUndefined();
		});

		it("should return undefined for relative path without baseUrl", () => {
			expect(normalizeUrl("/relative/path")).toBeUndefined();
		});

		it("should handle domain-like strings", () => {
			expect(normalizeUrl("custom-tool.example.com/path")).toBe(
				"https://custom-tool.example.com/path",
			);
		});
	});
});

// =============================================================================
// Tool Detection Tests
// =============================================================================

describe("isTaskCreationTool", () => {
	it("should detect create_card", () => {
		expect(isTaskCreationTool("create_card")).toBe(true);
		expect(isTaskCreationTool("fizzy_create_card")).toBe(true);
	});

	it("should detect create_issue", () => {
		expect(isTaskCreationTool("create_issue")).toBe(true);
		expect(isTaskCreationTool("linear_create_issue")).toBe(true);
		expect(isTaskCreationTool("github_create_issue")).toBe(true);
	});

	it("should detect add_task", () => {
		expect(isTaskCreationTool("add_task")).toBe(true);
		expect(isTaskCreationTool("asana_add_task")).toBe(true);
	});

	it("should detect camelCase variants", () => {
		expect(isTaskCreationTool("createCard")).toBe(true);
		expect(isTaskCreationTool("createIssue")).toBe(true);
		expect(isTaskCreationTool("addTask")).toBe(true);
	});

	it("should detect Azure DevOps create_work_item", () => {
		expect(isTaskCreationTool("create_work_item")).toBe(true);
		expect(isTaskCreationTool("mcp_ado_wit_create_work_item")).toBe(true);
	});

	it("should detect Atlassian Rovo product-infix camelCase (createJiraIssue)", () => {
		expect(isTaskCreationTool("createJiraIssue")).toBe(true);
	});

	it("should NOT mistake comment/link tools for creation (bounded infix)", () => {
		// add + Comment/To/Jira + Issue = 3 infix words → must not match.
		expect(isTaskCreationTool("addCommentToJiraIssue")).toBe(false);
		expect(isTaskCreationTool("createIssueLink")).toBe(false); // ends "Link"
		expect(isTaskCreationTool("createConfluencePage")).toBe(false); // not a task noun
	});

	it("should not match non-creation tools", () => {
		expect(isTaskCreationTool("get_card")).toBe(false);
		expect(isTaskCreationTool("update_issue")).toBe(false);
		expect(isTaskCreationTool("list_tasks")).toBe(false);
	});
});

describe("isTaskUpdateTool", () => {
	it("should detect update_card", () => {
		expect(isTaskUpdateTool("update_card")).toBe(true);
		expect(isTaskUpdateTool("fizzy_update_card")).toBe(true);
	});

	it("should detect edit_issue", () => {
		expect(isTaskUpdateTool("edit_issue")).toBe(true);
	});

	it("should detect modify_task", () => {
		expect(isTaskUpdateTool("modify_card")).toBe(true);
	});

	it("should detect Azure DevOps update_work_item", () => {
		expect(isTaskUpdateTool("update_work_item")).toBe(true);
		expect(isTaskUpdateTool("mcp_ado_wit_update_work_item")).toBe(true);
	});

	it("should detect Atlassian Rovo product-infix camelCase (editJiraIssue)", () => {
		expect(isTaskUpdateTool("editJiraIssue")).toBe(true);
	});

	it("should not match non-update tools", () => {
		expect(isTaskUpdateTool("create_card")).toBe(false);
		expect(isTaskUpdateTool("get_card")).toBe(false);
		expect(isTaskUpdateTool("createJiraIssue")).toBe(false);
	});
});

describe("isTaskGetTool", () => {
	it("should detect get_card", () => {
		expect(isTaskGetTool("get_card")).toBe(true);
		expect(isTaskGetTool("fizzy_get_card")).toBe(true);
	});

	it("should detect get_issue", () => {
		expect(isTaskGetTool("get_issue")).toBe(true);
	});

	it("should detect read_task", () => {
		expect(isTaskGetTool("read_card")).toBe(true);
	});

	it("should detect Azure DevOps get_work_item", () => {
		expect(isTaskGetTool("get_work_item")).toBe(true);
		expect(isTaskGetTool("mcp_ado_wit_get_work_item")).toBe(true);
	});

	it("should detect Atlassian Rovo product-infix camelCase (getJiraIssue)", () => {
		expect(isTaskGetTool("getJiraIssue")).toBe(true);
	});

	it("should NOT match Rovo non-get-issue tools that merely contain 'Issue'", () => {
		// ends "Links" / "Metadata" / "Jql" — not a get-issue tool.
		expect(isTaskGetTool("getJiraIssueRemoteIssueLinks")).toBe(false);
		expect(isTaskGetTool("getJiraIssueTypeMetaWithFields")).toBe(false);
		expect(isTaskGetTool("searchJiraIssuesUsingJql")).toBe(false);
	});

	it("should not match list or create tools", () => {
		expect(isTaskGetTool("list_cards")).toBe(false);
		expect(isTaskGetTool("create_card")).toBe(false);
	});
});

describe("isTaskListTool", () => {
	it("should detect list_cards", () => {
		expect(isTaskListTool("list_cards")).toBe(true);
		expect(isTaskListTool("fizzy_list_cards")).toBe(true);
	});

	it("should detect get_issues (plural)", () => {
		expect(isTaskListTool("get_issues")).toBe(true);
	});

	it("should detect search_issues", () => {
		expect(isTaskListTool("search_issues")).toBe(true);
	});

	it("should detect Azure DevOps list tools", () => {
		expect(isTaskListTool("list_work_items")).toBe(true);
		expect(isTaskListTool("wit_list_backlog_work_items")).toBe(true);
		expect(isTaskListTool("mcp_ado_wit_list_backlog_work_items")).toBe(
			true,
		);
	});
});

describe("isTestCaseTool", () => {
	it("detects native test-case tools (snake + camel)", () => {
		expect(isTestCaseTool("create_test_case")).toBe(true);
		expect(isTestCaseTool("createTestCase")).toBe(true);
		expect(isTestCaseTool("list_test_cases")).toBe(true);
		expect(isTestCaseTool("gitlab_create_test_case")).toBe(true);
	});

	it("detects Xray / Zephyr test-management vocabulary", () => {
		expect(isTestCaseTool("xray_create_test")).toBe(true);
		expect(isTestCaseTool("createTestExecution")).toBe(true);
		expect(isTestCaseTool("addTestToTestSet")).toBe(true);
		expect(isTestCaseTool("zephyr_create_cycle")).toBe(true);
		expect(isTestCaseTool("create_test_plan")).toBe(true);
	});

	it("does NOT match generic issue/task/CI tools", () => {
		for (const name of [
			"create_issue",
			"update_card",
			"get_work_item",
			"list_issues",
			"fizzy_create_card",
			"run_tests",
			"get_latest_test",
		]) {
			expect(isTestCaseTool(name)).toBe(false);
		}
	});
});

describe("hasNativeTestCaseSupport", () => {
	it("treats Azure DevOps as native regardless of tool names", () => {
		expect(
			hasNativeTestCaseSupport("azure-devops", ["wit_create_work_item"]),
		).toBe(true);
	});

	it("allows a non-ADO tool only when it exposes a test-case tool", () => {
		expect(
			hasNativeTestCaseSupport("jira", [
				"createJiraIssue",
				"xray_create_test",
			]),
		).toBe(true);
		expect(
			hasNativeTestCaseSupport("gitlab", [
				"create_issue",
				"create_test_case",
			]),
		).toBe(true);
	});

	it("blocks issue-only connections (default off)", () => {
		expect(hasNativeTestCaseSupport("jira", ["createJiraIssue"])).toBe(
			false,
		);
		expect(hasNativeTestCaseSupport("fizzy", ["fizzy_create_card"])).toBe(
			false,
		);
		expect(hasNativeTestCaseSupport("github", ["create_issue"])).toBe(
			false,
		);
		expect(hasNativeTestCaseSupport(null, [])).toBe(false);
		expect(hasNativeTestCaseSupport(undefined, [])).toBe(false);
	});
});

describe("isContainerListingTool - list_project_teams", () => {
	it("should detect Azure DevOps list_project_teams", () => {
		expect(isContainerListingTool("list_project_teams")).toBe(true);
		expect(isContainerListingTool("mcp_ado_core_list_project_teams")).toBe(
			true,
		);
	});
});

describe("isContainerListingTool", () => {
	it("should detect get_accounts", () => {
		expect(isContainerListingTool("get_accounts")).toBe(true);
		expect(isContainerListingTool("fizzy_get_accounts")).toBe(true);
	});

	it("should detect list_boards", () => {
		expect(isContainerListingTool("list_boards")).toBe(true);
		expect(isContainerListingTool("fizzy_get_boards")).toBe(true);
	});

	it("should detect list_projects", () => {
		expect(isContainerListingTool("list_projects")).toBe(true);
		expect(isContainerListingTool("jira_get_projects")).toBe(true);
	});

	it("should detect get_teams", () => {
		expect(isContainerListingTool("get_teams")).toBe(true);
		expect(isContainerListingTool("linear_list_teams")).toBe(true);
	});

	it("should detect list_repositories", () => {
		expect(isContainerListingTool("list_repositories")).toBe(true);
		expect(isContainerListingTool("github_list_repos")).toBe(true);
	});

	it("should detect Atlassian Rovo product-infix camelCase containers", () => {
		// get + Visible/Jira + Projects → the board/project picker source.
		expect(isContainerListingTool("getVisibleJiraProjects")).toBe(true);
		expect(isContainerListingTool("getConfluenceSpaces")).toBe(true);
	});

	it("should NOT match Rovo non-container tools (bounded infix)", () => {
		// ends "Resources" / "Metadata" — not a container-listing tool.
		expect(isContainerListingTool("getAccessibleAtlassianResources")).toBe(
			false,
		);
		expect(isContainerListingTool("getJiraProjectIssueTypesMetadata")).toBe(
			false,
		);
	});

	it("should not match task tools", () => {
		expect(isContainerListingTool("create_card")).toBe(false);
		expect(isContainerListingTool("get_card")).toBe(false);
		expect(isContainerListingTool("createJiraIssue")).toBe(false);
	});
});

// =============================================================================
// extractContainerType Tests
// =============================================================================
//
// extractContainerType MUST stay consistent with isContainerListingTool: any
// name the filter accepts should yield a type here, otherwise the hierarchy
// builder silently drops the tool. The Rovo cases below are the regression
// guard for the bug where getVisibleJiraProjects passed isContainerListingTool
// but the old camelCase-only extractor returned undefined, making Atlassian
// Jira look like it had "no PM capabilities".

describe("extractContainerType", () => {
	it("extracts snake_case containers (with and without prefix)", () => {
		expect(extractContainerType("get_accounts")).toBe("account");
		expect(extractContainerType("fizzy_get_boards")).toBe("board");
		expect(extractContainerType("list_projects")).toBe("project");
		expect(extractContainerType("jira_get_projects")).toBe("project");
		expect(extractContainerType("linear_list_teams")).toBe("team");
		expect(extractContainerType("github_list_repos")).toBe("repo");
	});

	it("extracts plain camelCase containers", () => {
		expect(extractContainerType("getBoards")).toBe("board");
		expect(extractContainerType("listProjects")).toBe("project");
	});

	it("extracts Atlassian Rovo product-infix camelCase containers", () => {
		// Regression: these passed isContainerListingTool but the old local
		// extractor (camelCase, no infix) returned undefined → dropped.
		expect(extractContainerType("getVisibleJiraProjects")).toBe("project");
		expect(extractContainerType("getConfluenceSpaces")).toBe("space");
	});

	it("stays consistent with isContainerListingTool for Rovo names", () => {
		for (const name of ["getVisibleJiraProjects", "getConfluenceSpaces"]) {
			expect(isContainerListingTool(name)).toBe(true);
			expect(extractContainerType(name)).toBeDefined();
		}
	});

	it("returns undefined for non-container tools", () => {
		expect(extractContainerType("createJiraIssue")).toBeUndefined();
		expect(extractContainerType("get_card")).toBeUndefined();
		expect(
			extractContainerType("getJiraProjectIssueTypesMetadata"),
		).toBeUndefined();
	});
});

// =============================================================================
// findBacklogsListTool Tests (ADO backlog resolution)
// =============================================================================

describe("findBacklogsListTool", () => {
	it("should find wit_list_backlogs (plain ADO)", () => {
		const tools = ["wit_list_backlog_work_items", "wit_list_backlogs"];
		expect(findBacklogsListTool(tools)).toBe("wit_list_backlogs");
	});

	it("should find mcp_ado_wit_list_backlogs (prefixed ADO)", () => {
		const tools = [
			"mcp_ado_wit_list_backlog_work_items",
			"mcp_ado_wit_list_backlogs",
		];
		expect(findBacklogsListTool(tools)).toBe("mcp_ado_wit_list_backlogs");
	});

	it("should NOT return wit_list_backlog_work_items (task list)", () => {
		const tools = ["wit_list_backlog_work_items"];
		expect(findBacklogsListTool(tools)).toBeUndefined();
	});

	it("should return undefined when no backlogs tool", () => {
		const tools = ["wit_create_work_item", "wit_get_work_item"];
		expect(findBacklogsListTool(tools)).toBeUndefined();
	});
});

// =============================================================================
// PM Type Detection Tests
// =============================================================================

describe("detectPMType", () => {
	it("should detect Fizzy", () => {
		expect(detectPMType(["fizzy_get_accounts", "fizzy_create_card"])).toBe(
			"fizzy",
		);
	});

	it("should detect Linear", () => {
		expect(detectPMType(["linear_get_teams", "linear_create_issue"])).toBe(
			"linear",
		);
	});

	it("should detect Jira", () => {
		expect(detectPMType(["jira_get_projects", "jira_create_issue"])).toBe(
			"jira",
		);
	});

	it("should detect GitHub", () => {
		expect(detectPMType(["github_list_repos", "github_create_issue"])).toBe(
			"github",
		);
	});

	it("should detect Trello", () => {
		expect(detectPMType(["trello_get_boards", "trello_create_card"])).toBe(
			"trello",
		);
	});

	it("should detect Asana", () => {
		expect(
			detectPMType(["asana_get_workspaces", "asana_create_task"]),
		).toBe("asana");
	});

	it("should detect Azure DevOps", () => {
		expect(
			detectPMType([
				"mcp_ado_wit_create_work_item",
				"mcp_ado_core_list_projects",
			]),
		).toBe("azure-devops");
	});

	it("should return undefined for unknown tools", () => {
		expect(
			detectPMType(["firecrawl_scrape", "context7_search"]),
		).toBeUndefined();
	});
});

// =============================================================================
// Parameter Matching Tests
// =============================================================================

describe("findBestMatchingParam", () => {
	it("should find card_number with highest priority for Fizzy", () => {
		const params = ["id", "card_number", "title"];
		const match = findBestMatchingParam(params, TASK_ID_PARAM_PATTERNS);
		expect(match).toBe("card_number");
	});

	it("should find issue_key for Jira", () => {
		const params = ["id", "issue_key", "summary"];
		const match = findBestMatchingParam(params, TASK_ID_PARAM_PATTERNS);
		expect(match).toBe("issue_key");
	});

	it("should fall back to id when no specific match", () => {
		const params = ["id", "name", "description"];
		const match = findBestMatchingParam(params, TASK_ID_PARAM_PATTERNS);
		expect(match).toBe("id");
	});

	it("should return undefined when no match", () => {
		const params = ["name", "description", "status"];
		const match = findBestMatchingParam(params, TASK_ID_PARAM_PATTERNS);
		expect(match).toBeUndefined();
	});
});

// =============================================================================
// Integration Tests (simulate real workflows)
// =============================================================================

describe("Story Sync Integration", () => {
	describe("Fizzy workflow", () => {
		it("should extract correct ID from Fizzy create response", () => {
			// Fizzy returns { id: 123, number: 456, url: "/account/board/456.json" }
			const fizzzyResponse = {
				id: 123,
				number: 456,
				title: "Test Card",
				url: "/my-account/my-board/456.json",
			};

			// The update tool uses "card_number" or "number" as idParam
			const idParamHint = "number"; // discovered from update tool schema
			const id = extractIdFromResponse(fizzzyResponse, idParamHint);
			expect(id).toBe("456");

			// URL normalization
			const url = normalizeUrl(
				extractUrlFromResponse(fizzzyResponse),
				"https://fizzy.do",
			);
			expect(url).toBe("https://fizzy.do/my-account/my-board/456");
		});
	});

	describe("GitHub workflow", () => {
		it("should extract correct ID from GitHub create response", () => {
			const githubResponse = {
				id: 999999,
				number: 42,
				issue_number: 42,
				html_url: "https://github.com/owner/repo/issues/42",
				title: "Bug Report",
			};

			// GitHub update tool uses "issue_number" as idParam
			const idParamHint = "issue_number";
			const id = extractIdFromResponse(githubResponse, idParamHint);
			expect(id).toBe("42");

			const url = extractUrlFromResponse(githubResponse);
			expect(url).toBe("https://github.com/owner/repo/issues/42");
		});
	});

	describe("Jira workflow", () => {
		it("should extract correct ID from Jira create response", () => {
			const jiraResponse = {
				id: "10001",
				key: "PROJ-123",
				self: "https://company.atlassian.net/rest/api/3/issue/10001",
				fields: {
					summary: "Test Issue",
				},
			};

			// Jira update tool uses "issue_key" or "key" as idParam
			const idParamHint = "key";
			const id = extractIdFromResponse(jiraResponse, idParamHint);
			expect(id).toBe("PROJ-123");
		});
	});

	describe("Trello workflow", () => {
		it("should extract correct ID from Trello create response", () => {
			const trelloResponse = {
				id: "abc123def456",
				name: "Test Card",
				shortUrl: "https://trello.com/c/abc123",
				url: "https://trello.com/c/abc123/1-test-card",
			};

			// Trello uses "card_id" or "id" as idParam
			const idParamHint = "id";
			const id = extractIdFromResponse(trelloResponse, idParamHint);
			expect(id).toBe("abc123def456");

			const url = extractUrlFromResponse(trelloResponse);
			expect(url).toBe("https://trello.com/c/abc123/1-test-card");
		});
	});
});

// =============================================================================
// Constants Coverage Tests
// =============================================================================

describe("Pattern Constants", () => {
	describe("COMMON_ID_FIELDS", () => {
		it("should include all major ID field variations", () => {
			expect(COMMON_ID_FIELDS).toContain("number");
			expect(COMMON_ID_FIELDS).toContain("card_number");
			expect(COMMON_ID_FIELDS).toContain("issue_number");
			expect(COMMON_ID_FIELDS).toContain("id");
			expect(COMMON_ID_FIELDS).toContain("key");
			expect(COMMON_ID_FIELDS).toContain("task_id");
			expect(COMMON_ID_FIELDS).toContain("item_id");
		});
	});

	describe("KNOWN_PM_DOMAINS", () => {
		it("should include major PM tool domains", () => {
			expect(KNOWN_PM_DOMAINS).toContain("trello.com");
			expect(KNOWN_PM_DOMAINS).toContain("github.com");
			expect(KNOWN_PM_DOMAINS).toContain("linear.app");
			expect(KNOWN_PM_DOMAINS).toContain("asana.com");
			expect(KNOWN_PM_DOMAINS).toContain("fizzy.do");
			expect(KNOWN_PM_DOMAINS.some((d) => d.includes("jira"))).toBe(true);
			expect(KNOWN_PM_DOMAINS).toContain("dev.azure.com");
		});
	});

	describe("PM_TOOL_TYPES", () => {
		it("should include major PM tools", () => {
			const types = PM_TOOL_TYPES.map((t) => t.type);
			expect(types).toContain("fizzy");
			expect(types).toContain("linear");
			expect(types).toContain("jira");
			expect(types).toContain("github");
			expect(types).toContain("trello");
			expect(types).toContain("asana");
		});
	});
});

// =============================================================================
// Per-Story PM Tool Identification
// =============================================================================

describe("detectPMTypeFromUrl", () => {
	it("should detect azure-devops from dev.azure.com", async () => {
		const { detectPMTypeFromUrl } = await import("../lib/pm-tool-patterns");
		expect(
			detectPMTypeFromUrl(
				"https://dev.azure.com/example-org/proj/_workitems/edit/149",
			),
		).toBe("azure-devops");
	});

	it("should detect azure-devops from visualstudio.com", async () => {
		const { detectPMTypeFromUrl } = await import("../lib/pm-tool-patterns");
		expect(
			detectPMTypeFromUrl("https://contoso.visualstudio.com/x/y"),
		).toBe("azure-devops");
	});

	it("should detect fizzy from app.fizzy.do", async () => {
		const { detectPMTypeFromUrl } = await import("../lib/pm-tool-patterns");
		expect(detectPMTypeFromUrl("https://app.fizzy.do/123/cards/45")).toBe(
			"fizzy",
		);
	});

	it("should detect linear, jira, github, gitlab", async () => {
		const { detectPMTypeFromUrl } = await import("../lib/pm-tool-patterns");
		expect(detectPMTypeFromUrl("https://linear.app/team/issue/X-1")).toBe(
			"linear",
		);
		expect(
			detectPMTypeFromUrl("https://company.atlassian.net/browse/PROJ-1"),
		).toBe("jira");
		expect(detectPMTypeFromUrl("https://github.com/o/r/issues/1")).toBe(
			"github",
		);
		expect(detectPMTypeFromUrl("https://gitlab.com/o/r/-/issues/1")).toBe(
			"gitlab",
		);
	});

	it("should return undefined for unknown/empty URLs", async () => {
		const { detectPMTypeFromUrl } = await import("../lib/pm-tool-patterns");
		expect(detectPMTypeFromUrl(null)).toBeUndefined();
		expect(detectPMTypeFromUrl("")).toBeUndefined();
		expect(detectPMTypeFromUrl("not-a-url")).toBeUndefined();
		expect(
			detectPMTypeFromUrl("https://intranet.example.com/x"),
		).toBeUndefined();
	});
});

describe("pmDetectedTypeDisplayName", () => {
	it("should return canonical display names for known types", async () => {
		const { pmDetectedTypeDisplayName } = await import(
			"../lib/pm-tool-patterns"
		);
		expect(pmDetectedTypeDisplayName("azure-devops")).toBe("Azure DevOps");
		expect(pmDetectedTypeDisplayName("fizzy")).toBe("Fizzy");
		expect(pmDetectedTypeDisplayName("jira")).toBe("Jira");
		expect(pmDetectedTypeDisplayName("linear")).toBe("Linear");
		expect(pmDetectedTypeDisplayName("github")).toBe("GitHub");
		expect(pmDetectedTypeDisplayName("gitlab")).toBe("GitLab");
		expect(pmDetectedTypeDisplayName("gitlab-rest")).toBe("GitLab");
		expect(pmDetectedTypeDisplayName("trello")).toBe("Trello");
		expect(pmDetectedTypeDisplayName("asana")).toBe("Asana");
	});

	it("should return undefined for unknown types", async () => {
		const { pmDetectedTypeDisplayName } = await import(
			"../lib/pm-tool-patterns"
		);
		expect(pmDetectedTypeDisplayName("custom")).toBeUndefined();
		expect(pmDetectedTypeDisplayName(undefined)).toBeUndefined();
		expect(pmDetectedTypeDisplayName(null)).toBeUndefined();
	});
});

describe("normalizeAdoWebUrl", () => {
	// Legacy data: pre-fix stored REST API URLs (_apis/wit/workItems/<id>).
	// Defense: when rendering links, rewrite to the web UI path so users
	// don't land on JSON endpoints. Same operation idempotent for new data.
	it("should rewrite ADO REST API URL to web UI URL", async () => {
		const { normalizeAdoWebUrl } = await import("../lib/pm-tool-patterns");
		expect(
			normalizeAdoWebUrl(
				"https://dev.azure.com/example-org/00000000-0000-0000-0000-000000000000/_apis/wit/workItems/149",
			),
		).toBe(
			"https://dev.azure.com/example-org/00000000-0000-0000-0000-000000000000/_workitems/edit/149",
		);
	});

	it("should leave already-correct ADO web URLs unchanged", async () => {
		const { normalizeAdoWebUrl } = await import("../lib/pm-tool-patterns");
		const ok = "https://dev.azure.com/org/proj/_workitems/edit/42";
		expect(normalizeAdoWebUrl(ok)).toBe(ok);
	});

	it("should leave non-ADO URLs unchanged", async () => {
		const { normalizeAdoWebUrl } = await import("../lib/pm-tool-patterns");
		const fizzy = "https://app.fizzy.do/123/cards/45";
		expect(normalizeAdoWebUrl(fizzy)).toBe(fizzy);
	});

	it("should pass through null/undefined/empty", async () => {
		const { normalizeAdoWebUrl } = await import("../lib/pm-tool-patterns");
		expect(normalizeAdoWebUrl(null)).toBeNull();
		expect(normalizeAdoWebUrl(undefined)).toBeUndefined();
		expect(normalizeAdoWebUrl("")).toBe("");
	});
});

describe("normalizePmWebUrl", () => {
	// Bug #1303: REST-API URLs render JSON in a browser. This normalizer
	// is the defensive UI-side rewrite for ADO, GitHub, and Jira so the
	// roadmap cloud icon always opens a human-readable page.

	it("should rewrite ADO REST API URL to web UI URL", async () => {
		const { normalizePmWebUrl } = await import("../lib/pm-tool-patterns");
		expect(
			normalizePmWebUrl(
				"https://dev.azure.com/example-org/proj/_apis/wit/workItems/149",
			),
		).toBe("https://dev.azure.com/example-org/proj/_workitems/edit/149");
	});

	it("should rewrite GitHub Issues REST URL to web UI URL", async () => {
		const { normalizePmWebUrl } = await import("../lib/pm-tool-patterns");
		expect(
			normalizePmWebUrl(
				"https://api.github.com/repos/octocat/hello-world/issues/42",
			),
		).toBe("https://github.com/octocat/hello-world/issues/42");
	});

	it("should rewrite GitHub Pulls REST URL to singular `pull` web UI URL", async () => {
		const { normalizePmWebUrl } = await import("../lib/pm-tool-patterns");
		// GitHub's REST path is `pulls` (plural) but the user-facing route
		// is `pull` (singular) — assert the flip.
		expect(
			normalizePmWebUrl(
				"https://api.github.com/repos/octocat/hello-world/pulls/7",
			),
		).toBe("https://github.com/octocat/hello-world/pull/7");
	});

	it("should rewrite Jira Cloud REST API URL to /browse/<key>", async () => {
		const { normalizePmWebUrl } = await import("../lib/pm-tool-patterns");
		expect(
			normalizePmWebUrl(
				"https://acme.atlassian.net/rest/api/3/issue/PROJ-123",
			),
		).toBe("https://acme.atlassian.net/browse/PROJ-123");
	});

	it("should rewrite Jira REST v2 endpoints and numeric ids", async () => {
		const { normalizePmWebUrl } = await import("../lib/pm-tool-patterns");
		// v2 path and numeric internal id both supported; Jira /browse
		// resolves either form.
		expect(
			normalizePmWebUrl(
				"https://acme.atlassian.net/rest/api/2/issue/10001",
			),
		).toBe("https://acme.atlassian.net/browse/10001");
	});

	it("should leave already-correct web URLs unchanged", async () => {
		const { normalizePmWebUrl } = await import("../lib/pm-tool-patterns");
		const ado = "https://dev.azure.com/org/proj/_workitems/edit/42";
		const gh = "https://github.com/octocat/hello-world/issues/42";
		const jira = "https://acme.atlassian.net/browse/PROJ-123";
		const fizzy = "https://app.fizzy.do/123/cards/45";
		expect(normalizePmWebUrl(ado)).toBe(ado);
		expect(normalizePmWebUrl(gh)).toBe(gh);
		expect(normalizePmWebUrl(jira)).toBe(jira);
		expect(normalizePmWebUrl(fizzy)).toBe(fizzy);
	});

	it("should pass through null/undefined/empty/malformed", async () => {
		const { normalizePmWebUrl } = await import("../lib/pm-tool-patterns");
		expect(normalizePmWebUrl(null)).toBeNull();
		expect(normalizePmWebUrl(undefined)).toBeUndefined();
		expect(normalizePmWebUrl("")).toBe("");
		// Malformed URL: passes through unchanged rather than throwing.
		expect(normalizePmWebUrl("not a url")).toBe("not a url");
	});

	// -------------------------------------------------------------------------
	// Subresource guards (codex review of bug #1303): subresources are
	// distinct entities (a comment is not its parent issue), so silently
	// rewriting them to the parent web URL would lose information. The
	// regex must NOT match these forms — pass them through unchanged.
	// -------------------------------------------------------------------------

	it("should leave ADO work-item subresource paths unchanged", async () => {
		const { normalizePmWebUrl } = await import("../lib/pm-tool-patterns");
		const updates =
			"https://dev.azure.com/org/proj/_apis/wit/workItems/149/updates";
		const comments =
			"https://dev.azure.com/org/proj/_apis/wit/workItems/149/comments/1";
		expect(normalizePmWebUrl(updates)).toBe(updates);
		expect(normalizePmWebUrl(comments)).toBe(comments);
	});

	it("should leave GitHub Issues/PR subresource paths unchanged", async () => {
		const { normalizePmWebUrl } = await import("../lib/pm-tool-patterns");
		// `/comments/<n>` on an issue is a distinct comment resource — must
		// not be silently rewritten to the parent issue.
		const issueComment =
			"https://api.github.com/repos/octocat/hello-world/issues/42/comments/1";
		const pullFiles =
			"https://api.github.com/repos/octocat/hello-world/pulls/7/files";
		expect(normalizePmWebUrl(issueComment)).toBe(issueComment);
		expect(normalizePmWebUrl(pullFiles)).toBe(pullFiles);
	});

	it("should leave Jira issue subresource paths unchanged", async () => {
		const { normalizePmWebUrl } = await import("../lib/pm-tool-patterns");
		const transitions =
			"https://acme.atlassian.net/rest/api/3/issue/PROJ-123/transitions";
		const comment =
			"https://acme.atlassian.net/rest/api/2/issue/PROJ-123/comment/1";
		expect(normalizePmWebUrl(transitions)).toBe(transitions);
		expect(normalizePmWebUrl(comment)).toBe(comment);
	});

	// -------------------------------------------------------------------------
	// Trailing slash / query / hash preservation. The new regexes accept
	// each of these terminal variants but the rewrite must produce a sane
	// URL — for GH/Jira (URL-parsed) query/hash are reattached from
	// `parsed.search + parsed.hash` so they round-trip; for ADO the
	// rewrite is substring-based and intentionally drops them (parity with
	// the original `normalizeAdoWebUrl` behavior).
	// -------------------------------------------------------------------------

	it("should accept ADO REST URLs with trailing slash / query / hash", async () => {
		const { normalizePmWebUrl } = await import("../lib/pm-tool-patterns");
		expect(
			normalizePmWebUrl(
				"https://dev.azure.com/org/proj/_apis/wit/workItems/149/",
			),
		).toBe("https://dev.azure.com/org/proj/_workitems/edit/149");
		expect(
			normalizePmWebUrl(
				"https://dev.azure.com/org/proj/_apis/wit/workItems/149?api-version=7.1",
			),
		).toBe("https://dev.azure.com/org/proj/_workitems/edit/149");
	});

	it("should preserve query + hash on GitHub REST → web rewrite", async () => {
		const { normalizePmWebUrl } = await import("../lib/pm-tool-patterns");
		// URL-parsed pathway should attach `parsed.search + parsed.hash`
		// onto the rewrite so a deep-linked comment anchor survives.
		expect(
			normalizePmWebUrl(
				"https://api.github.com/repos/octocat/hello-world/issues/42?foo=bar#issuecomment-1",
			),
		).toBe(
			"https://github.com/octocat/hello-world/issues/42?foo=bar#issuecomment-1",
		);
	});

	it("should preserve query + hash on Jira REST → /browse rewrite", async () => {
		const { normalizePmWebUrl } = await import("../lib/pm-tool-patterns");
		// URL.toString() round-trips search/hash so they survive.
		expect(
			normalizePmWebUrl(
				"https://acme.atlassian.net/rest/api/3/issue/PROJ-123?expand=changelog#comment-1",
			),
		).toBe(
			"https://acme.atlassian.net/browse/PROJ-123?expand=changelog#comment-1",
		);
	});

	// -------------------------------------------------------------------------
	// Host scoping. Legacy `visualstudio.com` ADO hosts share the same
	// REST path so the rewrite applies; GitHub Enterprise and self-hosted
	// Jira hosts deliberately fall through to the generic passthrough
	// because their REST API surface and web-UI URL conventions are not
	// guaranteed to match the cloud forms.
	// -------------------------------------------------------------------------

	it("should rewrite legacy ADO visualstudio.com host paths", async () => {
		const { normalizePmWebUrl } = await import("../lib/pm-tool-patterns");
		expect(
			normalizePmWebUrl(
				"https://org.visualstudio.com/proj/_apis/wit/workItems/149",
			),
		).toBe("https://org.visualstudio.com/proj/_workitems/edit/149");
	});

	it("should leave GitHub Enterprise REST URLs unchanged (scoped out for now)", async () => {
		const { normalizePmWebUrl } = await import("../lib/pm-tool-patterns");
		const enterprise =
			"https://github.acme.corp/api/v3/repos/octocat/hello-world/issues/42";
		expect(normalizePmWebUrl(enterprise)).toBe(enterprise);
	});

	it("should leave self-hosted (non-atlassian.net) Jira REST URLs unchanged", async () => {
		const { normalizePmWebUrl } = await import("../lib/pm-tool-patterns");
		const selfHosted = "https://jira.acme.corp/rest/api/2/issue/PROJ-123";
		expect(normalizePmWebUrl(selfHosted)).toBe(selfHosted);
	});
});

// =============================================================================
// pmServerKeyToDetectedType — derive the canonical detectedType from a stored
// MCP server key so the connected PM tool's name still shows when a live
// capability probe isn't available (e.g. a teammate-configured integration the
// current user can't resolve).
// =============================================================================

describe("pmServerKeyToDetectedType", () => {
	it("maps known PM server keys to the detectedType vocabulary", () => {
		expect(pmServerKeyToDetectedType("github")).toBe("github");
		expect(pmServerKeyToDetectedType("fizzy")).toBe("fizzy");
		expect(pmServerKeyToDetectedType("linear")).toBe("linear");
		expect(pmServerKeyToDetectedType("asana")).toBe("asana");
		expect(pmServerKeyToDetectedType("clickup")).toBe("clickup");
		expect(pmServerKeyToDetectedType("azure-devops")).toBe("azure-devops");
	});

	it("collapses the gitlab server-key variants to 'gitlab'", () => {
		expect(pmServerKeyToDetectedType("gitlab")).toBe("gitlab");
		expect(pmServerKeyToDetectedType("gitlab-official")).toBe("gitlab");
	});

	it("returns undefined for null / undefined / empty / unknown keys", () => {
		expect(pmServerKeyToDetectedType(null)).toBeUndefined();
		expect(pmServerKeyToDetectedType(undefined)).toBeUndefined();
		expect(pmServerKeyToDetectedType("")).toBeUndefined();
		expect(pmServerKeyToDetectedType("some-random-mcp")).toBeUndefined();
	});

	it("chains into a human display name (server key → type → label)", () => {
		expect(
			pmDetectedTypeDisplayName(
				pmServerKeyToDetectedType("gitlab-official"),
			),
		).toBe("GitLab");
		expect(
			pmDetectedTypeDisplayName(pmServerKeyToDetectedType("github")),
		).toBe("GitHub");
		expect(
			pmDetectedTypeDisplayName(
				pmServerKeyToDetectedType("azure-devops"),
			),
		).toBe("Azure DevOps");
	});
});
