/**
 * PM Tool Analyzer Tests
 *
 * Tests for dynamic project management tool capability detection.
 * Verifies that the analyzer correctly identifies PM capabilities
 * from various MCP tool schemas without hardcoded provider logic.
 */

import { describe, expect, it } from "vitest";
import {
	analyzePMToolCapabilities,
	buildTaskCreationArgs,
	getContainerFetchWorkflow,
	type McpToolDefinition,
} from "../src/activities/pm-integration/tool-analyzer";

// =============================================================================
// Mock Tool Definitions
// =============================================================================

/**
 * Fizzy-like tools (account → board hierarchy)
 * Extended with update, get, and list capabilities for sync testing
 */
const FIZZY_TOOLS: Record<string, McpToolDefinition> = {
	fizzy_get_accounts: {
		name: "fizzy_get_accounts",
		description: "Get all accounts",
		inputSchema: {
			type: "object",
			properties: {},
			required: [],
		},
	},
	fizzy_get_boards: {
		name: "fizzy_get_boards",
		description: "Get boards for an account",
		inputSchema: {
			type: "object",
			properties: {
				account_slug: { type: "string", description: "Account slug" },
			},
			required: ["account_slug"],
		},
	},
	fizzy_create_card: {
		name: "fizzy_create_card",
		description: "Create a card in a board",
		inputSchema: {
			type: "object",
			properties: {
				account_slug: { type: "string", description: "Account slug" },
				board_id: { type: "string", description: "Board ID" },
				title: { type: "string", description: "Card title" },
				description: {
					type: "string",
					description: "Card description",
				},
				status: { type: "string", enum: ["draft", "published"] },
			},
			required: ["account_slug", "board_id", "title"],
		},
	},
	fizzy_update_card: {
		name: "fizzy_update_card",
		description: "Update a card",
		inputSchema: {
			type: "object",
			properties: {
				card_id: { type: "string", description: "Card ID" },
				title: { type: "string", description: "Card title" },
				description: {
					type: "string",
					description: "Card description",
				},
				column_id: {
					type: "string",
					description: "Column to move card to",
				},
			},
			required: ["card_id"],
		},
	},
	fizzy_get_card: {
		name: "fizzy_get_card",
		description: "Get a single card",
		inputSchema: {
			type: "object",
			properties: {
				card_id: { type: "string", description: "Card ID" },
				board_id: { type: "string", description: "Board ID" },
			},
			required: ["card_id", "board_id"],
		},
	},
	fizzy_list_cards: {
		name: "fizzy_list_cards",
		description: "List cards in a board",
		inputSchema: {
			type: "object",
			properties: {
				board_id: { type: "string", description: "Board ID" },
				status: { type: "string", description: "Filter by status" },
			},
			required: ["board_id"],
		},
	},
};

/**
 * Linear-like tools (team-based, flat hierarchy)
 */
const LINEAR_TOOLS: Record<string, McpToolDefinition> = {
	linear_get_teams: {
		name: "linear_get_teams",
		description: "Get all teams",
		inputSchema: {
			type: "object",
			properties: {},
			required: [],
		},
	},
	linear_create_issue: {
		name: "linear_create_issue",
		description: "Create an issue in a team",
		inputSchema: {
			type: "object",
			properties: {
				team_id: { type: "string", description: "Team ID" },
				title: { type: "string", description: "Issue title" },
				description: {
					type: "string",
					description: "Issue description",
				},
				priority: { type: "number" },
			},
			required: ["team_id", "title"],
		},
	},
};

/**
 * Jira-like tools
 */
const JIRA_TOOLS: Record<string, McpToolDefinition> = {
	jira_get_projects: {
		name: "jira_get_projects",
		description: "Get all projects",
		inputSchema: {
			type: "object",
			properties: {},
			required: [],
		},
	},
	jira_create_issue: {
		name: "jira_create_issue",
		description: "Create an issue in a project",
		inputSchema: {
			type: "object",
			properties: {
				project_key: { type: "string", description: "Project key" },
				summary: { type: "string", description: "Issue summary" },
				description: {
					type: "string",
					description: "Issue description",
				},
				issue_type: { type: "string", enum: ["Task", "Bug", "Story"] },
			},
			required: ["project_key", "summary", "issue_type"],
		},
	},
};

/**
 * GitHub-like tools
 */
const GITHUB_TOOLS: Record<string, McpToolDefinition> = {
	github_list_repos: {
		name: "github_list_repos",
		description: "List repositories",
		inputSchema: {
			type: "object",
			properties: {},
			required: [],
		},
	},
	github_create_issue: {
		name: "github_create_issue",
		description: "Create an issue in a repository",
		inputSchema: {
			type: "object",
			properties: {
				repo: {
					type: "string",
					description: "Repository (owner/name)",
				},
				title: { type: "string", description: "Issue title" },
				body: { type: "string", description: "Issue body" },
				labels: { type: "array" },
			},
			required: ["repo", "title"],
		},
	},
};

/**
 * GitLab-like tools — match the Fabric GitLab MCP shim, whose tool names
 * (list_issues / get_issue / create_issue / update_issue) do NOT carry the
 * vendor name. Detection has to lean on the serverHint passed by the caller.
 */
const GITLAB_TOOLS: Record<string, McpToolDefinition> = {
	list_projects: {
		name: "list_projects",
		description: "List GitLab projects",
		inputSchema: {
			type: "object",
			properties: {},
			required: [],
		},
	},
	list_issues: {
		name: "list_issues",
		description: "List issues in a GitLab project",
		inputSchema: {
			type: "object",
			properties: {
				project_id: { type: "string" },
				state: { type: "string", enum: ["opened", "closed", "all"] },
				page: { type: "number" },
				per_page: { type: "number" },
			},
			required: ["project_id"],
		},
	},
	get_issue: {
		name: "get_issue",
		description: "Get a GitLab issue",
		inputSchema: {
			type: "object",
			properties: {
				project_id: { type: "string" },
				issue_iid: { type: "number" },
			},
			required: ["project_id", "issue_iid"],
		},
	},
	create_issue: {
		name: "create_issue",
		description: "Create a GitLab issue",
		inputSchema: {
			type: "object",
			properties: {
				project_id: { type: "string" },
				title: { type: "string" },
				description: { type: "string" },
				labels: { type: "array" },
			},
			required: ["project_id", "title"],
		},
	},
	update_issue: {
		name: "update_issue",
		description: "Update a GitLab issue",
		inputSchema: {
			type: "object",
			properties: {
				project_id: { type: "string" },
				issue_iid: { type: "number" },
				title: { type: "string" },
				labels: { type: "array" },
			},
			required: ["project_id", "issue_iid"],
		},
	},
};

/**
 * Non-PM tools (should not be detected as PM)
 */
const NON_PM_TOOLS: Record<string, McpToolDefinition> = {
	firecrawl_scrape: {
		name: "firecrawl_scrape",
		description: "Scrape a webpage",
		inputSchema: {
			type: "object",
			properties: {
				url: { type: "string" },
			},
			required: ["url"],
		},
	},
	context7_search: {
		name: "context7_search",
		description: "Search documentation",
		inputSchema: {
			type: "object",
			properties: {
				query: { type: "string" },
			},
			required: ["query"],
		},
	},
};

// =============================================================================
// Tests
// =============================================================================

describe("analyzePMToolCapabilities", () => {
	describe("Fizzy detection", () => {
		it("should detect Fizzy as PM type", () => {
			const capabilities = analyzePMToolCapabilities(FIZZY_TOOLS);

			expect(capabilities.hasPMCapabilities).toBe(true);
			expect(capabilities.detectedType).toBe("fizzy");
		});

		it("should detect two-level hierarchy (accounts → boards)", () => {
			const capabilities = analyzePMToolCapabilities(FIZZY_TOOLS);

			expect(capabilities.containerHierarchy).toHaveLength(2);

			// Level 0: accounts
			expect(capabilities.containerHierarchy[0]).toMatchObject({
				level: 0,
				containerType: "account",
				listToolName: "fizzy_get_accounts",
			});

			// Level 1: boards
			expect(capabilities.containerHierarchy[1]).toMatchObject({
				level: 1,
				containerType: "board",
				listToolName: "fizzy_get_boards",
				parentParam: "account_slug",
			});
		});

		it("should detect task creation capability", () => {
			const capabilities = analyzePMToolCapabilities(FIZZY_TOOLS);

			expect(capabilities.taskCreation).toBeDefined();
			expect(capabilities.taskCreation?.toolName).toBe(
				"fizzy_create_card",
			);
			expect(capabilities.taskCreation?.containerParam).toBe("board_id");
			expect(capabilities.taskCreation?.titleParam).toBe("title");
			expect(capabilities.taskCreation?.descriptionParam).toBe(
				"description",
			);
		});
	});

	describe("Linear detection", () => {
		it("should detect Linear as PM type", () => {
			const capabilities = analyzePMToolCapabilities(LINEAR_TOOLS);

			expect(capabilities.hasPMCapabilities).toBe(true);
			expect(capabilities.detectedType).toBe("linear");
		});

		it("should detect single-level hierarchy (teams)", () => {
			const capabilities = analyzePMToolCapabilities(LINEAR_TOOLS);

			expect(capabilities.containerHierarchy).toHaveLength(1);
			expect(capabilities.containerHierarchy[0]).toMatchObject({
				level: 1,
				containerType: "team",
				listToolName: "linear_get_teams",
			});
		});

		it("should detect task creation with team_id as container", () => {
			const capabilities = analyzePMToolCapabilities(LINEAR_TOOLS);

			expect(capabilities.taskCreation?.containerParam).toBe("team_id");
			expect(capabilities.taskCreation?.titleParam).toBe("title");
		});
	});

	describe("Jira detection", () => {
		it("should detect Jira as PM type", () => {
			const capabilities = analyzePMToolCapabilities(JIRA_TOOLS);

			expect(capabilities.hasPMCapabilities).toBe(true);
			expect(capabilities.detectedType).toBe("jira");
		});

		it("should detect project_key as container param and summary as title", () => {
			const capabilities = analyzePMToolCapabilities(JIRA_TOOLS);

			expect(capabilities.taskCreation?.containerParam).toBe(
				"project_key",
			);
			expect(capabilities.taskCreation?.titleParam).toBe("summary");
		});
	});

	describe("GitHub detection", () => {
		it("should detect GitHub as PM type", () => {
			const capabilities = analyzePMToolCapabilities(GITHUB_TOOLS);

			expect(capabilities.hasPMCapabilities).toBe(true);
			expect(capabilities.detectedType).toBe("github");
		});

		it("should detect repo as container param and body as description", () => {
			const capabilities = analyzePMToolCapabilities(GITHUB_TOOLS);

			expect(capabilities.taskCreation?.containerParam).toBe("repo");
			expect(capabilities.taskCreation?.titleParam).toBe("title");
			expect(capabilities.taskCreation?.descriptionParam).toBe("body");
		});
	});

	describe("GitLab detection", () => {
		it("should not detect type from generic tool names alone", () => {
			// Without a server hint, GitLab's vendor-neutral tool names are
			// indistinguishable from a generic issue-tracker.
			const capabilities = analyzePMToolCapabilities(GITLAB_TOOLS);

			expect(capabilities.hasPMCapabilities).toBe(true);
			expect(capabilities.detectedType).toBeUndefined();
		});

		it("should detect GitLab when serverHint is provided", () => {
			const capabilities = analyzePMToolCapabilities(GITLAB_TOOLS, {
				serverHint: "GitLab",
			});

			expect(capabilities.hasPMCapabilities).toBe(true);
			expect(capabilities.detectedType).toBe("gitlab");
		});

		it("should detect project_id as the list container param", () => {
			const capabilities = analyzePMToolCapabilities(GITLAB_TOOLS, {
				serverHint: "GitLab",
			});

			expect(capabilities.taskList?.toolName).toBe("list_issues");
			expect(capabilities.taskList?.containerParam).toBe("project_id");
		});
	});

	describe("Non-PM tools", () => {
		it("should not detect PM capabilities for non-PM tools", () => {
			const capabilities = analyzePMToolCapabilities(NON_PM_TOOLS);

			expect(capabilities.hasPMCapabilities).toBe(false);
			expect(capabilities.taskCreation).toBeUndefined();
			expect(capabilities.containerHierarchy).toHaveLength(0);
		});
	});
});

describe("buildTaskCreationArgs", () => {
	it("should build Fizzy task args correctly", () => {
		const capabilities = analyzePMToolCapabilities(FIZZY_TOOLS);

		const args = buildTaskCreationArgs(
			capabilities,
			{ title: "Test Task", description: "Test description" },
			"board-123",
			{ account_slug: "my-account" },
		);

		expect(args).toEqual({
			board_id: "board-123",
			title: "Test Task",
			description: "Test description",
			account_slug: "my-account",
		});
	});

	it("should build Linear task args correctly", () => {
		const capabilities = analyzePMToolCapabilities(LINEAR_TOOLS);

		const args = buildTaskCreationArgs(
			capabilities,
			{ title: "Test Issue", description: "Test body" },
			"team-456",
		);

		expect(args).toEqual({
			team_id: "team-456",
			title: "Test Issue",
			description: "Test body",
		});
	});

	it("should build GitHub task args correctly", () => {
		const capabilities = analyzePMToolCapabilities(GITHUB_TOOLS);

		const args = buildTaskCreationArgs(
			capabilities,
			{ title: "Bug Report", description: "Something is broken" },
			"owner/repo",
		);

		expect(args).toEqual({
			repo: "owner/repo",
			title: "Bug Report",
			body: "Something is broken",
		});
	});

	it("should throw if no task creation capability", () => {
		const capabilities = analyzePMToolCapabilities(NON_PM_TOOLS);

		expect(() =>
			buildTaskCreationArgs(
				capabilities,
				{ title: "Test" },
				"container-id",
			),
		).toThrow("No task creation capability detected");
	});
});

describe("getContainerFetchWorkflow", () => {
	it("should return multi-step workflow for Fizzy", () => {
		const capabilities = analyzePMToolCapabilities(FIZZY_TOOLS);
		const workflow = getContainerFetchWorkflow(capabilities);

		expect(workflow).toHaveLength(2);

		// Step 1: Get accounts
		expect(workflow[0]).toMatchObject({
			toolName: "fizzy_get_accounts",
			paramsNeeded: [],
			producesContext: "account_slug",
		});

		// Step 2: Get boards (needs account_slug)
		expect(workflow[1]).toMatchObject({
			toolName: "fizzy_get_boards",
			paramsNeeded: ["account_slug"],
			producesContext: "board_id",
		});
	});

	it("should return single-step workflow for Linear", () => {
		const capabilities = analyzePMToolCapabilities(LINEAR_TOOLS);
		const workflow = getContainerFetchWorkflow(capabilities);

		expect(workflow).toHaveLength(1);
		expect(workflow[0]).toMatchObject({
			toolName: "linear_get_teams",
			paramsNeeded: [],
			producesContext: "team_id",
		});
	});
});

// =============================================================================
// Sync Capability Tests
// =============================================================================

describe("Task Update Capability Detection", () => {
	it("should detect update capability for Fizzy", () => {
		const capabilities = analyzePMToolCapabilities(FIZZY_TOOLS);

		expect(capabilities.taskUpdate).toBeDefined();
		expect(capabilities.taskUpdate?.toolName).toBe("fizzy_update_card");
		expect(capabilities.taskUpdate?.idParam).toBe("card_id");
		expect(capabilities.taskUpdate?.titleParam).toBe("title");
		expect(capabilities.taskUpdate?.descriptionParam).toBe("description");
		expect(capabilities.taskUpdate?.statusParam).toBe("column_id");
	});

	it("should not detect update capability for tools without update", () => {
		const capabilities = analyzePMToolCapabilities(NON_PM_TOOLS);

		expect(capabilities.taskUpdate).toBeUndefined();
	});
});

describe("Task Get Capability Detection", () => {
	it("should detect get capability for Fizzy", () => {
		const capabilities = analyzePMToolCapabilities(FIZZY_TOOLS);

		expect(capabilities.taskGet).toBeDefined();
		expect(capabilities.taskGet?.toolName).toBe("fizzy_get_card");
		expect(capabilities.taskGet?.idParam).toBe("card_id");
		expect(capabilities.taskGet?.additionalRequiredParams).toContain(
			"board_id",
		);
	});

	it("should not detect get capability for non-PM tools", () => {
		const capabilities = analyzePMToolCapabilities(NON_PM_TOOLS);

		expect(capabilities.taskGet).toBeUndefined();
	});
});

describe("Task List Capability Detection", () => {
	it("should detect list capability for Fizzy", () => {
		const capabilities = analyzePMToolCapabilities(FIZZY_TOOLS);

		expect(capabilities.taskList).toBeDefined();
		expect(capabilities.taskList?.toolName).toBe("fizzy_list_cards");
		expect(capabilities.taskList?.containerParam).toBe("board_id");
		expect(capabilities.taskList?.filterParams).toContain("status");
	});

	it("should not detect list capability for non-PM tools", () => {
		const capabilities = analyzePMToolCapabilities(NON_PM_TOOLS);

		expect(capabilities.taskList).toBeUndefined();
	});
});

describe("Full Sync Capabilities", () => {
	it("should detect all sync capabilities for Fizzy", () => {
		const capabilities = analyzePMToolCapabilities(FIZZY_TOOLS);

		// Full CRUD capabilities for sync
		expect(capabilities.hasPMCapabilities).toBe(true);
		expect(capabilities.taskCreation).toBeDefined();
		expect(capabilities.taskUpdate).toBeDefined();
		expect(capabilities.taskGet).toBeDefined();
		expect(capabilities.taskList).toBeDefined();
	});

	it("should detect partial capabilities for Linear (create only)", () => {
		const capabilities = analyzePMToolCapabilities(LINEAR_TOOLS);

		expect(capabilities.hasPMCapabilities).toBe(true);
		expect(capabilities.taskCreation).toBeDefined();
		// Linear mock doesn't have update/get/list
		expect(capabilities.taskUpdate).toBeUndefined();
		expect(capabilities.taskGet).toBeUndefined();
		expect(capabilities.taskList).toBeUndefined();
	});
});

// =============================================================================
// Atlassian Rovo MCP (camelCase + fields-object update)
// =============================================================================
//
// Rovo's tool names are camelCase (`createJiraIssue`, `editJiraIssue`,
// `getJiraIssue`, `searchJiraIssuesUsingJql`) and its update tool puts the
// title/description inside a single `fields` object. The analyzer must
// detect those tools via the camelCase patterns and route updates through
// the new `fieldsObjectBased` mode.

const ATLASSIAN_ROVO_TOOLS: Record<string, McpToolDefinition> = {
	createJiraIssue: {
		name: "createJiraIssue",
		description: "Create issue",
		inputSchema: {
			type: "object",
			properties: {
				cloudId: { type: "string" },
				projectKey: { type: "string" },
				summary: { type: "string" },
				description: { type: "string" },
				issueTypeName: { type: "string" },
			},
			required: ["cloudId", "projectKey", "issueTypeName", "summary"],
		},
	},
	editJiraIssue: {
		name: "editJiraIssue",
		description: "Update issue",
		inputSchema: {
			type: "object",
			properties: {
				cloudId: { type: "string" },
				issueIdOrKey: { type: "string" },
				fields: { type: "object" },
			},
			required: ["cloudId", "issueIdOrKey", "fields"],
		},
	},
	getJiraIssue: {
		name: "getJiraIssue",
		description: "Get issue",
		inputSchema: {
			type: "object",
			properties: {
				cloudId: { type: "string" },
				issueIdOrKey: { type: "string" },
			},
			required: ["cloudId", "issueIdOrKey"],
		},
	},
	searchJiraIssuesUsingJql: {
		name: "searchJiraIssuesUsingJql",
		description: "Search issues",
		inputSchema: {
			type: "object",
			properties: {
				cloudId: { type: "string" },
				jql: { type: "string" },
				maxResults: { type: "number" },
			},
			required: ["cloudId", "jql"],
		},
	},
};

describe("Atlassian Rovo MCP capability detection", () => {
	it("should detect create + update + get PM capabilities from camelCase tool names", () => {
		const capabilities = analyzePMToolCapabilities(ATLASSIAN_ROVO_TOOLS, {
			serverHint: "atlassian",
		});

		// hasPMCapabilities is derived from taskCreation existing → push works.
		expect(capabilities.hasPMCapabilities).toBe(true);
		expect(capabilities.detectedType).toBe("jira");
		expect(capabilities.taskCreation?.toolName).toBe("createJiraIssue");
		expect(capabilities.taskUpdate?.toolName).toBe("editJiraIssue");
		expect(capabilities.taskGet?.toolName).toBe("getJiraIssue");
		// taskList is intentionally undefined for Rovo: the search tool uses
		// `jql` instead of a container param so the analyzer can't bind it.
		// Push direction-only doesn't need it; pull/dedup is a follow-up.
		expect(capabilities.taskList).toBeUndefined();
	});

	it("should map createJiraIssue to projectKey + summary + description", () => {
		const capabilities = analyzePMToolCapabilities(ATLASSIAN_ROVO_TOOLS);

		expect(capabilities.taskCreation?.containerParam).toBe("projectKey");
		expect(capabilities.taskCreation?.titleParam).toBe("summary");
		expect(capabilities.taskCreation?.descriptionParam).toBe("description");
	});

	it("should detect fieldsObjectBased mode on editJiraIssue", () => {
		const capabilities = analyzePMToolCapabilities(ATLASSIAN_ROVO_TOOLS);

		expect(capabilities.taskUpdate?.idParam).toBe("issueIdOrKey");
		expect(capabilities.taskUpdate?.titleParam).toBeUndefined();
		expect(capabilities.taskUpdate?.descriptionParam).toBeUndefined();
		expect(capabilities.taskUpdate?.updatesBased).toBeUndefined();
		expect(capabilities.taskUpdate?.fieldsObjectBased).toEqual({
			fieldsParam: "fields",
			titleField: "summary",
			descriptionField: "description",
		});
	});

	it("should detect issueIdOrKey as the get tool id param", () => {
		const capabilities = analyzePMToolCapabilities(ATLASSIAN_ROVO_TOOLS);

		expect(capabilities.taskGet?.idParam).toBe("issueIdOrKey");
	});

	it("should NOT mark fieldsObjectBased on a tool that has top-level title/description params and a NON-required fields param", () => {
		// Optional-fields path: when the `fields` param is present but the
		// schema does NOT require it, the server is OK with us shipping the
		// update via top-level title/description (a common hybrid shape).
		// Detection should prefer the explicit top-level params.
		const capabilities = analyzePMToolCapabilities({
			update_issue: {
				name: "update_issue",
				description: "hypothetical hybrid (optional fields)",
				inputSchema: {
					type: "object",
					properties: {
						issue_id: { type: "string" },
						title: { type: "string" },
						description: { type: "string" },
						fields: { type: "object" },
					},
					required: ["issue_id"],
				},
			},
		});

		expect(capabilities.taskUpdate?.titleParam).toBe("title");
		expect(capabilities.taskUpdate?.fieldsObjectBased).toBeUndefined();
	});

	it("should detect fieldsObjectBased when `fields` is REQUIRED even if a title-pattern param also exists at top level", () => {
		// Regression for #1266 (observed live 2026-05-28 on staging Jira F-002).
		// The previous detection bailed out whenever ANY top-level param matched
		// title/description name patterns, leaving us in the fall-through branch
		// that sent `{ idParam, title, desc }` without the required `fields`
		// object. The Atlassian server then rejected with `path: ["fields"],
		// message: "Required"`. The fix: prefer `fieldsObjectBased` whenever
		// `fields` is required + object — the title-pattern matches at top
		// level are spurious / redundant when the server requires `fields`.
		const capabilities = analyzePMToolCapabilities({
			editJiraIssue: {
				name: "editJiraIssue",
				description:
					"Update issue (Jira-like schema with extra params)",
				inputSchema: {
					type: "object",
					properties: {
						cloudId: { type: "string" },
						issueIdOrKey: { type: "string" },
						// Spurious name-pattern match — does not actually carry
						// the issue title in Jira semantics but matches /^name$/.
						name: { type: "string" },
						// Spurious notes-pattern match — same idea.
						notes: { type: "string" },
						fields: { type: "object" },
					},
					required: ["cloudId", "issueIdOrKey", "fields"],
				},
			},
		});

		expect(capabilities.taskUpdate?.idParam).toBe("issueIdOrKey");
		// fieldsObjectBased MUST be set so the activity sends `fields`.
		expect(capabilities.taskUpdate?.fieldsObjectBased).toEqual({
			fieldsParam: "fields",
			titleField: "summary",
			descriptionField: "description",
		});
	});
});
