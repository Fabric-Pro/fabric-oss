/**
 * Tests for `retryExistingSetupProcedure` — running a failed code analysis
 * again over the repositories the project is connected to (Fizzy #3429).
 *
 * The retry goes through the same `startExistingProjectSetup` body as
 * `existingSetup.start` (whose own tests stay in
 * `start-existing-setup.test.ts`), so these tests assert what reaches the
 * workflow: the connected repositories, each with the role its sync gives it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectFindUnique = vi.fn();
const mockProjectUpdate = vi.fn();
const mockRepoIntegrationFindMany = vi.fn();
const mockRepoIntegrationFindFirst = vi.fn();
const mockInstructionSyncFindUnique = vi.fn();
const mockContextSyncFindUnique = vi.fn();
const mockGetProjectMemberRole = vi.fn();
const mockLogRepoIntegrationActivity = vi.fn();
const mockIssueAIToken = vi.fn();
const mockWorkflowStart = vi.fn();
const mockProjectSetupIsPaused = vi.fn();
const mockCancelPausedSetupsOfProject = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: (...args: unknown[]) => mockProjectFindUnique(...args),
			update: (...args: unknown[]) => mockProjectUpdate(...args),
		},
		projectRepositoryIntegration: {
			findMany: (...args: unknown[]) =>
				mockRepoIntegrationFindMany(...args),
			findFirst: (...args: unknown[]) =>
				mockRepoIntegrationFindFirst(...args),
		},
		projectInstructionRepositorySync: {
			findUnique: (...args: unknown[]) =>
				mockInstructionSyncFindUnique(...args),
		},
		projectContextRepositorySync: {
			findUnique: (...args: unknown[]) =>
				mockContextSyncFindUnique(...args),
		},
		workflowIntegration: { findFirst: async () => null },
	},
	createProjectRepoIntegration: vi.fn(),
	syncLegacyProjectRepoOnConnect: vi.fn(),
	getProjectMemberRole: (...args: unknown[]) =>
		mockGetProjectMemberRole(...args),
	logRepoIntegrationActivity: (...args: unknown[]) =>
		mockLogRepoIntegrationActivity(...args),
	parseRepoUrl: (url: string) => {
		const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)$/);
		return match
			? { provider: "GITHUB", owner: match[1], name: match[2], url }
			: null;
	},
	ProjectMemberRole: { OWNER: "OWNER", ADMIN: "ADMIN", MEMBER: "MEMBER" },
}));

vi.mock("@repo/integrations/gitlab", () => ({
	getGitLabConnectionToken: async () => ({
		ok: false,
		reason: "not-connected",
		message: "not connected",
	}),
}));
vi.mock("@repo/ai-token", () => ({
	issueAIToken: (...args: unknown[]) => mockIssueAIToken(...args),
}));
vi.mock("@repo/ai/lib/chatgpt-plan/interactive-context", () => ({
	isAiImpersonatedRequest: () => false,
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mockWorkflowStart },
	}),
}));
vi.mock("../../lib/paused-setup", () => ({
	projectSetupIsPaused: (...args: unknown[]) =>
		mockProjectSetupIsPaused(...args),
	cancelPausedSetupsOfProject: (...args: unknown[]) =>
		mockCancelPausedSetupsOfProject(...args),
}));
vi.mock("@repo/utils", () => ({
	encryptApiKey: (value: string) => `encrypted:${value}`,
	decryptApiKey: (value: string) => value.replace(/^encrypted:/, ""),
}));
vi.mock("@repo/utils/url-security", () => ({
	assertSafeOutboundUrlResolved: async () => undefined,
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));
vi.mock("@repo/connectors", () => ({
	resolveDefaultBranch: vi.fn(),
	verifyRepositoryAccess: vi.fn(),
	validateGitLabPat: vi.fn(),
}));

vi.mock("../../../../orpc/procedures", () => {
	const makeBuilder = () => {
		const builder: Record<string, unknown> = {};
		builder.use = () => builder;
		builder.route = () => builder;
		builder.input = (schema: unknown) => {
			builder.inputSchema = schema;
			return builder;
		};
		builder.handler = (fn: unknown) => ({
			handler: fn,
			inputSchema: builder.inputSchema,
		});
		return builder;
	};
	return {
		get tenantProtectedProcedure() {
			return makeBuilder();
		},
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: { projectId: string; organizationId?: string | null };
	context: { user: { id: string; name: string } };
}) => Promise<{ workflowId: string; status: string }>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../retry-existing-setup");
	return (mod.retryExistingSetupProcedure as unknown as { handler: Handler })
		.handler;
}

const context = { user: { id: "user-1", name: "Example User" } };
const CODE_URL = "https://github.com/example-org/product";
const OTHER_CODE_URL = "https://github.com/example-org/service";
const INSTRUCTIONS_URL = "https://github.com/example-org/instructions";
const KNOWLEDGE_URL = "https://github.com/example-org/docs";

function workflowArgs() {
	const [workflowName, options] = mockWorkflowStart.mock.calls[0] ?? [];
	expect(workflowName).toBe("existingProjectSetupWorkflow");
	return (options as { args: Record<string, unknown>[] }).args[0];
}

beforeEach(() => {
	vi.resetAllMocks();
	mockProjectFindUnique.mockResolvedValue({
		id: "p1",
		organizationId: "org-1",
		name: "Example Project",
		codeAnalysisStatus: "FAILED",
		defaultBranch: "main",
		projectManagementMcpConfigId: null,
		projectManagementContainerId: null,
		projectManagementAdditionalContext: null,
	});
	mockProjectUpdate.mockResolvedValue(undefined);
	mockRepoIntegrationFindFirst.mockResolvedValue({ id: "existing" });
	mockRepoIntegrationFindMany.mockResolvedValue([
		{ id: "ri-code", repositoryUrl: CODE_URL },
		{ id: "ri-instructions", repositoryUrl: INSTRUCTIONS_URL },
		{ id: "ri-knowledge", repositoryUrl: KNOWLEDGE_URL },
		{ id: "ri-other", repositoryUrl: OTHER_CODE_URL },
	]);
	mockInstructionSyncFindUnique.mockResolvedValue({
		repositoryIntegrationId: "ri-instructions",
	});
	mockContextSyncFindUnique.mockResolvedValue({
		repositoryIntegrationId: "ri-knowledge",
	});
	mockGetProjectMemberRole.mockResolvedValue("MEMBER");
	mockLogRepoIntegrationActivity.mockResolvedValue(undefined);
	mockIssueAIToken.mockResolvedValue("ai-token");
	mockProjectSetupIsPaused.mockResolvedValue(false);
	mockCancelPausedSetupsOfProject.mockResolvedValue(undefined);
	mockWorkflowStart.mockResolvedValue(undefined);
});

describe("retryExistingSetupProcedure", () => {
	it("analyses every connected repository with the role its sync gives it", async () => {
		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "p1", organizationId: "org-other" },
			context,
		});

		expect(result.status).toBe("SCANNING");
		expect(mockRepoIntegrationFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "p1", status: { not: "DISCONNECTED" } },
			}),
		);
		const args = workflowArgs();
		expect(args).toMatchObject({
			projectId: "p1",
			// The project's own organization, never the caller's string.
			organizationId: "org-1",
			repoUrls: [
				CODE_URL,
				INSTRUCTIONS_URL,
				KNOWLEDGE_URL,
				OTHER_CODE_URL,
			],
			repoRoles: {
				[INSTRUCTIONS_URL]: "instructions",
				[KNOWLEDGE_URL]: "knowledge",
			},
			selectedDocumentTypes: [],
			projectTypes: [],
			projectName: "Example Project",
		});
		expect(mockProjectUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					codeAnalysisStatus: "SCANNING",
				}),
			}),
		);
		expect(mockLogRepoIntegrationActivity).toHaveBeenCalledWith(
			expect.objectContaining({ activityType: "repo_scan_triggered" }),
		);
	});

	it("reads every repository as code when the project has no syncs", async () => {
		mockInstructionSyncFindUnique.mockResolvedValue(null);
		mockContextSyncFindUnique.mockResolvedValue(null);
		const handler = await loadHandler();
		await handler({ input: { projectId: "p1" }, context });

		expect(workflowArgs()).not.toHaveProperty("repoRoles");
	});

	it("refuses a project with no connected code repository", async () => {
		mockRepoIntegrationFindMany.mockResolvedValue([
			{ id: "ri-instructions", repositoryUrl: INSTRUCTIONS_URL },
		]);
		const handler = await loadHandler();

		await expect(
			handler({ input: { projectId: "p1" }, context }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mockIssueAIToken).not.toHaveBeenCalled();
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("refuses a project with no repository at all", async () => {
		mockRepoIntegrationFindMany.mockResolvedValue([]);
		const handler = await loadHandler();

		await expect(
			handler({ input: { projectId: "p1" }, context }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("refuses while an analysis is already running", async () => {
		mockProjectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: "org-1",
			name: "Example Project",
			codeAnalysisStatus: "SCANNING",
		});
		const handler = await loadHandler();

		await expect(
			handler({ input: { projectId: "p1" }, context }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("refuses a project that does not exist", async () => {
		mockProjectFindUnique.mockResolvedValue(null);
		const handler = await loadHandler();

		await expect(
			handler({ input: { projectId: "missing" }, context }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mockRepoIntegrationFindMany).not.toHaveBeenCalled();
	});
});
