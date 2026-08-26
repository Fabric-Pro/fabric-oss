/**
 * Regression tests for testPMSyncProcedure args building.
 *
 * The non-fieldsBased branch must NOT spread additionalContext: it carries
 * ADO-only keys (workItemType, areaPath, iterationPath) that strict provider
 * schemas (e.g. GitLab create_issue) reject. The fieldsBased branch must
 * still pass workItemType through the dynamic param name.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockExecuteMcpTool,
	mockDiscoverPMToolCapabilities,
	mockResolveGitLabPMSource,
	mockCreateGitLabIssueFromStory,
	mockRecordAuditFromRequest,
} = vi.hoisted(() => ({
	mockExecuteMcpTool: vi.fn(),
	mockDiscoverPMToolCapabilities: vi.fn(),
	mockResolveGitLabPMSource: vi.fn(),
	mockCreateGitLabIssueFromStory: vi.fn(),
	mockRecordAuditFromRequest: vi.fn(),
}));

vi.mock("../../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) =>
		mockRecordAuditFromRequest(...args),
}));

vi.mock("@repo/database", () => ({
	resolvePMConfigForUser: vi.fn(),
	isPmServerIdKeySentinel: (id: string) => id.startsWith("key:"),
	readPmServerIdKeySentinel: (id: string) => id.slice("key:".length),
	db: {
		project: {
			findUnique: vi.fn(),
		},
		mCPServer: {
			findUnique: vi.fn(),
		},
		workflowIntegration: {
			findFirst: vi.fn(),
		},
	},
}));

vi.mock("@repo/temporal", () => ({
	discoverPMToolCapabilities: (...args: unknown[]) =>
		mockDiscoverPMToolCapabilities(...args),
	executeMcpTool: (...args: unknown[]) => mockExecuteMcpTool(...args),
}));

vi.mock("@repo/integrations/gitlab/pm-adapter", () => ({
	resolveGitLabPMSource: (...args: unknown[]) =>
		mockResolveGitLabPMSource(...args),
	createGitLabIssueFromStory: (...args: unknown[]) =>
		mockCreateGitLabIssueFromStory(...args),
}));

vi.mock("../../../../../../orpc/procedures", () => {
	const chain = {
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

import { db, resolvePMConfigForUser } from "@repo/database";
import { testPMSyncProcedure } from "../test-pm-sync";

const baseCtx = {
	user: { id: "user-1" },
	session: { id: "session-1" },
};

interface ProjectFixtureOverrides {
	additionalContext?: Record<string, string>;
}

function setupProject(overrides: ProjectFixtureOverrides = {}) {
	vi.mocked(db.project.findUnique).mockResolvedValue({
		id: "proj-1",
		organizationId: null,
		projectManagementMcpServerId: "mcp-server-1",
		projectManagementMcpConfigId: "mcp-cfg-1",
		projectManagementContainerId: "container-1",
		projectManagementAdditionalContext: overrides.additionalContext ?? {},
	} as never);

	vi.mocked(resolvePMConfigForUser).mockResolvedValue({
		id: "user-mcp-cfg-1",
	} as never);
}

function setupCapabilities(taskCreation: Record<string, unknown>) {
	mockDiscoverPMToolCapabilities.mockResolvedValue({
		hasPMCapabilities: true,
		taskCreation,
	});
}

function defaultExecuteSuccess() {
	mockExecuteMcpTool.mockResolvedValue({
		success: true,
		output: {
			content: [
				{
					type: "text",
					text: JSON.stringify({ id: "1", web_url: "u" }),
				},
			],
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("testPMSyncProcedure — non-fieldsBased branch", () => {
	it("does NOT leak ADO-only keys into args for GitLab-style tools", async () => {
		setupProject({
			additionalContext: {
				workItemType: "User Story",
				areaPath: "MyProject\\Area",
				iterationPath: "MyProject\\Sprint 1",
			},
		});
		setupCapabilities({
			toolName: "create_issue",
			containerParam: "project_id",
			titleParam: "title",
			descriptionParam: "description",
		});
		defaultExecuteSuccess();

		const handler = (
			testPMSyncProcedure as unknown as {
				handler: (args: {
					input: unknown;
					context: unknown;
				}) => Promise<unknown>;
			}
		).handler;
		await handler({ input: { projectId: "proj-1" }, context: baseCtx });

		expect(mockExecuteMcpTool).toHaveBeenCalledTimes(1);
		const callArgs = mockExecuteMcpTool.mock.calls[0][0].args;
		expect(callArgs).not.toHaveProperty("workItemType");
		expect(callArgs).not.toHaveProperty("areaPath");
		expect(callArgs).not.toHaveProperty("iterationPath");
		expect(callArgs).toMatchObject({
			project_id: "container-1",
			title: expect.any(String),
			description: expect.any(String),
		});
	});

	it("passes account_slug through for Fizzy-style tools", async () => {
		setupProject({
			additionalContext: {
				account_slug: "acme",
				workItemType: "User Story",
			},
		});
		setupCapabilities({
			toolName: "fizzy_create_card",
			containerParam: "board_id",
			titleParam: "title",
			descriptionParam: "description",
		});
		defaultExecuteSuccess();

		const handler = (
			testPMSyncProcedure as unknown as {
				handler: (args: {
					input: unknown;
					context: unknown;
				}) => Promise<unknown>;
			}
		).handler;
		await handler({ input: { projectId: "proj-1" }, context: baseCtx });

		const callArgs = mockExecuteMcpTool.mock.calls[0][0].args;
		expect(callArgs).toMatchObject({
			board_id: "container-1",
			account_slug: "acme",
			title: expect.any(String),
		});
		expect(callArgs).not.toHaveProperty("workItemType");
	});
});

describe("testPMSyncProcedure — fieldsBased branch (ADO)", () => {
	it("passes workItemType through the dynamic fieldsBased param", async () => {
		setupProject({
			additionalContext: {
				workItemType: "Bug",
				areaPath: "Proj/Area",
				iterationPath: "Proj/Iter",
			},
		});
		setupCapabilities({
			toolName: "wit_create_work_item",
			containerParam: "project",
			fieldsBased: {
				titleKey: "System.Title",
				descriptionKey: "System.Description",
				workItemTypeParam: "workItemType",
				fieldsParam: "fields",
			},
		});
		defaultExecuteSuccess();

		const handler = (
			testPMSyncProcedure as unknown as {
				handler: (args: {
					input: unknown;
					context: unknown;
				}) => Promise<unknown>;
			}
		).handler;
		await handler({ input: { projectId: "proj-1" }, context: baseCtx });

		const callArgs = mockExecuteMcpTool.mock.calls[0][0].args;
		expect(callArgs.workItemType).toBe("Bug");
		expect(callArgs.project).toBe("container-1");
		expect(Array.isArray(callArgs.fields)).toBe(true);
		const titleField = callArgs.fields.find(
			(f: { name: string }) => f.name === "System.Title",
		);
		expect(titleField).toBeDefined();
	});

	it("defaults workItemType to 'User Story' when not provided", async () => {
		setupProject({ additionalContext: {} });
		setupCapabilities({
			toolName: "wit_create_work_item",
			containerParam: "project",
			fieldsBased: {
				titleKey: "System.Title",
				descriptionKey: "System.Description",
				workItemTypeParam: "workItemType",
				fieldsParam: "fields",
			},
		});
		defaultExecuteSuccess();

		const handler = (
			testPMSyncProcedure as unknown as {
				handler: (args: {
					input: unknown;
					context: unknown;
				}) => Promise<unknown>;
			}
		).handler;
		await handler({ input: { projectId: "proj-1" }, context: baseCtx });

		const callArgs = mockExecuteMcpTool.mock.calls[0][0].args;
		expect(callArgs.workItemType).toBe("User Story");
	});
});

describe("testPMSyncProcedure — GitLab REST fallback", () => {
	const handler = () =>
		(
			testPMSyncProcedure as unknown as {
				handler: (args: {
					input: unknown;
					context: unknown;
				}) => Promise<{
					success: boolean;
					pmToolType?: string;
					externalId?: string;
				}>;
			}
		).handler;

	it("routes through REST even when an old project carries a stale config id", async () => {
		// Old project migrated from GitLab MCP → REST: it still references a
		// stale projectManagementMcpConfigId, but the calling user has no
		// resolvable MCPConfig. This must NOT 400; it should fall through to
		// the GitLab REST adapter.
		vi.mocked(db.project.findUnique).mockResolvedValue({
			id: "proj-1",
			organizationId: null,
			projectManagementMcpServerId: "gitlab-server-1",
			projectManagementMcpConfigId: "stale-cfg-1",
			projectManagementContainerId: "example-group/fabricgl",
			projectManagementAdditionalContext: {},
		} as never);
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null as never);
		vi.mocked(db.mCPServer.findUnique).mockResolvedValue({
			key: "gitlab-official",
		} as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "int-1",
		} as never);
		mockResolveGitLabPMSource.mockResolvedValue({ kind: "rest" });
		mockCreateGitLabIssueFromStory.mockResolvedValue({
			externalId: "42",
			externalUrl:
				"https://gitlab.com/example-group/fabricgl/-/issues/42",
		});

		const result = await handler()({
			input: { projectId: "proj-1" },
			context: baseCtx,
		});

		expect(result.success).toBe(true);
		expect(result.pmToolType).toBe("gitlab-rest");
		expect(result.externalId).toBe("42");
		expect(mockCreateGitLabIssueFromStory).toHaveBeenCalledTimes(1);
		expect(mockExecuteMcpTool).not.toHaveBeenCalled();
	});

	it("honors the key:gitlab-official sentinel without touching the catalog", async () => {
		vi.mocked(db.project.findUnique).mockResolvedValue({
			id: "proj-1",
			organizationId: null,
			projectManagementMcpServerId: "key:gitlab-official",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "example-group/fabricgl",
			projectManagementAdditionalContext: {},
		} as never);
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "int-1",
		} as never);
		mockResolveGitLabPMSource.mockResolvedValue({ kind: "rest" });
		mockCreateGitLabIssueFromStory.mockResolvedValue({
			externalId: "7",
			externalUrl: "https://gitlab.com/example-group/fabricgl/-/issues/7",
		});

		const result = await handler()({
			input: { projectId: "proj-1" },
			context: baseCtx,
		});

		expect(result.success).toBe(true);
		expect(result.pmToolType).toBe("gitlab-rest");
		expect(result.externalId).toBe("7");
		// Sentinel must short-circuit — catalog lookup must NOT fire.
		expect(vi.mocked(db.mCPServer.findUnique)).not.toHaveBeenCalled();
		expect(mockCreateGitLabIssueFromStory).toHaveBeenCalledTimes(1);
		expect(mockExecuteMcpTool).not.toHaveBeenCalled();
	});
});

describe("testPMSyncProcedure — soft-failure audit emission (PR #1221 gap)", () => {
	// Background: PR #1221 wired audit logging for GitLab REST sync via the
	// audit-error middleware, which only fires on thrown errors. testPMSync
	// returns `{success:false, message}` on token expiry / MCP-create failure
	// (HTTP 200), bypassing the middleware. These tests pin explicit audit
	// emission inside both soft-failure branches.

	const handler = () =>
		(
			testPMSyncProcedure as unknown as {
				handler: (args: {
					input: unknown;
					context: unknown;
				}) => Promise<{ success: boolean; message: string }>;
			}
		).handler;

	it("emits story.pm_pushed/failure audit when GitLab REST create throws (token expired)", async () => {
		vi.mocked(db.project.findUnique).mockResolvedValue({
			id: "proj-1",
			organizationId: null,
			projectManagementMcpServerId: "key:gitlab-official",
			projectManagementMcpConfigId: null,
			projectManagementContainerId: "example-group/fabricgl",
			projectManagementAdditionalContext: {},
		} as never);
		vi.mocked(resolvePMConfigForUser).mockResolvedValue(null as never);
		vi.mocked(db.workflowIntegration.findFirst).mockResolvedValue({
			id: "int-1",
		} as never);
		mockResolveGitLabPMSource.mockResolvedValue({ kind: "rest" });
		mockCreateGitLabIssueFromStory.mockRejectedValue(
			new Error(
				"GitLab access token expired and refresh failed. Please reconnect your GitLab account in Settings > Integrations.",
			),
		);

		const result = await handler()({
			input: { projectId: "proj-1" },
			context: baseCtx,
		});

		expect(result.success).toBe(false);
		expect(result.message).toMatch(/GitLab access token expired/);
		expect(mockRecordAuditFromRequest).toHaveBeenCalledTimes(1);
		expect(mockRecordAuditFromRequest).toHaveBeenCalledWith(
			baseCtx,
			expect.objectContaining({
				action: "story.pm_pushed",
				category: "story",
				outcome: "failure",
				severity: "warning",
				projectId: "proj-1",
				metadata: expect.objectContaining({
					op: "test-pm-sync",
					pmTool: "gitlab-rest",
					reason: expect.stringMatching(/expired/),
				}),
			}),
		);
	});

	it("emits story.pm_pushed/failure audit when MCP executeMcpTool returns success:false", async () => {
		setupProject();
		setupCapabilities({
			toolName: "create_issue",
			containerParam: "project_id",
			titleParam: "title",
		});
		mockDiscoverPMToolCapabilities.mockResolvedValue({
			hasPMCapabilities: true,
			detectedType: "jira",
			taskCreation: {
				toolName: "create_issue",
				containerParam: "project_id",
				titleParam: "title",
			},
		});
		mockExecuteMcpTool.mockResolvedValue({
			success: false,
			output: { error: "Permission denied creating issue" },
		});

		const result = await handler()({
			input: { projectId: "proj-1" },
			context: baseCtx,
		});

		expect(result.success).toBe(false);
		expect(result.message).toContain("Permission denied creating issue");
		expect(mockRecordAuditFromRequest).toHaveBeenCalledTimes(1);
		expect(mockRecordAuditFromRequest).toHaveBeenCalledWith(
			baseCtx,
			expect.objectContaining({
				action: "story.pm_pushed",
				outcome: "failure",
				metadata: expect.objectContaining({
					op: "test-pm-sync",
					pmTool: "jira",
					reason: "Permission denied creating issue",
				}),
			}),
		);
	});

	it("does NOT emit failure audit on success (happy path stays quiet)", async () => {
		setupProject();
		setupCapabilities({
			toolName: "create_issue",
			containerParam: "project_id",
			titleParam: "title",
		});
		defaultExecuteSuccess();

		const result = await handler()({
			input: { projectId: "proj-1" },
			context: baseCtx,
		});

		expect(result.success).toBe(true);
		expect(mockRecordAuditFromRequest).not.toHaveBeenCalled();
	});
});
