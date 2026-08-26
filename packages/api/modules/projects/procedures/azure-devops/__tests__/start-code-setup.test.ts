/**
 * Integration tests for `startAzureDevOpsCodeSetupProcedure`.
 *
 * Mirrors the GitLab list-projects mock pattern (hoisted `vi.mock` factories +
 * `loadHandler`). Asserts:
 *   - NOT_FOUND when the project is missing.
 *   - BAD_REQUEST when the project has no repository info.
 *   - CONFLICT when codeAnalysisStatus === "SCANNING".
 *   - happy path starts `existingProjectSetupWorkflow` with typed args derived
 *     from the project's ACTIVE Azure DevOps integrations, and flips status to
 *     SCANNING.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Hoisted mock factories
// ---------------------------------------------------------------------------
const mockProjectFindUnique = vi.fn();
const mockListProjectRepoIntegrations = vi.fn();
const mockIssueAIToken = vi.fn();
const mockWorkflowStart = vi.fn();
const mockGetTemporalClient = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findUnique: (...args: unknown[]) => mockProjectFindUnique(...args),
		},
	},
	listProjectRepoIntegrations: (...args: unknown[]) =>
		mockListProjectRepoIntegrations(...args),
}));

vi.mock("@repo/ai-token", () => ({
	issueAIToken: (...args: unknown[]) => mockIssueAIToken(...args),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: (...args: unknown[]) => mockGetTemporalClient(...args),
}));

// `@repo/temporal/workflows` is imported for the `ExistingProjectSetupInput`
// TYPE only — erased at runtime — but vitest still resolves the module graph,
// so stub it to avoid pulling the temporal workflow bundle.
vi.mock("@repo/temporal/workflows", () => ({}));

// withCorrelationMemo just augments + returns its options object.
vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: { projectId: string; organizationId?: string | null };
	context: { user: { id: string }; session: { id: string } };
}) => Promise<{ workflowId: string; runId: string; status: string }>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../start-code-setup");
	return (
		mod.startAzureDevOpsCodeSetupProcedure as unknown as {
			handler: Handler;
		}
	).handler;
}

const baseContext = {
	user: { id: "user-1" },
	session: { id: "session-1" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mockIssueAIToken.mockResolvedValue("ai-token-123");
	mockListProjectRepoIntegrations.mockResolvedValue([]);
	mockWorkflowStart.mockResolvedValue({
		workflowId: "wf-1",
		firstExecutionRunId: "run-1",
	});
	mockGetTemporalClient.mockResolvedValue({
		workflow: { start: mockWorkflowStart },
	});
});

describe("startAzureDevOpsCodeSetupProcedure", () => {
	it("throws NOT_FOUND when the project does not exist", async () => {
		mockProjectFindUnique.mockResolvedValue(null);

		const handler = await loadHandler();
		await expect(
			handler({ input: { projectId: "p1" }, context: baseContext }),
		).rejects.toMatchObject({ message: "Project not found" });

		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("throws BAD_REQUEST when the project has no repository info", async () => {
		mockProjectFindUnique.mockResolvedValue({
			id: "p1",
			name: "Proj",
			repositoryOwner: null,
			repositoryName: null,
			codeAnalysisStatus: "NOT_STARTED",
		});

		const handler = await loadHandler();
		await expect(
			handler({ input: { projectId: "p1" }, context: baseContext }),
		).rejects.toMatchObject({
			message: expect.stringContaining(
				"does not have an Azure DevOps repository configured",
			),
		});

		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("throws CONFLICT when analysis is already SCANNING", async () => {
		mockProjectFindUnique.mockResolvedValue({
			id: "p1",
			name: "Proj",
			repositoryOwner: "my-org",
			repositoryName: "repo",
			codeAnalysisStatus: "SCANNING",
		});

		const handler = await loadHandler();
		await expect(
			handler({ input: { projectId: "p1" }, context: baseContext }),
		).rejects.toMatchObject({
			message: "Code analysis is already in progress for this project",
		});

		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("starts existingProjectSetupWorkflow with the ACTIVE ADO repo URLs and returns SCANNING", async () => {
		mockProjectFindUnique.mockResolvedValue({
			id: "p1",
			name: "Proj",
			repositoryOwner: "my-org",
			repositoryName: "repo",
			repositoryUrl: "https://dev.azure.com/my-org/Proj/_git/repo",
			projectTypes: ["WEB_APP"],
			codeAnalysisStatus: "NOT_STARTED",
		});
		mockListProjectRepoIntegrations.mockResolvedValue([
			{
				provider: "AZURE_DEVOPS",
				status: "ACTIVE",
				repositoryUrl: "https://dev.azure.com/my-org/Proj/_git/repo",
			},
			{
				provider: "AZURE_DEVOPS",
				status: "ACTIVE",
				repositoryUrl: "https://dev.azure.com/my-org/Proj/_git/api",
			},
			// A GitHub integration must NOT leak into the ADO repoUrls.
			{
				provider: "GITHUB",
				status: "ACTIVE",
				repositoryUrl: "https://github.com/my-org/other",
			},
			// An inactive ADO integration must be excluded.
			{
				provider: "AZURE_DEVOPS",
				status: "DISCONNECTED",
				repositoryUrl: "https://dev.azure.com/my-org/Proj/_git/old",
			},
		]);

		const handler = await loadHandler();
		const result = await handler({
			input: { projectId: "p1", organizationId: "org-1" },
			context: baseContext,
		});

		expect(result.status).toBe("SCANNING");
		expect(result.workflowId).toBe("wf-1");
		expect(result.runId).toBe("run-1");

		// Workflow name is the existingProjectSetupWorkflow (ADO-graceful path).
		expect(mockWorkflowStart).toHaveBeenCalledTimes(1);
		const [workflowName, options] = mockWorkflowStart.mock.calls[0];
		expect(workflowName).toBe("existingProjectSetupWorkflow");

		const args = (options as { args: unknown[] }).args[0] as {
			projectId: string;
			repoUrls: string[];
			selectedDocumentTypes: string[];
			projectTypes: string[];
			projectName: string;
			aiToken: string;
		};
		expect(args.projectId).toBe("p1");
		// Only ACTIVE ADO repos, in order; GitHub + inactive excluded.
		expect(args.repoUrls).toEqual([
			"https://dev.azure.com/my-org/Proj/_git/repo",
			"https://dev.azure.com/my-org/Proj/_git/api",
		]);
		expect(args.selectedDocumentTypes).toEqual([]);
		expect(args.projectTypes).toEqual(["WEB_APP"]);
		expect(args.projectName).toBe("Proj");
		expect(args.aiToken).toBe("ai-token-123");
	});

	it("falls back to the legacy repositoryUrl when no ADO integration row surfaces a URL", async () => {
		mockProjectFindUnique.mockResolvedValue({
			id: "p1",
			name: "Proj",
			repositoryOwner: "my-org",
			repositoryName: "repo",
			repositoryUrl: "https://dev.azure.com/my-org/Proj/_git/repo",
			projectTypes: [],
			codeAnalysisStatus: "NOT_STARTED",
		});
		mockListProjectRepoIntegrations.mockResolvedValue([]);

		const handler = await loadHandler();
		await handler({ input: { projectId: "p1" }, context: baseContext });

		const [, options] = mockWorkflowStart.mock.calls[0];
		const args = (options as { args: unknown[] }).args[0] as {
			repoUrls: string[];
		};
		expect(args.repoUrls).toEqual([
			"https://dev.azure.com/my-org/Proj/_git/repo",
		]);
	});
});
