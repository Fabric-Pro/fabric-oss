/**
 * `updateProjectProcedure` runs in the project's own organization.
 *
 * `requireProjectPermission(PROJECT_UPDATE)` authorizes the PROJECT. Linking a
 * repository starts code analysis with an AI token that the workflow's agent
 * exchanges for the named organization's decrypted provider key, so that
 * organization — and every other tenant use in the handler — is the project
 * row's, never `input.organizationId` (the caller's own string).
 *
 * The update double applies the same XOR tenant filter the real
 * `updateProject` does (`organizationId` must match the row), so the test
 * also shows what a mismatched input organization did before: the save was
 * refused outright.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT_ORG = "org-a";
const INPUT_ORG = "org-b";

const mockUpdateProject = vi.fn();
const mockGetProject = vi.fn();
const mockIssueAIToken = vi.fn();
const mockWorkflowStart = vi.fn();
const mockStartCodeIndexing = vi.fn();
const mockRecordAudit = vi.fn();

vi.mock("@repo/database", async () => ({
	engagementProfileSchema: (await import("zod")).z.enum([
		"EXPLORE",
		"PROPOSAL",
		"GOVERNED",
		"DELEGATED",
	]),
	db: { project: { findUnique: (...a: unknown[]) => mockGetProject(...a) } },
	updateProject: (...a: unknown[]) => mockUpdateProject(...a),
	seedTerminalStatusesIfEmpty: vi.fn(),
	Prisma: { JsonNull: Symbol("JsonNull") },
	cleanupCodeSearchOnRepoUnlink: vi.fn(async () => ({
		deletedContextQdrantIds: [],
		organizationId: null,
	})),
	moveWizardTempContextsToProject: vi.fn(),
	syncLegacyProjectRepoOnDisconnect: vi.fn(async () => {}),
}));
vi.mock("@repo/ai-token", () => ({
	issueAIToken: (...a: unknown[]) => mockIssueAIToken(...a),
}));
vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: (...a: unknown[]) => mockWorkflowStart(...a) },
	}),
}));
vi.mock("../../lib/code-indexing-trigger", () => ({
	startCodeIndexingForProject: (...a: unknown[]) =>
		mockStartCodeIndexing(...a),
	cancelCodeIndexingForRepo: vi.fn(),
}));
vi.mock("../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (options: unknown) => options,
}));
vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: (...a: unknown[]) => mockRecordAudit(...a),
}));
vi.mock("../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		// Mirrors the real resolver: the input string, verbatim.
		resolveOrganizationId: (o: string | null | undefined) => o ?? undefined,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: Record<string, unknown>;
	context: { user: { id: string }; session: { id: string } };
}) => Promise<unknown>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../update-project");
	return (mod.updateProjectProcedure as unknown as { handler: Handler })
		.handler;
}

beforeEach(() => {
	vi.clearAllMocks();
	mockGetProject.mockResolvedValue({
		name: "Proj",
		repositoryUrl: null,
		organizationId: PROJECT_ORG,
		projectManagementMcpServerId: null,
		projectManagementMcpConfigId: null,
		projectManagementContainerId: null,
		projectManagementAdditionalContext: null,
	});
	// The real update's WHERE carries the XOR tenant filter: the row must be
	// in the organization it is given, or Prisma reports P2025.
	mockUpdateProject.mockImplementation(
		async (id: string, _userId: string, _data: unknown, org?: string) => {
			if ((org ?? null) !== PROJECT_ORG) {
				throw Object.assign(new Error("Record to update not found."), {
					code: "P2025",
				});
			}
			return {
				id,
				name: "Proj",
				codeAnalysisStatus: "NOT_STARTED",
				projectTypes: [],
			};
		},
	);
	mockIssueAIToken.mockResolvedValue("ai-token");
	mockWorkflowStart.mockResolvedValue({ workflowId: "wf-1" });
	mockStartCodeIndexing.mockResolvedValue({ started: 0, skipped: [] });
});

describe("updateProjectProcedure — tenant comes from the project", () => {
	it("saves, mints the code-analysis AI token and starts the workflow in the project's organization when the input names another", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				id: "proj-1",
				organizationId: INPUT_ORG,
				repositoryUrl: "https://github.com/example-org/repo",
				repositoryOwner: "example-org",
				repositoryName: "repo",
			},
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});

		expect(mockUpdateProject.mock.calls[0][3]).toBe(PROJECT_ORG);
		expect(mockIssueAIToken).toHaveBeenCalledTimes(1);
		expect(mockIssueAIToken).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "user-1",
				organizationId: PROJECT_ORG,
				source: "auto-code-analysis",
			}),
		);
		const [, options] = mockWorkflowStart.mock.calls[0];
		const args = (options as { args: unknown[] }).args[0] as {
			organizationId?: string;
		};
		expect(args.organizationId).toBe(PROJECT_ORG);
		expect(mockStartCodeIndexing).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: PROJECT_ORG }),
		);
		expect(mockRecordAudit).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({ organizationId: PROJECT_ORG }),
		);
		for (const call of mockIssueAIToken.mock.calls) {
			expect(
				(call[0] as { organizationId?: string }).organizationId,
			).not.toBe(INPUT_ORG);
		}
	});

	it("derives the token's organization from the project even when the save itself does not filter by tenant", async () => {
		// Pins the token independently of the update's WHERE clause: the
		// organization handed to the agent must come from the project row.
		mockUpdateProject.mockResolvedValue({
			id: "proj-1",
			name: "Proj",
			codeAnalysisStatus: "NOT_STARTED",
			projectTypes: [],
		});

		const handler = await loadHandler();
		await handler({
			input: {
				id: "proj-1",
				organizationId: INPUT_ORG,
				repositoryUrl: "https://github.com/example-org/repo",
				repositoryOwner: "example-org",
				repositoryName: "repo",
			},
			context: { user: { id: "user-1" }, session: { id: "s" } },
		});

		expect(mockIssueAIToken).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: PROJECT_ORG }),
		);
	});

	it.each([
		{
			label: "a project with no organization",
			row: { organizationId: null },
			code: "FORBIDDEN",
		},
		{ label: "a missing project", row: null, code: "NOT_FOUND" },
	])(
		"refuses $label before any write, token or workflow start",
		async ({ row, code }) => {
			mockGetProject.mockResolvedValue(
				row
					? {
							name: "Proj",
							repositoryUrl: null,
							projectManagementMcpServerId: null,
							projectManagementMcpConfigId: null,
							projectManagementContainerId: null,
							projectManagementAdditionalContext: null,
							...row,
						}
					: null,
			);
			mockUpdateProject.mockResolvedValue({
				id: "proj-1",
				name: "Proj",
				codeAnalysisStatus: "NOT_STARTED",
				projectTypes: [],
			});

			const handler = await loadHandler();
			await expect(
				handler({
					input: {
						id: "proj-1",
						organizationId: INPUT_ORG,
						repositoryUrl: "https://github.com/example-org/repo",
						repositoryOwner: "example-org",
						repositoryName: "repo",
					},
					context: { user: { id: "user-1" }, session: { id: "s" } },
				}),
			).rejects.toMatchObject({ code });

			expect(mockUpdateProject).not.toHaveBeenCalled();
			expect(mockIssueAIToken).not.toHaveBeenCalled();
			expect(mockWorkflowStart).not.toHaveBeenCalled();
			expect(mockStartCodeIndexing).not.toHaveBeenCalled();
			expect(mockRecordAudit).not.toHaveBeenCalled();
		},
	);
});
