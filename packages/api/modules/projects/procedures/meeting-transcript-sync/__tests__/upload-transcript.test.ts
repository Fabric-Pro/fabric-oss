/**
 * The two calls behind uploading a transcript file (Fizzy #1877): asking where
 * to put it, and saying it has arrived. The upload is the door, so its refusals
 * are pinned here, along with the duplicate answer that has to reach the user
 * before the file is sent, and the checks that keep one project out of another.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	contextUpdateMany: vi.fn(),
	projectFindUnique: vi.fn(),
	findUploadedTranscript: vi.fn(),
	createFileContext: vi.fn(),
	getContextById: vi.fn(),
	updateStatus: vi.fn(),
	getSignedUploadUrl: vi.fn(),
	workflowStart: vi.fn(),
}));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { projectContexts: "contexts" } } },
}));

vi.mock("@repo/database", () => ({
	createFileContext: mocks.createFileContext,
	db: {
		project: { findUnique: mocks.projectFindUnique },
		projectContext: { updateMany: mocks.contextUpdateMany },
	},
	findUploadedTranscript: mocks.findUploadedTranscript,
	getContextById: mocks.getContextById,
	UPLOADED_TRANSCRIPT_PROVIDER: "file-upload",
	updateContextExtractionStatus: mocks.updateStatus,
	uploadedTranscriptKeys: (sha: string) => ({
		joinUrl: `upload:${sha}`,
		meetingId: `upload:${sha}`,
		transcriptId: sha,
	}),
}));

vi.mock("@repo/logs", () => ({
	logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: () => ({
		type: "s3",
		supportsPresignedUrls: true,
		getSignedUploadUrl: mocks.getSignedUploadUrl,
	}),
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: async () => ({
		workflow: { start: mocks.workflowStart },
	}),
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (o: unknown) => o,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const build = () => {
		const chain: Record<string, unknown> = {};
		for (const k of ["use", "route", "input"]) {
			chain[k] = () => chain;
		}
		chain.handler = (fn: unknown) => fn;
		return chain;
	};
	return {
		tenantProtectedProcedure: build(),
		requireProjectPermission: () => undefined,
		Permissions: { CONTEXT_CREATE: "context:create" },
	};
});

import {
	createTranscriptUploadUrlProcedure,
	startTranscriptUploadIngestProcedure,
} from "../upload-transcript";

type Handler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<Record<string, unknown>>;

const requestUrl = createTranscriptUploadUrlProcedure as unknown as Handler;
const startIngest = startTranscriptUploadIngestProcedure as unknown as Handler;

const CONTEXT = { user: { id: "user-1" }, session: {} };
const SHA = "a".repeat(64);
const REQUEST = {
	projectId: "project-1",
	filename: "Planning call.vtt",
	size: 1024,
	contentSha256: SHA,
};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	mocks.findUploadedTranscript.mockResolvedValue(null);
	mocks.contextUpdateMany.mockResolvedValue({ count: 1 });
	mocks.createFileContext.mockResolvedValue({ id: "context-1" });
	mocks.getSignedUploadUrl.mockResolvedValue("https://storage/signed");
	mocks.workflowStart.mockResolvedValue({});
	mocks.updateStatus.mockResolvedValue({});
	mocks.getContextById.mockResolvedValue({
		id: "context-1",
		projectId: "project-1",
		organizationId: "org-1",
		type: "MEETING_TRANSCRIPT",
		extractionStatus: "PENDING",
		metadata: { provider: "file-upload" },
	});
});

describe("createTranscriptUploadUrl", () => {
	it("creates the row the upload will fill and says where to send the file", async () => {
		const result = await requestUrl({ input: REQUEST, context: CONTEXT });

		expect(result).toMatchObject({
			status: "upload",
			contextId: "context-1",
			signedUploadUrl: "https://storage/signed",
			useServerUpload: false,
			contentType: "text/vtt",
		});

		const row = mocks.createFileContext.mock.calls[0]?.[0];
		expect(row).toMatchObject({
			projectId: "project-1",
			type: "MEETING_TRANSCRIPT",
			s3Bucket: "contexts",
			originalFilename: "Planning call.vtt",
			mimeType: "text/vtt",
			fileSize: 1024,
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(row.s3Path).toMatch(/^projects\/project-1\/ctx_.+\.vtt$/);
		expect(row.metadata).toMatchObject({
			provider: "file-upload",
			transcriptSource: "upload",
			meetingSubject: "Planning call",
			uploadedBy: "user-1",
		});
	});

	it("signs for the type and the size it checked, so a larger file is refused by storage", async () => {
		await requestUrl({ input: REQUEST, context: CONTEXT });

		expect(mocks.getSignedUploadUrl).toHaveBeenCalledWith(
			expect.stringContaining("projects/project-1/"),
			{
				bucket: "contexts",
				contentType: "text/vtt",
				contentLength: 1024,
			},
		);
	});

	it("refuses another format and lists the ones it takes", async () => {
		await expect(
			requestUrl({
				input: { ...REQUEST, filename: "Planning.pdf" },
				context: CONTEXT,
			}),
		).rejects.toThrow(/\.txt, \.vtt, \.docx/);
		expect(mocks.createFileContext).not.toHaveBeenCalled();
	});

	it("refuses a file over the limit and names it", async () => {
		await expect(
			requestUrl({
				input: { ...REQUEST, size: 25 * 1024 * 1024 + 1 },
				context: CONTEXT,
			}),
		).rejects.toThrow(/25MB/);
		expect(mocks.createFileContext).not.toHaveBeenCalled();
	});

	it("refuses an organization that is not the project's", async () => {
		await expect(
			requestUrl({
				input: { ...REQUEST, organizationId: "someone-elses-org" },
				context: CONTEXT,
			}),
		).rejects.toThrow(/does not match/);
		expect(mocks.createFileContext).not.toHaveBeenCalled();
	});

	it("takes the organization from the project, not from the caller", async () => {
		await requestUrl({
			input: { ...REQUEST, organizationId: null },
			context: CONTEXT,
		});

		expect(mocks.createFileContext.mock.calls[0]?.[0].organizationId).toBe(
			"org-1",
		);
	});

	it("files a personal project's upload under no organization", async () => {
		mocks.projectFindUnique.mockResolvedValue({
			id: "project-1",
			organizationId: null,
		});

		await requestUrl({ input: REQUEST, context: CONTEXT });

		expect(
			mocks.createFileContext.mock.calls[0]?.[0].organizationId,
		).toBeUndefined();
	});

	it("says so when the project does not exist", async () => {
		mocks.projectFindUnique.mockResolvedValue(null);

		await expect(
			requestUrl({ input: REQUEST, context: CONTEXT }),
		).rejects.toThrow(/not found/i);
	});

	describe("a file this project already has", () => {
		const syncedAt = new Date("2026-10-30T10:00:00Z");

		beforeEach(() => {
			mocks.findUploadedTranscript.mockResolvedValue({
				id: "transcript-0",
				meetingSubject: "Planning call",
				syncedAt,
			});
		});

		it("asks before anything is uploaded", async () => {
			const result = await requestUrl({
				input: REQUEST,
				context: CONTEXT,
			});

			expect(result).toEqual({
				status: "duplicate",
				meetingSubject: "Planning call",
				addedAt: syncedAt,
			});
			expect(mocks.createFileContext).not.toHaveBeenCalled();
			expect(mocks.getSignedUploadUrl).not.toHaveBeenCalled();
		});

		it("re-runs the analysis on the stored transcript when told to", async () => {
			const result = await requestUrl({
				input: { ...REQUEST, reprocess: true },
				context: CONTEXT,
			});

			expect(result).toEqual({ status: "reprocessing" });
			expect(mocks.createFileContext).not.toHaveBeenCalled();
			expect(mocks.workflowStart).toHaveBeenCalledWith(
				"extractMeetingInsightsOnDemandWorkflow",
				expect.objectContaining({
					workflowId: "meeting-digest-insights:transcript-0",
					args: [
						{
							projectId: "project-1",
							organizationId: "org-1",
							userId: "user-1",
							transcriptCuid: "transcript-0",
							force: true,
						},
					],
				}),
			);
		});

		it("takes an analysis already running as the answer", async () => {
			mocks.workflowStart.mockRejectedValue(
				Object.assign(new Error("started"), {
					name: "WorkflowExecutionAlreadyStartedError",
				}),
			);

			const result = await requestUrl({
				input: { ...REQUEST, reprocess: true },
				context: CONTEXT,
			});

			expect(result).toEqual({ status: "reprocessing" });
		});
	});
});

describe("startTranscriptUploadIngest", () => {
	const INPUT = { projectId: "project-1", contextId: "context-1" };

	it("starts one ingest per upload and marks the row as working", async () => {
		const result = await startIngest({ input: INPUT, context: CONTEXT });

		expect(result).toEqual({ status: "EXTRACTING" });
		expect(mocks.contextUpdateMany).toHaveBeenCalledWith({
			where: {
				id: "context-1",
				projectId: "project-1",
				extractionStatus: "PENDING",
			},
			data: { extractionStatus: "EXTRACTING" },
		});
		expect(mocks.workflowStart).toHaveBeenCalledWith(
			"uploadedTranscriptIngestWorkflow",
			expect.objectContaining({
				taskQueue: "project-documents",
				workflowId: "uploaded-transcript-ingest-context-1",
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				workflowIdConflictPolicy: "FAIL",
				args: [
					{
						contextId: "context-1",
						projectId: "project-1",
						userId: "user-1",
						organizationId: "org-1",
					},
				],
			}),
		);
	});

	it("will not touch a context of another project", async () => {
		mocks.getContextById.mockResolvedValue({
			id: "context-1",
			projectId: "project-2",
			type: "MEETING_TRANSCRIPT",
			extractionStatus: "PENDING",
			metadata: { provider: "file-upload" },
		});

		await expect(
			startIngest({ input: INPUT, context: CONTEXT }),
		).rejects.toThrow(/not found/i);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
	});

	it("will not treat an ordinary context as a transcript", async () => {
		mocks.getContextById.mockResolvedValue({
			id: "context-1",
			projectId: "project-1",
			type: "DOCUMENT",
			extractionStatus: "PENDING",
			metadata: {},
		});

		await expect(
			startIngest({ input: INPUT, context: CONTEXT }),
		).rejects.toThrow(/not found/i);
	});

	it("lets only one caller claim the row", async () => {
		// Two calls can both read PENDING. Only the conditional write decides,
		// so a late one cannot put a finished row back to EXTRACTING.
		mocks.contextUpdateMany.mockResolvedValue({ count: 0 });

		await expect(
			startIngest({ input: INPUT, context: CONTEXT }),
		).rejects.toThrow(/already/);
		expect(mocks.workflowStart).not.toHaveBeenCalled();
		expect(mocks.updateStatus).not.toHaveBeenCalled();
	});

	it("puts the row back when the workflow cannot start", async () => {
		mocks.workflowStart.mockRejectedValue(new Error("temporal offline"));

		await expect(
			startIngest({ input: INPUT, context: CONTEXT }),
		).rejects.toThrow(/start/i);
		expect(mocks.updateStatus).toHaveBeenLastCalledWith(
			"context-1",
			"PENDING",
		);
	});

	it("takes a run already going as success", async () => {
		mocks.workflowStart.mockRejectedValue(
			Object.assign(new Error("started"), {
				name: "WorkflowExecutionAlreadyStartedError",
			}),
		);

		await expect(
			startIngest({ input: INPUT, context: CONTEXT }),
		).resolves.toEqual({ status: "EXTRACTING" });
		expect(mocks.updateStatus).not.toHaveBeenCalled();
	});
});
