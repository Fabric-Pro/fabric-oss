import { beforeEach, describe, expect, it, vi } from "vitest";
import { rechunkProjectSourceActivity } from "../project-chunking";
import { failContextTargetDocument } from "../project-context-processing";
import { getProjectMetadataActivity } from "../project-metadata";
import { assertProjectTenantTuple } from "../publishing-suggestion/assert-tenant";

const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	context: vi.fn(),
	document: vi.fn(),
	cycle: vi.fn(),
	reembedContext: vi.fn(),
	rechunkDocument: vi.fn(),
	contextAvailability: vi.fn(),
	repositoryRoles: vi.fn(),
	ensureJob: vi.fn(),
	stepJob: vi.fn(),
	failDocument: vi.fn(),
}));

vi.mock("@repo/database/prisma/queries/projects/documents", () => ({
	failGeneratingDocument: mocks.failDocument,
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	db: {
		project: { findFirst: mocks.project, findUnique: mocks.project },
		projectContext: { findFirst: mocks.context },
		projectDocument: { findFirst: mocks.document },
		publishingSuggestionCycle: { findUnique: mocks.cycle },
	},
	getProjectChunkingSettings: vi.fn(async () => ({ chunkingVersion: 2 })),
	getProjectContextAvailability: mocks.contextAvailability,
	getProjectRepositoryRoles: mocks.repositoryRoles,
	markProjectContextChunkingVersion: vi.fn(),
	markProjectDocumentChunkingVersion: vi.fn(),
}));
vi.mock("@repo/ai", () => ({
	getSystemEmbeddingRAGProviderConfig: vi.fn(async () => ({})),
}));
vi.mock("@repo/rag", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/rag")>()),
	reembedProjectContext: mocks.reembedContext,
	rechunkProjectDocument: mocks.rechunkDocument,
}));
vi.mock("@temporalio/activity", async (importOriginal) => ({
	...(await importOriginal<typeof import("@temporalio/activity")>()),
	heartbeat: vi.fn(),
}));
vi.mock("../lib/job-progress", async (importOriginal) => ({
	...(await importOriginal<typeof import("../lib/job-progress")>()),
	jobEnsure: mocks.ensureJob,
	jobStep: mocks.stepJob,
}));

const organizationId = "example-org";
const foreignOrg = "example-other-org";
const scope = {
	organizationId,
	projectId: "example-project",
	userId: "example-user",
};

type ScopedRow = { id: string; organizationId: string; projectId?: string };

function matches(row: ScopedRow | null, where: Partial<ScopedRow>) {
	return (
		row &&
		Object.entries(where).every(
			([key, value]) => row[key as keyof ScopedRow] === value,
		)
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.contextAvailability.mockResolvedValue({ hasCodebase: false });
	mocks.repositoryRoles.mockResolvedValue([]);
	mocks.reembedContext.mockResolvedValue({ success: true });
	mocks.rechunkDocument.mockResolvedValue({ success: true });
	mocks.failDocument.mockResolvedValue(1);
});

describe.each([
	{ label: "same organization", org: organizationId, allowed: true },
	{ label: "foreign organization", org: foreignOrg, allowed: false },
	{ label: "missing record", org: null, allowed: false },
])("$label", ({ org, allowed }) => {
	it("limits project metadata and its enrichment to the tenant", async () => {
		const row = org
			? {
					id: scope.projectId,
					organizationId: org,
					name: "Example project",
					defaultBranch: "main",
					repositoryUrl: null,
					_count: { contexts: 2, documents: 1 },
				}
			: null;
		mocks.project.mockImplementation(async ({ where }) =>
			matches(row, where) ? row : null,
		);

		const result = await getProjectMetadataActivity(scope.projectId, scope);
		if (!allowed) {
			expect(result).toBeNull();
			expect(mocks.contextAvailability).not.toHaveBeenCalled();
			expect(mocks.repositoryRoles).not.toHaveBeenCalled();
		} else {
			expect(result).toMatchObject({
				name: "Example project",
				contextCount: 2,
				documentCount: 1,
			});
		}
	});

	it.each(["context", "document"] as const)(
		"scopes the %s before passing stored text to embeddings",
		async (source) => {
			const sourceId = "example-source";
			const row = org
				? {
						id: sourceId,
						organizationId: org,
						projectId: scope.projectId,
						content: "Example source text.",
						type: "TEXT",
						isActive: true,
						chunkingVersion: 1,
					}
				: null;
			const find = source === "context" ? mocks.context : mocks.document;
			const embed =
				source === "context"
					? mocks.reembedContext
					: mocks.rechunkDocument;
			find.mockImplementation(async ({ where }) =>
				matches(row, where) ? row : null,
			);

			await expect(
				rechunkProjectSourceActivity({
					...scope,
					source,
					sourceId,
					runId: "example-run",
					chunkingVersion: 2,
				}),
			).resolves.toEqual({ outcome: allowed ? "rechunked" : "skipped" });
			if (allowed) {
				expect(embed).toHaveBeenCalledWith(
					expect.objectContaining({
						organizationId,
						content: row?.content,
					}),
				);
			} else {
				expect(embed).not.toHaveBeenCalled();
			}
		},
	);

	it("proves the project matches before starting publishing work", async () => {
		mocks.project.mockResolvedValue(
			org ? { userId: scope.userId, organizationId: org } : null,
		);
		mocks.cycle.mockResolvedValue({
			organizationId,
			projectId: scope.projectId,
			userId: null,
		});
		const result = assertProjectTenantTuple({
			...scope,
			cycleId: "example-cycle",
			actorUserId: scope.userId,
			tenantUserId: null,
		});
		if (allowed) {
			await expect(result).resolves.toBeUndefined();
			expect(mocks.ensureJob).toHaveBeenCalledWith(
				expect.objectContaining({
					organizationId,
					projectId: scope.projectId,
				}),
			);
			expect(mocks.stepJob).toHaveBeenCalled();
		} else {
			await expect(result).rejects.toMatchObject({
				type: "PUBLISHING_TENANT_MISMATCH",
				nonRetryable: true,
			});
			expect(mocks.ensureJob).not.toHaveBeenCalled();
			expect(mocks.stepJob).not.toHaveBeenCalled();
		}
	});

	it("only fails the document placeholder linked to a scoped context", async () => {
		const contextId = "example-upload-context";
		const row = org
			? {
					id: contextId,
					organizationId: org,
					projectId: scope.projectId,
					metadata: { targetDocumentId: "example-placeholder" },
				}
			: null;
		mocks.context.mockImplementation(async ({ where }) =>
			matches(row, where) ? row : null,
		);

		await expect(
			failContextTargetDocument({
				...scope,
				contextId,
				reason: "Example extraction error",
			}),
		).resolves.toEqual({ applied: allowed });
		if (allowed) {
			expect(mocks.failDocument).toHaveBeenCalledExactlyOnceWith({
				documentId: "example-placeholder",
				projectId: scope.projectId,
				reason: "Example extraction error",
			});
		} else {
			expect(mocks.failDocument).not.toHaveBeenCalled();
		}
	});
});
