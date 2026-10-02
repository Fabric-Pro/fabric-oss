/**
 * Company context ingestion end to end in the Temporal test environment
 * (Fizzy #2719).
 *
 * The REAL file-processing, embedding and deletion workflows, bundled from the
 * workflows barrel, drive the REAL shared activities; only the database, RAG,
 * AI and storage modules underneath them are mocked. A company owner on the
 * input must:
 *
 *  - run on COMPANY_CONTEXT_TASK_QUEUE, where the worker registers the shared
 *    ingestion workflows and activities (these runs start there);
 *  - carry the owner into every activity the workflow schedules, so each
 *    one reads and writes the company row — never a project query, the
 *    project RAG settings or the Job Hub;
 *  - fail non-retryably, with nothing scheduled, when it names no
 *    organization;
 *  - replay deterministically against its own history (no production history
 *    carries a company owner yet).
 *
 * Offline note: `TestWorkflowEnvironment.createTimeSkipping()` downloads a
 * Temporal test-server binary on first use.
 *
 * Run with:
 *   pnpm --filter @repo/temporal exec vitest run src/workflows/__tests__/company-context-ingestion-workflows.test.ts
 */

import { resolve } from "node:path";
import { WorkflowFailedError } from "@temporalio/client";
import { defaultPayloadConverter } from "@temporalio/common";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

const ORG = "org-1";
const USER = "user-1";
const SOURCE = "src-1";
const MODEL = "OPENAI_DIRECT:text-embedding-3-small";

const mocks = vi.hoisted(() => {
	class AIProviderNotConfiguredError extends Error {}
	return {
		AIProviderNotConfiguredError,
		// Project queries and settings: a company run must reach none of them.
		projectContextFindFirst: vi.fn(),
		projectContextFindUnique: vi.fn(),
		projectContextUpdate: vi.fn(),
		updateContextExtractionStatus: vi.fn(),
		markContextAsEmbedded: vi.fn(),
		recordContextIndexingFailure: vi.fn(),
		getContextById: vi.fn(),
		deleteUnmanagedContextRow: vi.fn(),
		getProjectRagSettings: vi.fn(),
		storeProjectContext: vi.fn(),
		deleteProjectContext: vi.fn(),
		deleteUrlSourceChunks: vi.fn(),
		embedProjectContext: vi.fn(),
		jobEnsure: vi.fn(),
		jobStep: vi.fn(),
		jobComplete: vi.fn(),
		jobFail: vi.fn(),
		// The company row store.
		getCompanyContextSource: vi.fn(),
		updateCompanyContextSourceStatus: vi.fn(),
		markCompanyContextSourceEmbedded: vi.fn(),
		recordCompanyContextSourceIndexingFailure: vi.fn(),
		clearCompanyContextSourceEmbedding: vi.fn(),
		deleteCompanyContextSource: vi.fn(),
		// Everything else the pipeline calls.
		getSystemRAGProviderConfig: vi.fn(),
		downloadFile: vi.fn(),
		deleteFile: vi.fn(),
		extract: vi.fn(),
		chunkProjectContent: vi.fn(),
		generateEmbeddings: vi.fn(),
		embedCompanyContext: vi.fn(),
		getCompanyChunkSettings: vi.fn(),
		resolveCompanyEmbeddingModel: vi.fn(),
		storeCompanyContextPoints: vi.fn(),
		deleteCompanyContextRowPoints: vi.fn(),
		deleteCompanyContextSourcePoints: vi.fn(),
	};
});

vi.mock("@repo/database", () => ({
	db: {
		projectContext: {
			findFirst: mocks.projectContextFindFirst,
			findUnique: mocks.projectContextFindUnique,
			update: mocks.projectContextUpdate,
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
	companyContextStoragePrefix: (organizationId: string) =>
		`${organizationId}/company-context/`,
}));

vi.mock("@repo/ai", () => ({
	AIProviderNotConfiguredError: mocks.AIProviderNotConfiguredError,
	getSystemRAGProviderConfig: mocks.getSystemRAGProviderConfig,
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

vi.mock("../../activities/lib/job-progress", () => ({
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

vi.mock("../../activities/lib/activity-logger", () => ({
	activityLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../client", () => ({
	getTemporalClient: vi.fn(),
}));

import { deleteSingleContextActivity } from "../../activities/context-deletion";
import { embedSingleContextActivity } from "../../activities/context-embedding";
import {
	getProjectContextStatus,
	processProjectContext,
	retryProjectContext,
	updateProjectContextStatus,
} from "../../activities/project-context-processing";
import {
	CONTEXT_OWNER_INVALID,
	type ContextOwner,
	contextOwnerTaskQueue,
} from "../../lib/context-owner";
import { COMPANY_CONTEXT_TASK_QUEUE } from "../../task-queues";

const WORKFLOWS_PATH = resolve(__dirname, "..");
const OWNER = { kind: "company", organizationId: ORG } as const;

/** The shared ingestion activities, exactly as the worker registers them. */
const ACTIVITIES = {
	processProjectContext,
	retryProjectContext,
	getProjectContextStatus,
	updateProjectContextStatus,
	embedSingleContextActivity,
	deleteSingleContextActivity,
};

const PROJECT_ONLY = [
	"projectContextFindFirst",
	"projectContextFindUnique",
	"projectContextUpdate",
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

function expectNoProjectCalls(): void {
	for (const name of PROJECT_ONLY) {
		expect(mocks[name], name).not.toHaveBeenCalled();
	}
}

let env: TestWorkflowEnvironment;
let workflowBundle: WorkflowBundleWithSourceMap;
let runSeq = 0;

beforeAll(async () => {
	env = await TestWorkflowEnvironment.createTimeSkipping();
	workflowBundle = await bundleWorkflowCode({
		workflowsPath: WORKFLOWS_PATH,
	});
}, 120_000);

afterAll(async () => {
	await env?.teardown();
});

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getCompanyContextSource.mockResolvedValue({
		id: SOURCE,
		organizationId: ORG,
		type: "FILE",
		content: "",
		contentHash: null,
		metadata: {},
		s3Path: `${ORG}/company-context/${SOURCE}/overview.pdf`,
		s3Bucket: "project-contexts",
		originalFilename: "overview.pdf",
		mimeType: "application/pdf",
		sourceUrl: null,
		sourceTitle: null,
		extractionStatus: "PENDING",
		qdrantId: null,
	});
	mocks.updateCompanyContextSourceStatus.mockResolvedValue(true);
	mocks.markCompanyContextSourceEmbedded.mockResolvedValue(true);
	mocks.recordCompanyContextSourceIndexingFailure.mockResolvedValue(true);
	mocks.clearCompanyContextSourceEmbedding.mockResolvedValue(true);
	mocks.deleteCompanyContextSource.mockResolvedValue({
		id: SOURCE,
		urlPageIds: [],
	});
	mocks.getSystemRAGProviderConfig.mockResolvedValue({
		apiKey: "test-key",
		provider: "OPENAI_DIRECT",
		baseUrl: null,
	});
	mocks.downloadFile.mockResolvedValue({ data: Buffer.from("pdf bytes") });
	mocks.deleteFile.mockResolvedValue(undefined);
	mocks.extract.mockResolvedValue({
		text: "Company overview.",
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
		chunks: [{ content: "Company overview.", index: 0, metadata: {} }],
		chunkPayloads: [{}],
	});
	mocks.generateEmbeddings.mockResolvedValue({
		embeddings: [[0.1, 0.2]],
		provider: "OPENAI_DIRECT",
		modelString: "text-embedding-3-small",
	});
	mocks.resolveCompanyEmbeddingModel.mockResolvedValue({
		identity: MODEL,
		dimensions: 1536,
		supported: true,
	});
	mocks.storeCompanyContextPoints.mockResolvedValue(["point-0"]);
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
});

interface Run {
	result?: unknown;
	error?: unknown;
	workflowId: string;
}

/** Start a workflow on the company queue with a worker polling it, and wait. */
async function runWorkflow(
	workflowType: string,
	input: Record<string, unknown>,
): Promise<Run> {
	const taskQueue = contextOwnerTaskQueue(
		input.owner as ContextOwner | undefined,
		"project-documents",
	);
	const workflowId = `${workflowType}-${runSeq++}`;
	const worker = await Worker.create({
		connection: env.nativeConnection,
		taskQueue,
		workflowBundle,
		activities: ACTIVITIES,
	});
	return worker.runUntil(async () => {
		const handle = await env.client.workflow.start(workflowType, {
			args: [input],
			taskQueue,
			workflowId,
		});
		try {
			return { result: await handle.result(), workflowId };
		} catch (error) {
			return { error, workflowId };
		}
	});
}

/** Every activity the run scheduled, with its decoded arguments and queue. */
async function scheduledActivities(
	workflowId: string,
): Promise<Array<{ name: string; args: unknown[]; taskQueue?: string }>> {
	const history = await env.client.workflow
		.getHandle(workflowId)
		.fetchHistory();
	return (history.events ?? []).flatMap((event) => {
		const scheduled = event.activityTaskScheduledEventAttributes;
		if (!scheduled) {
			return [];
		}
		return [
			{
				name: scheduled.activityType?.name ?? "",
				args: (scheduled.input?.payloads ?? []).map((payload) =>
					defaultPayloadConverter.fromPayload(payload),
				),
				taskQueue: scheduled.taskQueue?.name ?? undefined,
			},
		];
	});
}

/**
 * Each scheduled activity carries the company owner in its arguments, and
 * runs on the company queue.
 */
function expectOwnerInEvery(
	activities: Array<{ name: string; args: unknown[]; taskQueue?: string }>,
): void {
	expect(activities.length).toBeGreaterThan(0);
	for (const activity of activities) {
		expect(JSON.stringify(activity.args), activity.name).toContain(
			JSON.stringify(OWNER),
		);
		expect(activity.taskQueue, activity.name).toBe(
			COMPANY_CONTEXT_TASK_QUEUE,
		);
	}
}

async function expectReplays(workflowId: string): Promise<void> {
	const history = await env.client.workflow
		.getHandle(workflowId)
		.fetchHistory();
	await expect(
		Worker.runReplayHistory({ workflowBundle }, history, workflowId),
	).resolves.toBeUndefined();
}

function failureType(run: Run): string | undefined {
	expect(run.error).toBeInstanceOf(WorkflowFailedError);
	return ((run.error as WorkflowFailedError).cause as { type?: string })
		?.type;
}

describe("projectContextProcessingWorkflow with a company owner", () => {
	it("processes the file on the company row in every activity", async () => {
		const run = await runWorkflow("projectContextProcessingWorkflow", {
			contextId: SOURCE,
			userId: USER,
			organizationId: ORG,
			owner: OWNER,
		});

		expect(run.error).toBeUndefined();
		expect(run.result).toMatchObject({
			success: true,
			contextId: SOURCE,
			chunkCount: 1,
			qdrantIds: ["point-0"],
		});
		expect(mocks.getCompanyContextSource).toHaveBeenCalledWith(SOURCE, ORG);
		expect(mocks.markCompanyContextSourceEmbedded).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			{ embeddingModel: MODEL, qdrantId: "point-0" },
		);
		expectNoProjectCalls();

		const activities = await scheduledActivities(run.workflowId);
		expect(activities.map((activity) => activity.name)).toEqual([
			"processProjectContext",
		]);
		expectOwnerInEvery(activities);
		// The owner rides as the trailing positional argument.
		expect(activities[0].args).toEqual([
			SOURCE,
			undefined,
			USER,
			ORG,
			"local-only",
			OWNER,
		]);
		await expectReplays(run.workflowId);
	});

	it("routes the failure path's status reads and writes to the company row too", async () => {
		mocks.resolveCompanyEmbeddingModel.mockResolvedValue({
			identity: "OPENAI_DIRECT:text-embedding-3-large",
			dimensions: 3072,
			supported: false,
		});
		mocks.getCompanyContextSource.mockImplementation(async () => ({
			id: SOURCE,
			organizationId: ORG,
			type: "FILE",
			content: "",
			contentHash: null,
			metadata: {},
			s3Path: `${ORG}/company-context/${SOURCE}/overview.pdf`,
			s3Bucket: "project-contexts",
			originalFilename: "overview.pdf",
			mimeType: "application/pdf",
			sourceUrl: null,
			sourceTitle: null,
			extractionStatus: "FAILED",
			qdrantId: null,
		}));

		const run = await runWorkflow("projectContextProcessingWorkflow", {
			contextId: SOURCE,
			userId: USER,
			organizationId: ORG,
			owner: OWNER,
		});

		expect(failureType(run)).toBe("PROJECT_CONTEXT_PROCESSING_FAILED");
		const activities = await scheduledActivities(run.workflowId);
		expect(activities.map((activity) => activity.name)).toEqual([
			"processProjectContext",
			"getProjectContextStatus",
			"updateProjectContextStatus",
		]);
		expectOwnerInEvery(activities);
		expect(mocks.updateCompanyContextSourceStatus).toHaveBeenLastCalledWith(
			SOURCE,
			ORG,
			"FAILED",
			{
				extractionError:
					"Unsupported embedding model: OPENAI_DIRECT:text-embedding-3-large",
			},
		);
		expect(mocks.storeCompanyContextPoints).not.toHaveBeenCalled();
		expectNoProjectCalls();
		await expectReplays(run.workflowId);
	});

	it("retries a company source through the company store", async () => {
		const run = await runWorkflow("projectContextProcessingWorkflow", {
			contextId: SOURCE,
			userId: USER,
			organizationId: ORG,
			isRetry: true,
			owner: OWNER,
		});

		expect(run.error).toBeUndefined();
		const activities = await scheduledActivities(run.workflowId);
		expect(activities.map((activity) => activity.name)).toEqual([
			"retryProjectContext",
		]);
		expectOwnerInEvery(activities);
		expect(mocks.clearCompanyContextSourceEmbedding).toHaveBeenCalledWith(
			SOURCE,
			ORG,
		);
		expectNoProjectCalls();
	});
});

describe("contextEmbeddingWorkflow with a company owner", () => {
	it("embeds a company text on the company row", async () => {
		mocks.getCompanyContextSource.mockResolvedValue({
			id: SOURCE,
			organizationId: ORG,
			type: "TEXT",
			content: "We deliver data platforms.",
			contentHash: "a".repeat(64),
			metadata: {},
			s3Path: null,
			s3Bucket: null,
			originalFilename: null,
			mimeType: null,
			sourceUrl: null,
			sourceTitle: "About us",
			extractionStatus: "PENDING",
			qdrantId: null,
		});

		const run = await runWorkflow("contextEmbeddingWorkflow", {
			contextId: SOURCE,
			userId: USER,
			organizationId: ORG,
			type: "TEXT",
			owner: OWNER,
		});

		expect(run.error).toBeUndefined();
		expect(run.result).toEqual({ success: true, qdrantId: "point-0" });
		expect(mocks.embedCompanyContext).toHaveBeenCalledWith(
			expect.objectContaining({
				company: expect.objectContaining({
					organizationId: ORG,
					sourceId: SOURCE,
				}),
			}),
		);
		expect(mocks.markCompanyContextSourceEmbedded).toHaveBeenCalledWith(
			SOURCE,
			ORG,
			{ embeddingModel: MODEL, qdrantId: "point-0" },
		);
		expectNoProjectCalls();

		const activities = await scheduledActivities(run.workflowId);
		expect(activities.map((activity) => activity.name)).toEqual([
			"embedSingleContextActivity",
		]);
		expectOwnerInEvery(activities);
		await expectReplays(run.workflowId);
	});
});

describe("contextDeletionWorkflow with a company owner", () => {
	it("deletes the vectors, the file and the row of the company source", async () => {
		const run = await runWorkflow("contextDeletionWorkflow", {
			contextId: SOURCE,
			userId: USER,
			organizationId: ORG,
			owner: OWNER,
		});

		expect(run.error).toBeUndefined();
		expect(run.result).toEqual({
			success: true,
			contextId: SOURCE,
			qdrantDeleted: true,
			dbDeleted: true,
		});
		expect(mocks.deleteCompanyContextSourcePoints).toHaveBeenCalledWith({
			organizationId: ORG,
			sourceId: SOURCE,
		});
		expect(mocks.deleteCompanyContextSource).toHaveBeenCalledWith(
			SOURCE,
			ORG,
		);
		expectNoProjectCalls();

		const activities = await scheduledActivities(run.workflowId);
		expect(activities.map((activity) => activity.name)).toEqual([
			"deleteSingleContextActivity",
		]);
		expectOwnerInEvery(activities);
		await expectReplays(run.workflowId);
	});
});

describe("a company owner the workflows refuse", () => {
	it.each([
		"projectContextProcessingWorkflow",
		"contextEmbeddingWorkflow",
		"contextDeletionWorkflow",
	])(
		"%s fails a company owner without an organization, scheduling nothing",
		async (workflowType) => {
			const run = await runWorkflow(workflowType, {
				contextId: SOURCE,
				userId: USER,
				type: "TEXT",
				owner: { kind: "company" },
			});

			expect(failureType(run)).toBe(CONTEXT_OWNER_INVALID);
			expect(await scheduledActivities(run.workflowId)).toEqual([]);
			expect(mocks.getCompanyContextSource).not.toHaveBeenCalled();
			expectNoProjectCalls();
		},
	);
});
