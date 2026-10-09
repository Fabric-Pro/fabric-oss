/**
 * Company context ingestion through the shared activities (Fizzy #2719).
 *
 * The file-processing, embedding and deletion activities serve company
 * context sources when their input names a company owner. What this pins:
 *
 *  - a company run reads and writes `CompanyContextSource` through its query
 *    module, scoped by the owner's organization, and never touches a
 *    `ProjectContext` query, the project RAG settings, the Job Hub or the
 *    import-as-document path;
 *  - its chunks go to the company collection with the company payload — the
 *    source as `originalContextId`, the row as `contextId`, its type and the
 *    identity of the model the embedding call reports having used, never a
 *    project — after the source's earlier points are removed, and the source
 *    is marked embedded with that model;
 *  - the embedding provider is checked through the organization's own model
 *    resolution, never the default-provider key an acting member's personal
 *    provider can answer;
 *  - a failure from the moment the earlier points are deleted also clears the
 *    source's index markers, and a delete that itself failed does not;
 *  - an embedding model whose vectors do not fit the collection fails the
 *    source with nothing written;
 *  - a company delete removes the vectors, then the stored file, then the
 *    row, and keeps the row when an earlier step fails; it then sweeps the
 *    vectors once more for what an embed in flight wrote meanwhile. A
 *    website source first loses its refresh schedule and its recorded crawl,
 *    best-effort;
 *  - an input without an owner still takes the project path, with the same
 *    queries as before (the existing suites pin that path in depth).
 *
 * `@repo/rag` is mocked here; its own tests pin what the company store and
 * `embedCompanyContext` send to Qdrant and which settings they read.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run src/activities/__tests__/company-context-ingestion.test.ts
 */

import { ApplicationFailure } from "@temporalio/common";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ORG = "org-1";
const USER = "user-1";
const SOURCE = "src-1";
const COMPANY = { kind: "company", organizationId: ORG } as const;
const MODEL = "OPENAI_DIRECT:text-embedding-3-small";

const mocks = vi.hoisted(() => {
	class AIProviderNotConfiguredError extends Error {}
	return {
		AIProviderNotConfiguredError,
		// Project queries: a company run must never reach any of them.
		projectContextFindFirst: vi.fn(),
		projectContextFindUnique: vi.fn(),
		projectContextUpdate: vi.fn(),
		projectContextUpdateMany: vi.fn(),
		updateContextExtractionStatus: vi.fn(),
		markContextAsEmbedded: vi.fn(),
		recordContextIndexingFailure: vi.fn(),
		getContextById: vi.fn(),
		deleteUnmanagedContextRow: vi.fn(),
		getProjectRagSettings: vi.fn(),
		// Company queries.
		getCompanyContextSource: vi.fn(),
		updateCompanyContextSourceStatus: vi.fn(),
		markCompanyContextSourceEmbedded: vi.fn(),
		recordCompanyContextSourceIndexingFailure: vi.fn(),
		clearCompanyContextSourceEmbedding: vi.fn(),
		deleteCompanyContextSource: vi.fn(),
		// AI and storage.
		getSystemEmbeddingRAGProviderConfig: vi.fn(),
		downloadFile: vi.fn(),
		deleteFile: vi.fn(),
		// RAG.
		extract: vi.fn(),
		chunkProjectContent: vi.fn(),
		generateEmbeddings: vi.fn(),
		storeProjectContext: vi.fn(),
		deleteProjectContext: vi.fn(),
		deleteUrlSourceChunks: vi.fn(),
		embedProjectContext: vi.fn(),
		embedCompanyContext: vi.fn(),
		getCompanyChunkSettings: vi.fn(),
		resolveCompanyEmbeddingModel: vi.fn(),
		storeCompanyContextPoints: vi.fn(),
		deleteCompanyContextRowPoints: vi.fn(),
		deleteCompanyContextSourcePoints: vi.fn(),
		// Job Hub.
		jobEnsure: vi.fn(),
		jobStep: vi.fn(),
		jobComplete: vi.fn(),
		jobFail: vi.fn(),
		// Temporal: a website source's schedule and crawl.
		getScheduleClient: vi.fn(),
		scheduleGetHandle: vi.fn(),
		scheduleDelete: vi.fn(),
		getTemporalClient: vi.fn(),
		workflowGetHandle: vi.fn(),
		workflowCancel: vi.fn(),
	};
});

vi.mock("@repo/database", () => ({
	db: {
		projectContext: {
			findFirst: mocks.projectContextFindFirst,
			findUnique: mocks.projectContextFindUnique,
			update: mocks.projectContextUpdate,
			updateMany: mocks.projectContextUpdateMany,
		},
	},
	updateContextExtractionStatus: mocks.updateContextExtractionStatus,
	markContextAsEmbedded: mocks.markContextAsEmbedded,
	recordContextIndexingFailure: mocks.recordContextIndexingFailure,
	getContextById: mocks.getContextById,
	deleteUnmanagedContextRow: mocks.deleteUnmanagedContextRow,
	getProjectRagSettings: mocks.getProjectRagSettings,
	getCompanyContextSource: mocks.getCompanyContextSource,
	updateCompanyContextSourceStatus: mocks.updateCompanyContextSourceStatus,
	markCompanyContextSourceEmbedded: mocks.markCompanyContextSourceEmbedded,
	recordCompanyContextSourceIndexingFailure:
		mocks.recordCompanyContextSourceIndexingFailure,
	clearCompanyContextSourceEmbedding:
		mocks.clearCompanyContextSourceEmbedding,
	deleteCompanyContextSource: mocks.deleteCompanyContextSource,
	// The prefix's exact shape is pinned by the database package's own test.
	companyContextStoragePrefix: (organizationId: string) =>
		`${organizationId}/company-context/`,
}));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: mocks.AIProviderNotConfiguredError,
	getSystemEmbeddingRAGProviderConfig:
		mocks.getSystemEmbeddingRAGProviderConfig,
}));

vi.mock("@repo/rag", () => ({
	COMPANY_EMBEDDING_RESOLUTION: { organizationOnly: true },
	companyEmbeddingIdentity: (model: {
		provider: string;
		modelString: string;
	}) => `${model.provider}:${model.modelString}`,
	extractionFactory: { extract: mocks.extract },
	chunkProjectContent: mocks.chunkProjectContent,
	generateEmbeddings: mocks.generateEmbeddings,
	storeProjectContext: mocks.storeProjectContext,
	deleteProjectContext: mocks.deleteProjectContext,
	deleteUrlSourceChunks: mocks.deleteUrlSourceChunks,
	embedProjectContext: mocks.embedProjectContext,
	embedCompanyContext: mocks.embedCompanyContext,
	getCompanyChunkSettings: mocks.getCompanyChunkSettings,
	resolveCompanyEmbeddingModel: mocks.resolveCompanyEmbeddingModel,
	unsupportedEmbeddingModelMessage: (model: { identity: string }) =>
		`Unsupported embedding model: ${model.identity}`,
	storeCompanyContextPoints: mocks.storeCompanyContextPoints,
	deleteCompanyContextRowPoints: mocks.deleteCompanyContextRowPoints,
	deleteCompanyContextSourcePoints: mocks.deleteCompanyContextSourcePoints,
}));

vi.mock("@repo/storage", () => ({
	downloadFile: mocks.downloadFile,
	deleteFile: mocks.deleteFile,
}));

vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
}));

vi.mock("../lib/job-progress", () => ({
	JOB_SOURCE: { projectContext: "projectContext" },
	JOB_STEPS: {
		contextProcessing: ["download", "extract", "chunk", "embed", "store"],
	},
	seedJobSteps: (keys: string[]) =>
		keys.map((key) => ({ key, status: "pending" })),
	jobEnsure: mocks.jobEnsure,
	jobStep: mocks.jobStep,
	jobComplete: mocks.jobComplete,
	jobFail: mocks.jobFail,
}));

vi.mock("../lib/activity-logger", () => ({
	activityLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../client", () => ({
	getTemporalClient: mocks.getTemporalClient,
	getScheduleClient: mocks.getScheduleClient,
}));

import { deleteSingleContextActivity } from "../context-deletion";
import { embedSingleContextActivity } from "../context-embedding";
import {
	getProjectContextStatus,
	processProjectContext,
	retryProjectContext,
	updateProjectContextStatus,
} from "../project-context-processing";

const PROJECT_ONLY = [
	"projectContextFindFirst",
	"projectContextFindUnique",
	"projectContextUpdate",
	"projectContextUpdateMany",
	"updateContextExtractionStatus",
	"markContextAsEmbedded",
	"recordContextIndexingFailure",
	"getContextById",
	"deleteUnmanagedContextRow",
	"getProjectRagSettings",
	"storeProjectContext",
	"deleteProjectContext",
	"deleteUrlSourceChunks",
	"embedProjectContext",
	"jobEnsure",
	"jobStep",
	"jobComplete",
	"jobFail",
] as const;

/** No project query, project vector write or Job Hub call was made. */
function expectNoProjectCalls(): void {
	for (const name of PROJECT_ONLY) {
		expect(mocks[name], name).not.toHaveBeenCalled();
	}
}

function fileSource(overrides: Record<string, unknown> = {}) {
	return {
		id: SOURCE,
		organizationId: ORG,
		type: "FILE",
		content: "",
		contentHash: null,
		metadata: {
			// Must be ignored: a company source is never imported as a document.
			documentTag: "PRD",
		},
		s3Path: `${ORG}/company-context/${SOURCE}/capabilities.pdf`,
		s3Bucket: "project-contexts",
		originalFilename: "capabilities.pdf",
		mimeType: "application/pdf",
		sourceUrl: null,
		sourceTitle: null,
		extractionStatus: "PENDING",
		qdrantId: null,
		...overrides,
	};
}

function textSource(overrides: Record<string, unknown> = {}) {
	return {
		...fileSource(),
		type: "TEXT",
		content: "We build and run data platforms for example-org customers.",
		s3Path: null,
		s3Bucket: null,
		originalFilename: null,
		metadata: {},
		sourceTitle: "About us",
		...overrides,
	};
}

function linkSource(overrides: Record<string, unknown> = {}) {
	return {
		...fileSource(),
		type: "LINK",
		s3Path: null,
		s3Bucket: null,
		originalFilename: null,
		mimeType: null,
		metadata: {},
		sourceUrl: "https://example.com/docs",
		urlRefreshMode: "WEEKLY",
		urlScheduleId: null,
		urlActiveWorkflowId: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getCompanyContextSource.mockResolvedValue(fileSource());
	mocks.updateCompanyContextSourceStatus.mockResolvedValue(true);
	mocks.markCompanyContextSourceEmbedded.mockResolvedValue(true);
	mocks.recordCompanyContextSourceIndexingFailure.mockResolvedValue(true);
	mocks.clearCompanyContextSourceEmbedding.mockResolvedValue(true);
	mocks.deleteCompanyContextSource.mockResolvedValue({
		id: SOURCE,
		urlPageIds: [],
	});
	mocks.getSystemEmbeddingRAGProviderConfig.mockResolvedValue({
		apiKey: "test-key",
		provider: "OPENAI_DIRECT",
		baseUrl: null,
	});
	mocks.downloadFile.mockResolvedValue({ data: Buffer.from("pdf bytes") });
	mocks.deleteFile.mockResolvedValue(undefined);
	mocks.extract.mockResolvedValue({
		text: "Capabilities overview. Delivery model.",
		extractorUsed: "local-pdf",
	});
	mocks.getCompanyChunkSettings.mockResolvedValue({
		chunkSize: 2048,
		chunkOverlap: 200,
		splitMethod: null,
		strategy: undefined,
	});
	mocks.chunkProjectContent.mockResolvedValue({
		route: { kind: "text", strategy: "RECURSIVE" },
		chunks: [
			{ content: "Capabilities overview.", index: 0, metadata: {} },
			{ content: "Delivery model.", index: 1, metadata: {} },
		],
		chunkPayloads: [{}, {}],
	});
	mocks.generateEmbeddings.mockResolvedValue({
		embeddings: [
			[0.1, 0.2],
			[0.3, 0.4],
		],
		provider: "OPENAI_DIRECT",
		modelString: "text-embedding-3-small",
	});
	mocks.resolveCompanyEmbeddingModel.mockResolvedValue({
		identity: MODEL,
		dimensions: 1536,
		supported: true,
	});
	mocks.storeCompanyContextPoints.mockResolvedValue(["point-0", "point-1"]);
	mocks.deleteCompanyContextRowPoints.mockResolvedValue({
		collectionExists: true,
	});
	mocks.deleteCompanyContextSourcePoints.mockResolvedValue({
		collectionExists: true,
	});
	mocks.embedCompanyContext.mockResolvedValue({
		success: true,
		qdrantId: "point-0",
		chunksCreated: 1,
		embeddingModel: MODEL,
	});
	mocks.scheduleDelete.mockResolvedValue(undefined);
	mocks.scheduleGetHandle.mockReturnValue({ delete: mocks.scheduleDelete });
	mocks.getScheduleClient.mockResolvedValue({
		getHandle: mocks.scheduleGetHandle,
	});
	mocks.workflowCancel.mockResolvedValue(undefined);
	mocks.workflowGetHandle.mockReturnValue({ cancel: mocks.workflowCancel });
	mocks.getTemporalClient.mockResolvedValue({
		workflow: { getHandle: mocks.workflowGetHandle },
	});
});

describe("processProjectContext with a company owner", () => {
	it("processes a company file on the company row and writes its chunks to the company collection", async () => {
		const result = await processProjectContext(
			SOURCE,
			undefined,
			USER,
			ORG,
			"local-only",
			COMPANY,
		);

		expect(result).toMatchObject({
			success: true,
			chunkCount: 2,
			qdrantIds: ["point-0", "point-1"],
			embedded: true,
		});
		// The import-as-document branch is unreachable: no tag comes back.
		expect(result.documentTag).toBeUndefined();

		expect(mocks.getCompanyContextSource).toHaveBeenCalledWith(SOURCE, ORG);
		expect(mocks.downloadFile).toHaveBeenCalledWith(
			`${ORG}/company-context/${SOURCE}/capabilities.pdf`,
			{ bucket: "project-contexts" },
		);
		// PENDING → EXTRACTING → COMPLETED, on the company row.
		const statuses = mocks.updateCompanyContextSourceStatus.mock.calls;
		expect(statuses.map((call) => call[2])).toEqual([
			"EXTRACTING",
			"COMPLETED",
		]);
		expect(statuses[1]).toEqual([
			SOURCE,
			ORG,
			"COMPLETED",
			{
				content: "Capabilities overview. Delivery model.",
				extractionError: null,
			},
		]);

		// Tenant context carries no project, and resolves the organization's
		// model — the one the identity names — whoever is acting.
		expect(mocks.generateEmbeddings.mock.calls[0][1]).toEqual({
			userId: USER,
			organizationId: ORG,
			tags: ["company-context", "rag-embedding"],
			organizationOnly: true,
		});

		// The source's earlier points go before its new ones are written.
		expect(mocks.deleteCompanyContextRowPoints).toHaveBeenCalledWith({
			organizationId: ORG,
			contextIds: [SOURCE],
		});
		expect(
			mocks.deleteCompanyContextRowPoints.mock.invocationCallOrder[0],
		).toBeLessThan(
			mocks.storeCompanyContextPoints.mock.invocationCallOrder[0],
		);
		const points = mocks.storeCompanyContextPoints.mock.calls[0][0];
		expect(points).toHaveLength(2);
		expect(points[1]).toMatchObject({
			organizationId: ORG,
			sourceId: SOURCE,
			contextId: SOURCE,
			contextType: "FILE",
			embeddingModel: MODEL,
			content: "Delivery model.",
			chunkIndex: 1,
			embedding: [0.3, 0.4],
			sourceTitle: "capabilities.pdf",
		});
		for (const point of points) {
			expect(point).not.toHaveProperty("projectId");
		}

		// Marked embedded with the model its points carry.
		expect(mocks.markCompanyContextSourceEmbedded).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			{ embeddingModel: MODEL, qdrantId: "point-0" },
		);
		expect(mocks.resolveCompanyEmbeddingModel).toHaveBeenCalledWith({
			organizationId: ORG,
			userId: USER,
		});
		// The provider is the organization's embedding one, never the
		// default-provider key a member's personal provider can answer.
		expect(
			mocks.getSystemEmbeddingRAGProviderConfig,
		).not.toHaveBeenCalled();
		expectNoProjectCalls();
	});

	it("indexes for an organization whose only provider is a dedicated embedding one", async () => {
		// No default provider to answer the project path's key lookup.
		mocks.getSystemEmbeddingRAGProviderConfig.mockRejectedValue(
			new Error("No AI provider configured"),
		);

		const result = await processProjectContext(
			SOURCE,
			undefined,
			USER,
			ORG,
			"local-only",
			COMPANY,
		);

		expect(result).toMatchObject({ success: true, embedded: true });
		expect(mocks.markCompanyContextSourceEmbedded).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			{ embeddingModel: MODEL, qdrantId: "point-0" },
		);
		expect(
			mocks.recordCompanyContextSourceIndexingFailure,
		).not.toHaveBeenCalled();
	});

	it("stamps the model the embedding call reports, not the one resolved before it", async () => {
		// The organization switched models between the check and the embed.
		mocks.generateEmbeddings.mockResolvedValue({
			embeddings: [
				[0.1, 0.2],
				[0.3, 0.4],
			],
			provider: "OPENAI_COMPATIBLE",
			modelString: "embed-1536",
		});

		await processProjectContext(
			SOURCE,
			undefined,
			USER,
			ORG,
			"local-only",
			COMPANY,
		);

		for (const point of mocks.storeCompanyContextPoints.mock.calls[0][0]) {
			expect(point.embeddingModel).toBe("OPENAI_COMPATIBLE:embed-1536");
		}
		expect(mocks.markCompanyContextSourceEmbedded).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			{
				embeddingModel: "OPENAI_COMPATIBLE:embed-1536",
				qdrantId: "point-0",
			},
		);
	});

	it("chunks with the organization's settings, falling back to this pipeline's defaults", async () => {
		mocks.getCompanyChunkSettings.mockResolvedValue({
			chunkSize: 1200,
			chunkOverlap: 150,
			splitMethod: "SENTENCE",
			strategy: "SENTENCE",
		});

		await processProjectContext(
			SOURCE,
			undefined,
			USER,
			ORG,
			"local-only",
			COMPANY,
		);

		expect(mocks.getCompanyChunkSettings).toHaveBeenCalledWith(ORG, {
			chunkSize: 2048,
			chunkOverlap: 200,
			splitMethod: null,
		});
		expect(mocks.chunkProjectContent).toHaveBeenCalledWith(
			expect.objectContaining({
				chunkSize: 1200,
				chunkOverlap: 150,
				textStrategy: "SENTENCE",
			}),
		);
		expect(mocks.getProjectRagSettings).not.toHaveBeenCalled();
	});

	it("uses the pipeline defaults when the organization has no settings", async () => {
		await processProjectContext(
			SOURCE,
			undefined,
			USER,
			ORG,
			"local-only",
			COMPANY,
		);

		const call = mocks.chunkProjectContent.mock.calls[0][0];
		expect(call).toMatchObject({ chunkSize: 2048, chunkOverlap: 200 });
		// No split method set: the content decides, as for a project file.
		expect(call).not.toHaveProperty("textStrategy");
	});

	it("fails the source under an embedding model the collection cannot hold, writing nothing to Qdrant", async () => {
		mocks.resolveCompanyEmbeddingModel.mockResolvedValue({
			identity: "OPENAI_DIRECT:text-embedding-3-large",
			dimensions: 3072,
			supported: false,
		});

		const result = await processProjectContext(
			SOURCE,
			undefined,
			USER,
			ORG,
			"local-only",
			COMPANY,
		);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/^Unsupported embedding model/);
		expect(mocks.updateCompanyContextSourceStatus).toHaveBeenLastCalledWith(
			SOURCE,
			ORG,
			"FAILED",
			{
				extractionError:
					"Unsupported embedding model: OPENAI_DIRECT:text-embedding-3-large",
			},
		);
		expect(mocks.chunkProjectContent).not.toHaveBeenCalled();
		expect(mocks.generateEmbeddings).not.toHaveBeenCalled();
		expect(mocks.deleteCompanyContextRowPoints).not.toHaveBeenCalled();
		expect(mocks.storeCompanyContextPoints).not.toHaveBeenCalled();
		expect(mocks.markCompanyContextSourceEmbedded).not.toHaveBeenCalled();
	});

	it("fails non-retryably for a company owner without an organization, touching nothing", async () => {
		const run = processProjectContext(
			SOURCE,
			undefined,
			USER,
			undefined,
			"local-only",
			{ kind: "company" } as never,
		);

		await expect(run).rejects.toBeInstanceOf(ApplicationFailure);
		await run.catch((error: ApplicationFailure) => {
			expect(error.nonRetryable).toBe(true);
		});
		expect(mocks.getCompanyContextSource).not.toHaveBeenCalled();
		expect(mocks.updateCompanyContextSourceStatus).not.toHaveBeenCalled();
		expectNoProjectCalls();
	});

	it("fails non-retryably when the source is gone", async () => {
		mocks.getCompanyContextSource.mockResolvedValue(null);

		const run = processProjectContext(
			SOURCE,
			undefined,
			USER,
			ORG,
			"local-only",
			COMPANY,
		);

		await expect(run).rejects.toMatchObject({
			nonRetryable: true,
			type: "COMPANY_CONTEXT_SOURCE_NOT_FOUND",
		});
		expect(mocks.downloadFile).not.toHaveBeenCalled();
	});

	it("refuses to read a file outside the organization's company-context prefix", async () => {
		mocks.getCompanyContextSource.mockResolvedValue(
			fileSource({ s3Path: "org-2/company-context/other.pdf" }),
		);

		await expect(
			processProjectContext(
				SOURCE,
				undefined,
				USER,
				ORG,
				"local-only",
				COMPANY,
			),
		).rejects.toMatchObject({
			nonRetryable: true,
			type: "COMPANY_CONTEXT_STORAGE_MISMATCH",
		});
		expect(mocks.downloadFile).not.toHaveBeenCalled();
	});

	it("records an indexing failure on the source, keeping its extraction, when the store fails", async () => {
		mocks.storeCompanyContextPoints.mockRejectedValue(
			new Error("qdrant unavailable"),
		);

		const result = await processProjectContext(
			SOURCE,
			undefined,
			USER,
			ORG,
			"local-only",
			COMPANY,
		);

		expect(result).toMatchObject({ success: true, embedded: false });
		expect(
			mocks.recordCompanyContextSourceIndexingFailure,
		).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			"Search indexing failed: qdrant unavailable",
			// Its earlier points were removed, so its index markers go too.
			{ pointsRemoved: true },
		);
		// Never flipped to FAILED after the content was persisted.
		expect(
			mocks.updateCompanyContextSourceStatus.mock.calls.map(
				(call) => call[2],
			),
		).toEqual(["EXTRACTING", "COMPLETED"]);
		expect(mocks.markCompanyContextSourceEmbedded).not.toHaveBeenCalled();
	});

	it("keeps the index markers when removing the earlier points itself fails", async () => {
		mocks.deleteCompanyContextRowPoints.mockRejectedValue(
			new Error("qdrant unavailable"),
		);

		const result = await processProjectContext(
			SOURCE,
			undefined,
			USER,
			ORG,
			"local-only",
			COMPANY,
		);

		expect(result).toMatchObject({ success: true, embedded: false });
		// Nothing was removed, so the source still has what it had.
		expect(
			mocks.recordCompanyContextSourceIndexingFailure,
		).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			"Search indexing failed: qdrant unavailable",
			undefined,
		);
		expect(mocks.storeCompanyContextPoints).not.toHaveBeenCalled();
	});

	it("removes the points it wrote when the source was deleted while it was embedded", async () => {
		mocks.markCompanyContextSourceEmbedded.mockResolvedValue(false);

		const result = await processProjectContext(
			SOURCE,
			undefined,
			USER,
			ORG,
			"local-only",
			COMPANY,
		);

		expect(result).toMatchObject({ success: true, embedded: false });
		expect(mocks.deleteCompanyContextSourcePoints).toHaveBeenCalledWith({
			organizationId: ORG,
			sourceId: SOURCE,
		});
	});

	// A delete tombstones the source mid-run: the query layer then refuses the
	// COMPLETED status and the embedded mark, as it would for a missing row.
	it("removes the points it wrote when a delete started while it ran, whose writes to the source are refused", async () => {
		mocks.updateCompanyContextSourceStatus.mockImplementation(
			async (_id: string, _org: string, status: string) =>
				status !== "COMPLETED",
		);
		mocks.markCompanyContextSourceEmbedded.mockResolvedValue(false);

		const result = await processProjectContext(
			SOURCE,
			undefined,
			USER,
			ORG,
			"local-only",
			COMPANY,
		);

		expect(result).toMatchObject({ success: true, embedded: false });
		expect(mocks.storeCompanyContextPoints).toHaveBeenCalled();
		expect(mocks.deleteCompanyContextSourcePoints).toHaveBeenCalledWith({
			organizationId: ORG,
			sourceId: SOURCE,
		});
		expect(
			mocks.recordCompanyContextSourceIndexingFailure,
		).not.toHaveBeenCalled();
	});

	it("records why a source is not searchable when the organization has no embedding provider", async () => {
		mocks.resolveCompanyEmbeddingModel.mockRejectedValue(
			new mocks.AIProviderNotConfiguredError("No embedding provider"),
		);

		const result = await processProjectContext(
			SOURCE,
			undefined,
			USER,
			ORG,
			"local-only",
			COMPANY,
		);

		expect(result).toMatchObject({ success: true, chunkCount: 0 });
		expect(
			mocks.recordCompanyContextSourceIndexingFailure,
		).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			expect.stringMatching(/^AI provider not configured/),
			undefined,
		);
		expect(mocks.storeCompanyContextPoints).not.toHaveBeenCalled();
	});
});

describe("processProjectContext without an owner", () => {
	it("still takes the project path, with the queries it always made", async () => {
		mocks.projectContextFindFirst.mockResolvedValue({
			...fileSource({ s3Path: "projects/proj-1/spec.pdf" }),
			projectId: "proj-1",
			metadata: null,
		});
		mocks.storeProjectContext.mockResolvedValue("project-point");

		const result = await processProjectContext(SOURCE, "proj-1", USER, ORG);

		expect(result.success).toBe(true);
		expect(mocks.projectContextFindFirst).toHaveBeenCalledWith({
			where: { id: SOURCE, projectId: "proj-1", organizationId: ORG },
		});
		expect(mocks.jobEnsure).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "proj-1" }),
		);
		expect(mocks.updateContextExtractionStatus).toHaveBeenCalledWith(
			SOURCE,
			"COMPLETED",
			{ content: "Capabilities overview. Delivery model." },
		);
		expect(mocks.chunkProjectContent).toHaveBeenCalledWith({
			content: "Capabilities overview. Delivery model.",
			mimeType: "application/pdf",
			filename: "capabilities.pdf",
			chunkingThreshold: 2048,
			chunkSize: 2048,
			chunkOverlap: 200,
		});
		expect(mocks.storeProjectContext).toHaveBeenCalledTimes(2);
		// The project path keeps the acting user's embedding resolution.
		expect(mocks.generateEmbeddings.mock.calls[0][1]).toEqual({
			userId: USER,
			organizationId: ORG,
			projectId: "proj-1",
			tags: ["project-context", "rag-embedding"],
		});
		expect(mocks.generateEmbeddings.mock.calls[0][1]).not.toHaveProperty(
			"organizationOnly",
		);
		expect(mocks.markContextAsEmbedded).toHaveBeenCalledWith(
			SOURCE,
			"project-point",
		);
		for (const name of [
			"getCompanyContextSource",
			"updateCompanyContextSourceStatus",
			"getCompanyChunkSettings",
			"resolveCompanyEmbeddingModel",
			"storeCompanyContextPoints",
			"deleteCompanyContextRowPoints",
			"markCompanyContextSourceEmbedded",
		] as const) {
			expect(mocks[name], name).not.toHaveBeenCalled();
		}
	});
});

describe("status activities with a company owner", () => {
	it("records a status on the company row, with no Job Hub failure", async () => {
		await updateProjectContextStatus(
			SOURCE,
			"FAILED",
			"Could not read the file",
			COMPANY,
		);

		expect(mocks.updateCompanyContextSourceStatus).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			"FAILED",
			{ extractionError: "Could not read the file" },
		);
		expectNoProjectCalls();
	});

	it("does not throw when the source is already gone", async () => {
		mocks.updateCompanyContextSourceStatus.mockResolvedValue(false);

		await expect(
			updateProjectContextStatus(SOURCE, "FAILED", "gone", COMPANY),
		).resolves.toBeUndefined();
	});

	it("reads the status from the company row", async () => {
		mocks.getCompanyContextSource.mockResolvedValue(
			fileSource({ extractionStatus: "COMPLETED" }),
		);

		await expect(getProjectContextStatus(SOURCE, COMPANY)).resolves.toBe(
			"COMPLETED",
		);
		expect(mocks.getCompanyContextSource).toHaveBeenCalledWith(SOURCE, ORG);
		expectNoProjectCalls();
	});
});

describe("retryProjectContext with a company owner", () => {
	it("forgets the index, removes the points, resets the row and processes it again", async () => {
		const result = await retryProjectContext(
			SOURCE,
			undefined,
			USER,
			ORG,
			"local-only",
			COMPANY,
		);

		expect(result.success).toBe(true);
		expect(mocks.clearCompanyContextSourceEmbedding).toHaveBeenCalledWith(
			SOURCE,
			ORG,
		);
		expect(mocks.updateCompanyContextSourceStatus.mock.calls[0]).toEqual([
			SOURCE,
			ORG,
			"PENDING",
			{ content: "", extractionError: null },
		]);
		const [clear] =
			mocks.clearCompanyContextSourceEmbedding.mock.invocationCallOrder;
		const [firstPointDelete] =
			mocks.deleteCompanyContextRowPoints.mock.invocationCallOrder;
		const [reset] =
			mocks.updateCompanyContextSourceStatus.mock.invocationCallOrder;
		expect(clear).toBeLessThan(firstPointDelete);
		expect(firstPointDelete).toBeLessThan(reset);
		expect(mocks.storeCompanyContextPoints).toHaveBeenCalledTimes(1);
		expectNoProjectCalls();
	});
});

describe("embedSingleContextActivity with a company owner", () => {
	beforeEach(() => {
		mocks.getCompanyContextSource.mockResolvedValue(textSource());
	});

	it("embeds a company text into the company collection and marks the row embedded with its model", async () => {
		const result = await embedSingleContextActivity({
			contextId: SOURCE,
			userId: USER,
			organizationId: ORG,
			type: "TEXT",
			owner: COMPANY,
		});

		expect(result).toEqual({ success: true, qdrantId: "point-0" });
		expect(mocks.deleteCompanyContextRowPoints).toHaveBeenCalledWith({
			organizationId: ORG,
			contextIds: [SOURCE],
		});
		expect(
			mocks.deleteCompanyContextRowPoints.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.embedCompanyContext.mock.invocationCallOrder[0]);

		const options = mocks.embedCompanyContext.mock.calls[0][0];
		expect(options).toMatchObject({
			contextId: SOURCE,
			userId: USER,
			content:
				"We build and run data platforms for example-org customers.",
			type: "TEXT",
			company: {
				organizationId: ORG,
				sourceId: SOURCE,
				contextType: "TEXT",
			},
		});
		expect(options.metadata.sourceTitle).toBe("About us");
		expect(options).not.toHaveProperty("projectId");
		// No key: the embed resolves the organization's own provider.
		expect(options).not.toHaveProperty("apiKey");
		expect(
			mocks.getSystemEmbeddingRAGProviderConfig,
		).not.toHaveBeenCalled();

		expect(mocks.markCompanyContextSourceEmbedded).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			{ embeddingModel: MODEL, qdrantId: "point-0" },
		);
		expect(mocks.updateCompanyContextSourceStatus).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			"COMPLETED",
			{ extractionError: null },
		);
		expectNoProjectCalls();
	});

	it("fails the source under an embedding model the collection cannot hold, writing nothing", async () => {
		mocks.resolveCompanyEmbeddingModel.mockResolvedValue({
			identity: "OPENAI_DIRECT:text-embedding-3-large",
			dimensions: 3072,
			supported: false,
		});

		const result = await embedSingleContextActivity({
			contextId: SOURCE,
			userId: USER,
			type: "TEXT",
			owner: COMPANY,
		});

		expect(result.success).toBe(false);
		expect(mocks.updateCompanyContextSourceStatus).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			"FAILED",
			{
				extractionError:
					"Unsupported embedding model: OPENAI_DIRECT:text-embedding-3-large",
			},
		);
		expect(mocks.deleteCompanyContextRowPoints).not.toHaveBeenCalled();
		expect(mocks.embedCompanyContext).not.toHaveBeenCalled();
		expect(mocks.markCompanyContextSourceEmbedded).not.toHaveBeenCalled();
	});

	it("marks the source with the model the embed reports having used", async () => {
		mocks.embedCompanyContext.mockResolvedValue({
			success: true,
			qdrantId: "point-0",
			chunksCreated: 1,
			embeddingModel: "OPENAI_COMPATIBLE:embed-1536",
		});

		await embedSingleContextActivity({
			contextId: SOURCE,
			userId: USER,
			type: "TEXT",
			owner: COMPANY,
		});

		expect(mocks.markCompanyContextSourceEmbedded).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			{
				embeddingModel: "OPENAI_COMPATIBLE:embed-1536",
				qdrantId: "point-0",
			},
		);
	});

	it("embeds for an organization whose only provider is a dedicated embedding one", async () => {
		mocks.getSystemEmbeddingRAGProviderConfig.mockRejectedValue(
			new mocks.AIProviderNotConfiguredError("No AI provider configured"),
		);

		const result = await embedSingleContextActivity({
			contextId: SOURCE,
			userId: USER,
			type: "TEXT",
			owner: COMPANY,
		});

		expect(result).toEqual({ success: true, qdrantId: "point-0" });
		expect(mocks.markCompanyContextSourceEmbedded).toHaveBeenCalled();
		expect(
			mocks.recordCompanyContextSourceIndexingFailure,
		).not.toHaveBeenCalled();
	});

	it("keeps the index markers when removing the earlier points itself fails, and rethrows", async () => {
		mocks.deleteCompanyContextRowPoints.mockRejectedValue(
			new Error("qdrant unavailable"),
		);

		await expect(
			embedSingleContextActivity({
				contextId: SOURCE,
				userId: USER,
				type: "TEXT",
				owner: COMPANY,
			}),
		).rejects.toThrow("qdrant unavailable");
		expect(
			mocks.recordCompanyContextSourceIndexingFailure,
		).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			"Search indexing failed: qdrant unavailable",
			undefined,
		);
		expect(mocks.embedCompanyContext).not.toHaveBeenCalled();
	});

	it("records the failure with its points removed and rethrows for Temporal to retry", async () => {
		mocks.embedCompanyContext.mockResolvedValue({
			success: false,
			error: "Failed to embed 1/3 chunks: rate limited",
		});

		await expect(
			embedSingleContextActivity({
				contextId: SOURCE,
				userId: USER,
				type: "TEXT",
				owner: COMPANY,
			}),
		).rejects.toThrow("rate limited");
		expect(
			mocks.recordCompanyContextSourceIndexingFailure,
		).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			"Search indexing failed: Failed to embed 1/3 chunks: rate limited",
			{ pointsRemoved: true },
		);
		expect(mocks.markCompanyContextSourceEmbedded).not.toHaveBeenCalled();
	});

	it("removes the points it wrote when the source was deleted while it was embedded", async () => {
		mocks.markCompanyContextSourceEmbedded.mockResolvedValue(false);

		const result = await embedSingleContextActivity({
			contextId: SOURCE,
			userId: USER,
			type: "TEXT",
			owner: COMPANY,
		});

		expect(result).toEqual({ success: true });
		// Once before the embed, once for the orphans.
		expect(mocks.deleteCompanyContextRowPoints).toHaveBeenCalledTimes(2);
		expect(mocks.updateCompanyContextSourceStatus).not.toHaveBeenCalled();
	});

	it("records a missing provider on the source without retrying", async () => {
		mocks.resolveCompanyEmbeddingModel.mockRejectedValue(
			new mocks.AIProviderNotConfiguredError("No embedding provider"),
		);

		await expect(
			embedSingleContextActivity({
				contextId: SOURCE,
				userId: USER,
				type: "TEXT",
				owner: COMPANY,
			}),
		).resolves.toEqual({ success: true });
		expect(
			mocks.recordCompanyContextSourceIndexingFailure,
		).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			expect.stringMatching(/^AI provider not configured/),
			undefined,
		);
		expect(mocks.embedCompanyContext).not.toHaveBeenCalled();
	});

	it("removes the points and index markers of a source whose text is now empty, and records why", async () => {
		// A single page re-synced to a page that renders as no text.
		mocks.getCompanyContextSource.mockResolvedValue(
			linkSource({
				content: "",
				extractionStatus: "COMPLETED",
				qdrantId: "point-old",
			}),
		);

		await expect(
			embedSingleContextActivity({
				contextId: SOURCE,
				userId: USER,
				type: "LINK",
				content: "   ",
				owner: COMPANY,
			}),
		).resolves.toEqual({ success: true });

		expect(mocks.deleteCompanyContextRowPoints).toHaveBeenCalledWith({
			organizationId: ORG,
			contextIds: [SOURCE],
		});
		expect(mocks.clearCompanyContextSourceEmbedding).toHaveBeenCalledWith(
			SOURCE,
			ORG,
		);
		expect(
			mocks.recordCompanyContextSourceIndexingFailure,
		).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			expect.stringMatching(/no text to index/),
			undefined,
		);
		// The markers go only once the points are gone.
		expect(
			mocks.deleteCompanyContextRowPoints.mock.invocationCallOrder[0],
		).toBeLessThan(
			mocks.clearCompanyContextSourceEmbedding.mock
				.invocationCallOrder[0],
		);
		expect(mocks.embedCompanyContext).not.toHaveBeenCalled();
		expect(mocks.markCompanyContextSourceEmbedded).not.toHaveBeenCalled();
		expectNoProjectCalls();
	});

	it("keeps the index markers of an empty source when its earlier points cannot be removed, and rethrows", async () => {
		mocks.getCompanyContextSource.mockResolvedValue(
			textSource({ content: "", extractionStatus: "COMPLETED" }),
		);
		mocks.deleteCompanyContextRowPoints.mockRejectedValue(
			new Error("qdrant unavailable"),
		);

		await expect(
			embedSingleContextActivity({
				contextId: SOURCE,
				userId: USER,
				type: "TEXT",
				owner: COMPANY,
			}),
		).rejects.toThrow("qdrant unavailable");
		expect(mocks.clearCompanyContextSourceEmbedding).not.toHaveBeenCalled();
		expect(
			mocks.recordCompanyContextSourceIndexingFailure,
		).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			"Search indexing failed: qdrant unavailable",
			undefined,
		);
	});

	it("does nothing for a source that is gone, beyond removing stray points", async () => {
		mocks.getCompanyContextSource.mockResolvedValue(null);

		await expect(
			embedSingleContextActivity({
				contextId: SOURCE,
				userId: USER,
				type: "TEXT",
				owner: COMPANY,
			}),
		).resolves.toEqual({ success: true });
		expect(mocks.deleteCompanyContextRowPoints).toHaveBeenCalledTimes(1);
		expect(mocks.embedCompanyContext).not.toHaveBeenCalled();
		expect(mocks.resolveCompanyEmbeddingModel).not.toHaveBeenCalled();
	});
});

describe("deleteSingleContextActivity with a company owner", () => {
	it("removes the vectors, then the stored file, then the row", async () => {
		const result = await deleteSingleContextActivity({
			contextId: SOURCE,
			userId: USER,
			organizationId: ORG,
			owner: COMPANY,
		});

		expect(result).toEqual({
			success: true,
			qdrantDeleted: true,
			dbDeleted: true,
		});
		// Every point of the source, by originalContextId — including those
		// an embed that stopped partway already wrote.
		expect(mocks.deleteCompanyContextSourcePoints).toHaveBeenCalledWith({
			organizationId: ORG,
			sourceId: SOURCE,
		});
		expect(mocks.deleteFile).toHaveBeenCalledWith(
			`${ORG}/company-context/${SOURCE}/capabilities.pdf`,
			{ bucket: "project-contexts" },
		);
		expect(mocks.deleteCompanyContextSource).toHaveBeenCalledWith(
			SOURCE,
			ORG,
		);
		const [vectors] =
			mocks.deleteCompanyContextSourcePoints.mock.invocationCallOrder;
		const [file] = mocks.deleteFile.mock.invocationCallOrder;
		const [row] = mocks.deleteCompanyContextSource.mock.invocationCallOrder;
		expect(vectors).toBeLessThan(file);
		expect(file).toBeLessThan(row);
		expectNoProjectCalls();
	});

	it("sweeps the source's points again once the row is gone, removing what an in-flight embed wrote meanwhile", async () => {
		// Simulates an embed that was running when the delete began: it
		// writes its points after the first removal and before the row goes.
		const stored = new Set<string>();
		mocks.deleteCompanyContextSourcePoints.mockImplementation(async () => {
			stored.clear();
			return { collectionExists: true };
		});
		mocks.deleteFile.mockImplementation(async () => {
			stored.add("late-point");
		});

		const result = await deleteSingleContextActivity({
			contextId: SOURCE,
			userId: USER,
			owner: COMPANY,
		});

		expect(result.dbDeleted).toBe(true);
		expect(stored.size).toBe(0);
		expect(mocks.deleteCompanyContextSourcePoints).toHaveBeenCalledTimes(2);
		expect(mocks.deleteCompanyContextSourcePoints).toHaveBeenLastCalledWith(
			{
				organizationId: ORG,
				sourceId: SOURCE,
			},
		);
		const [row] = mocks.deleteCompanyContextSource.mock.invocationCallOrder;
		const sweep =
			mocks.deleteCompanyContextSourcePoints.mock.invocationCallOrder[1];
		expect(row).toBeLessThan(sweep);
	});

	it("throws for a retry when the final sweep fails, and the retry sweeps a source whose row is gone", async () => {
		let sweeps = 0;
		mocks.deleteCompanyContextSourcePoints.mockImplementation(async () => {
			sweeps += 1;
			if (sweeps === 2) {
				throw new Error(
					"Failed to delete company context points: timeout",
				);
			}
			return { collectionExists: true };
		});

		await expect(
			deleteSingleContextActivity({
				contextId: SOURCE,
				userId: USER,
				owner: COMPANY,
			}),
		).rejects.toThrow("timeout");
		expect(mocks.deleteCompanyContextSource).toHaveBeenCalledTimes(1);

		mocks.getCompanyContextSource.mockResolvedValue(null);
		const retry = await deleteSingleContextActivity({
			contextId: SOURCE,
			userId: USER,
			owner: COMPANY,
		});
		expect(retry).toEqual({
			success: true,
			qdrantDeleted: true,
			dbDeleted: false,
		});
		expect(mocks.deleteCompanyContextSourcePoints).toHaveBeenCalledTimes(3);
	});

	it("reports no error when the organization's company collection does not exist yet", async () => {
		mocks.deleteCompanyContextSourcePoints.mockResolvedValue({
			collectionExists: false,
		});

		const result = await deleteSingleContextActivity({
			contextId: SOURCE,
			userId: USER,
			owner: COMPANY,
		});

		expect(result).toEqual({
			success: true,
			qdrantDeleted: false,
			dbDeleted: true,
		});
		expect(result.error).toBeUndefined();
	});

	it("keeps the row and the file when the vectors cannot be removed", async () => {
		mocks.deleteCompanyContextSourcePoints.mockRejectedValue(
			new Error("Failed to delete company context points: timeout"),
		);

		await expect(
			deleteSingleContextActivity({
				contextId: SOURCE,
				userId: USER,
				owner: COMPANY,
			}),
		).rejects.toThrow("timeout");
		expect(mocks.deleteFile).not.toHaveBeenCalled();
		expect(mocks.deleteCompanyContextSource).not.toHaveBeenCalled();
	});

	it("keeps the row when the file cannot be removed", async () => {
		mocks.deleteFile.mockRejectedValue(new Error("storage unavailable"));

		await expect(
			deleteSingleContextActivity({
				contextId: SOURCE,
				userId: USER,
				owner: COMPANY,
			}),
		).rejects.toThrow("storage unavailable");
		expect(mocks.deleteCompanyContextSource).not.toHaveBeenCalled();
	});

	it("still removes the points of a source whose row is already gone", async () => {
		mocks.getCompanyContextSource.mockResolvedValue(null);

		const result = await deleteSingleContextActivity({
			contextId: SOURCE,
			userId: USER,
			owner: COMPANY,
		});

		expect(result).toEqual({
			success: true,
			qdrantDeleted: true,
			dbDeleted: false,
		});
		expect(mocks.deleteCompanyContextSourcePoints).toHaveBeenCalledTimes(1);
		expect(mocks.deleteFile).not.toHaveBeenCalled();
		expect(mocks.deleteCompanyContextSource).not.toHaveBeenCalled();
	});

	it("stops a website source's refresh schedule and its recorded crawl before removing anything", async () => {
		mocks.getCompanyContextSource.mockResolvedValue(
			linkSource({
				urlScheduleId: `url-source-schedule-${SOURCE}`,
				urlActiveWorkflowId: `url-crawl-${SOURCE}-resync-1`,
			}),
		);

		const result = await deleteSingleContextActivity({
			contextId: SOURCE,
			userId: USER,
			owner: COMPANY,
		});

		expect(result).toEqual({
			success: true,
			qdrantDeleted: true,
			dbDeleted: true,
		});
		expect(mocks.scheduleGetHandle).toHaveBeenCalledWith(
			`url-source-schedule-${SOURCE}`,
		);
		expect(mocks.scheduleDelete).toHaveBeenCalledTimes(1);
		expect(mocks.workflowGetHandle).toHaveBeenCalledWith(
			`url-crawl-${SOURCE}-resync-1`,
		);
		expect(mocks.workflowCancel).toHaveBeenCalledTimes(1);
		const [schedule] = mocks.scheduleDelete.mock.invocationCallOrder;
		const [crawl] = mocks.workflowCancel.mock.invocationCallOrder;
		const [vectors] =
			mocks.deleteCompanyContextSourcePoints.mock.invocationCallOrder;
		expect(schedule).toBeLessThan(vectors);
		expect(crawl).toBeLessThan(vectors);
		expectNoProjectCalls();
	});

	it("still deletes a website source whose schedule or crawl is gone or cannot be stopped", async () => {
		mocks.getCompanyContextSource.mockResolvedValue(
			linkSource({
				urlScheduleId: `url-source-schedule-${SOURCE}`,
				urlActiveWorkflowId: `url-crawl-${SOURCE}-resync-1`,
			}),
		);
		mocks.scheduleDelete.mockRejectedValue(new Error("unavailable"));
		const finished = new Error("workflow execution already completed");
		finished.name = "WorkflowNotFoundError";
		mocks.workflowCancel.mockRejectedValue(finished);

		const result = await deleteSingleContextActivity({
			contextId: SOURCE,
			userId: USER,
			owner: COMPANY,
		});

		expect(result).toMatchObject({ success: true, dbDeleted: true });
		expect(mocks.deleteCompanyContextSource).toHaveBeenCalledWith(
			SOURCE,
			ORG,
		);
	});

	it("makes no Temporal call for a source with no schedule and no crawl", async () => {
		mocks.getCompanyContextSource.mockResolvedValue(linkSource());

		await deleteSingleContextActivity({
			contextId: SOURCE,
			userId: USER,
			owner: COMPANY,
		});

		expect(mocks.getScheduleClient).not.toHaveBeenCalled();
		expect(mocks.getTemporalClient).not.toHaveBeenCalled();
		expect(mocks.deleteCompanyContextSource).toHaveBeenCalled();
	});

	it("never deletes a stored file outside the organization's company-context prefix", async () => {
		mocks.getCompanyContextSource.mockResolvedValue(
			fileSource({ s3Path: "org-2/company-context/other.pdf" }),
		);

		const result = await deleteSingleContextActivity({
			contextId: SOURCE,
			userId: USER,
			owner: COMPANY,
		});

		expect(result.dbDeleted).toBe(true);
		expect(mocks.deleteFile).not.toHaveBeenCalled();
	});
});
