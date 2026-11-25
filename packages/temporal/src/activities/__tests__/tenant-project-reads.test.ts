import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchContextForSummaryActivity } from "../context-summarization/fetch-context-for-summary";
import { resolveApplyPmConfig } from "../pm-integration/resolve-apply-pm-config";
import { fetchProjectContextsForReprocess } from "../project-contexts-reprocess";
import { gatherRoadmapRecommendationContext } from "../roadmap-recommendation";

const mocks = vi.hoisted(() => ({
	project: vi.fn(),
	contexts: vi.fn(),
	resolvePm: vi.fn(),
	rag: vi.fn(),
	backlog: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/database")>()),
	db: { project: { findUnique: mocks.project } },
}));
vi.mock("@repo/database/prisma/client", () => ({
	db: { projectContext: { findMany: mocks.contexts } },
}));
vi.mock("@repo/integrations/gitlab", () => ({
	resolveProjectPMConfigForUser: mocks.resolvePm,
	GitLabPmOriginMismatchError: class extends Error {},
}));
vi.mock("@repo/ai", () => ({ getSystemEmbeddingRAGProviderConfig: vi.fn() }));
vi.mock("@repo/rag", () => ({ reembedProjectContext: vi.fn() }));
vi.mock("@repo/rag/lib/project-contexts/store", () => ({
	deleteOrphanProjectContextPoints: vi.fn(),
}));
vi.mock("../backlog-context/analyze-context", () => ({
	ROADMAP_RECOMMEND_PROMPT_VERSION: "example-prompt",
}));
vi.mock("../backlog-context/fetch-context", () => ({
	retrieveProjectRagContext: mocks.rag,
}));
vi.mock("../backlog-context/fetch-backlog-snapshot", () => ({
	fetchBacklogSnapshot: mocks.backlog,
}));

const scope = {
	organizationId: "example-org",
	userId: "example-user",
	projectId: "example-project",
};
const project = {
	id: scope.projectId,
	organizationId: scope.organizationId,
	userId: scope.userId,
	name: "Example project",
	description: "Example project description",
	projectManagementMcpServerId: "key:fizzy",
	projectManagementMcpConfigId: "example-pinned-config",
	projectManagementContainerId: "example-container",
	projectManagementContainerName: null,
	projectManagementAdditionalContext: null,
};

const cases = [
	{ label: "same organization", org: scope.organizationId, visible: true },
	{ label: "foreign organization", org: "example-other-org", visible: false },
	{ label: "missing record", org: null, visible: false },
];

beforeEach(() => {
	vi.resetAllMocks();
	mocks.resolvePm.mockResolvedValue({
		id: "example-user-config",
		enabled: true,
	});
	mocks.rag.mockResolvedValue({
		chunkCount: 1,
		formattedContext: "Example RAG context",
	});
	mocks.backlog.mockResolvedValue({ orphanStories: [] });
});

describe.each(cases)("$label", ({ org, visible }) => {
	const row = org === null ? null : { ...project, organizationId: org };

	it("returns a summary display name only for the scoped project", async () => {
		mocks.project.mockImplementation(async ({ where }) =>
			row &&
			where.id === row.id &&
			(where.organizationId === undefined ||
				where.organizationId === row.organizationId)
				? row
				: null,
		);
		await expect(
			fetchContextForSummaryActivity({
				projectId: scope.projectId,
				tenancy: {
					organizationId: scope.organizationId,
					userId: scope.userId,
				},
				snapshotThrough: "2026-01-01T00:00:00.000Z",
			}),
		).resolves.toEqual({
			projectName: visible ? project.name : "Untitled project",
		});
	});

	it("resolves the caller's PM config only for the scoped project", async () => {
		mocks.project.mockResolvedValue(row);
		const result = await resolveApplyPmConfig(scope);
		if (!visible) {
			expect(result).toEqual({ resolved: false, reason: "no-pm-config" });
			expect(mocks.resolvePm).not.toHaveBeenCalled();
		} else {
			expect(result).toMatchObject({
				resolved: true,
				mcpConfigId: "example-user-config",
				containerId: "example-container",
			});
			expect(mocks.resolvePm).toHaveBeenCalledWith(
				expect.objectContaining({
					organizationId: scope.organizationId,
					userId: scope.userId,
				}),
			);
		}
	});

	it("reads roadmap grounding only for the scoped project", async () => {
		mocks.project.mockImplementation(async ({ where }) =>
			row &&
			(where.organizationId === undefined ||
				where.organizationId === row.organizationId)
				? row
				: null,
		);
		const result = await gatherRoadmapRecommendationContext(scope);
		if (!visible) {
			expect(result).toMatchObject({
				fetchedContext: {},
				existingBacklog: { stories: [] },
				insufficient: true,
			});
			expect(mocks.rag).not.toHaveBeenCalled();
			expect(mocks.backlog).not.toHaveBeenCalled();
		} else {
			expect(result.fetchedContext.ragContext).toContain(
				project.description,
			);
			expect(result.fetchedContext.ragContext).toContain(
				"Example RAG context",
			);
			expect(result.insufficient).toBe(false);
		}
	});

	it("returns reprocessable text only inside its project's organization", async () => {
		const context = {
			id: "example-context",
			content: "Example context",
			type: "TEXT",
		};
		mocks.contexts.mockImplementation(async ({ where }) =>
			row &&
			(where.project?.organizationId === undefined ||
				where.project.organizationId === row.organizationId)
				? [context]
				: [],
		);
		await expect(fetchProjectContextsForReprocess(scope)).resolves.toEqual(
			visible ? [context] : [],
		);
	});
});

it("excludes reprocess text still owned by the previous tenant after a project moves", async () => {
	const movedContext = {
		id: "example-context",
		content: "Example previous tenant text",
	};
	mocks.contexts.mockImplementation(async ({ where }) =>
		where.organizationId === scope.organizationId ? [] : [movedContext],
	);
	await expect(fetchProjectContextsForReprocess(scope)).resolves.toEqual([]);
});

it("treats absent PM organization context as a refusal", async () => {
	mocks.project.mockResolvedValue({ ...project, organizationId: null });
	await expect(
		resolveApplyPmConfig({
			projectId: scope.projectId,
			userId: scope.userId,
		}),
	).resolves.toEqual({ resolved: false, reason: "no-pm-config" });
	expect(mocks.resolvePm).not.toHaveBeenCalled();
});
