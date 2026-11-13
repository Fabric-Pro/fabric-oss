/**
 * Ingesting an uploaded transcript file (Fizzy #1877). The bar is that a file
 * ends up exactly where a Teams transcript does. The upload's own promises are
 * pinned here too: a file that cannot be used says why instead of retrying, the
 * limit holds even though the browser reported the size, and a partly readable
 * file is kept and marked.
 */

import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	contextFindFirst: vi.fn(),
	projectFindUnique: vi.fn(),
	transcriptFindFirst: vi.fn(),
	canCreateProjectContexts: vi.fn(),
	findUploadedTranscript: vi.fn(),
	createUploadedTranscript: vi.fn(),
	updateStatus: vi.fn(),
	downloadFile: vi.fn(),
	extract: vi.fn(),
	startPipelines: vi.fn(),
	summarize: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	canCreateProjectContexts: mocks.canCreateProjectContexts,
	createUploadedTranscript: mocks.createUploadedTranscript,
	db: {
		project: { findUnique: mocks.projectFindUnique },
		projectContext: { findFirst: mocks.contextFindFirst },
		projectMeetingTranscript: { findFirst: mocks.transcriptFindFirst },
	},
	findUploadedTranscript: mocks.findUploadedTranscript,
	UPLOADED_TRANSCRIPT_PROVIDER: "file-upload",
	updateContextExtractionStatus: mocks.updateStatus,
	uploadedTranscriptKeys: (sha: string) => ({
		joinUrl: `upload:${sha}`,
		meetingId: `upload:${sha}`,
		transcriptId: sha,
	}),
}));

vi.mock("@repo/database/prisma/queries/projects/context-content-hash", () => ({
	contextContentHashOrNull: () => "content-hash",
}));

vi.mock("@repo/logs", () => ({
	logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("@repo/rag", () => ({
	LocalDocxExtractor: class {
		extract = mocks.extract;
	},
}));

vi.mock("@repo/storage", () => ({ downloadFile: mocks.downloadFile }));

vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

vi.mock("../lib/meeting-transcript-pipelines", async (importOriginal) => ({
	...(await importOriginal<object>()),
	startTranscriptPipelines: mocks.startPipelines,
}));

vi.mock("../meeting-transcript-sync", () => ({
	summarizeTranscript: mocks.summarize,
	TRANSCRIPT_SUMMARIZATION_THRESHOLD: 200,
}));

import {
	ingestUploadedTranscript,
	markUploadedTranscriptFailed,
	startUploadedTranscriptPipelines,
} from "../meeting-transcript-upload";

const INPUT = {
	contextId: "context-1",
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
};

const VTT = [
	"WEBVTT",
	"",
	"00:00:01.000 --> 00:00:04.000",
	"<v Anna>Let's start.</v>",
].join("\n");

function storedContext(overrides: Record<string, unknown> = {}) {
	return {
		id: "context-1",
		s3Path: "projects/project-1/ctx.vtt",
		s3Bucket: "contexts",
		originalFilename: "Planning.vtt",
		mimeType: "text/vtt",
		extractionStatus: "EXTRACTING",
		createdAt: new Date("2026-11-02T12:00:00Z"),
		metadata: {
			provider: "file-upload",
			meetingSubject: "Planning",
			uploadedBy: "user-1",
		},
		...overrides,
	};
}

function sha256(text: string) {
	return createHash("sha256").update(text).digest("hex");
}

function failureMessage() {
	const [, status, data] = mocks.updateStatus.mock.calls[0] ?? [];
	expect(status).toBe("FAILED");
	return (data as { extractionError: string }).extractionError;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindUnique.mockResolvedValue({ organizationId: "org-1" });
	mocks.canCreateProjectContexts.mockResolvedValue(true);
	mocks.contextFindFirst.mockResolvedValue(storedContext());
	mocks.downloadFile.mockResolvedValue({ data: Buffer.from(VTT) });
	mocks.findUploadedTranscript.mockResolvedValue(null);
	mocks.createUploadedTranscript.mockResolvedValue({
		transcriptRecordId: "transcript-1",
		linkedMeetingId: "series-1",
	});
	mocks.summarize.mockResolvedValue("A short summary.");
	mocks.startPipelines.mockResolvedValue(undefined);
	mocks.updateStatus.mockResolvedValue({});
});

describe("ingestUploadedTranscript", () => {
	it("stores a file the way a Teams transcript is stored", async () => {
		const result = await ingestUploadedTranscript(INPUT);

		expect(result).toEqual({
			outcome: "ingested",
			transcriptRecordId: "transcript-1",
		});

		const stored = mocks.createUploadedTranscript.mock.calls[0]?.[0];
		expect(stored).toMatchObject({
			projectId: "project-1",
			contextId: "context-1",
			contentSha256: sha256(VTT),
			meetingSubject: "Planning",
			speakerNames: ["Anna"],
			sourceTitle: "Meeting Transcript: Planning",
			contentHash: "content-hash",
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(stored.content).toContain("## Meeting Transcript: Planning");
		expect(stored.content).toContain("**Participants:** Anna");
		expect(stored.content).toContain("Anna: Let's start.");
		expect(stored.metadata).toMatchObject({
			provider: "file-upload",
			transcriptSource: "upload",
			meetingId: `upload:${sha256(VTT)}`,
			transcriptId: sha256(VTT),
			uploadedBy: "user-1",
		});
	});

	it("dates an upload by the upload, as before", async () => {
		await ingestUploadedTranscript(INPUT);

		expect(
			mocks.createUploadedTranscript.mock.calls[0]?.[0].meetingDate,
		).toEqual(new Date("2026-11-02T12:00:00Z"));
	});

	it("dates a folder import from the file, never by the import (#3507)", async () => {
		mocks.contextFindFirst.mockResolvedValue(
			storedContext({
				originalFilename: "Planning 2026-03-04.vtt",
				metadata: {
					provider: "onedrive-folder",
					meetingSubject: "Planning",
				},
			}),
		);

		await ingestUploadedTranscript(INPUT);

		const stored = mocks.createUploadedTranscript.mock.calls[0]?.[0];
		expect(stored.meetingDate).toEqual(new Date("2026-03-04T12:00:00Z"));
		expect(stored.metadata).toMatchObject({
			provider: "onedrive-folder",
			transcriptSource: "onedrive",
			meetingDate: "2026-03-04T12:00:00.000Z",
		});
	});

	it("leaves a folder import's date unknown when the file does not say (#3507)", async () => {
		mocks.contextFindFirst.mockResolvedValue(
			storedContext({
				metadata: {
					provider: "onedrive-folder",
					meetingSubject: "Planning",
				},
			}),
		);

		await ingestUploadedTranscript(INPUT);

		const stored = mocks.createUploadedTranscript.mock.calls[0]?.[0];
		expect(stored.meetingDate).toBeNull();
		expect(stored.metadata.meetingDate).toBeNull();
		expect(stored.content).toContain("Unknown date");
	});

	it("leaves the pipelines to their own step, so a crash here cannot skip them", async () => {
		await ingestUploadedTranscript(INPUT);

		expect(mocks.startPipelines).not.toHaveBeenCalled();
	});

	it("reads a Word file locally, without the provider lookup a database failure could break", async () => {
		mocks.contextFindFirst.mockResolvedValue(
			storedContext({
				originalFilename: "Planning.docx",
				mimeType: "application/docx",
			}),
		);
		mocks.extract.mockResolvedValue({
			text: "Anna: One.\nAnna: Two.\n",
		});

		await ingestUploadedTranscript(INPUT);

		expect(mocks.extract).toHaveBeenCalledWith(
			expect.any(Buffer),
			"Planning.docx",
		);
		expect(
			mocks.createUploadedTranscript.mock.calls[0]?.[0].speakerNames,
		).toEqual(["Anna"]);
	});

	it("removes what Postgres cannot store", async () => {
		mocks.contextFindFirst.mockResolvedValue(
			storedContext({ originalFilename: "Planning.txt" }),
		);
		mocks.downloadFile.mockResolvedValue({
			data: Buffer.from("Anna: he\u0000llo"),
		});

		await ingestUploadedTranscript(INPUT);

		expect(
			mocks.createUploadedTranscript.mock.calls[0]?.[0].content,
		).not.toContain("\u0000");
	});

	it("keeps a partly readable file and marks it", async () => {
		mocks.downloadFile.mockResolvedValue({
			data: Buffer.from(`${VTT}\n\nbroken line\nanother\n`),
		});

		const result = await ingestUploadedTranscript(INPUT);

		expect(result.outcome).toBe("ingested");
		expect(
			mocks.createUploadedTranscript.mock.calls[0]?.[0].metadata
				.unreadableParts,
		).toBe(2);
	});

	it("does not mark a file that was read in full", async () => {
		await ingestUploadedTranscript(INPUT);

		expect(
			mocks.createUploadedTranscript.mock.calls[0]?.[0].metadata,
		).not.toHaveProperty("unreadableParts");
	});

	it("summarizes a long transcript alongside it and keeps the body", async () => {
		const long = `WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Anna>${"word ".repeat(100)}</v>\n`;
		mocks.downloadFile.mockResolvedValue({ data: Buffer.from(long) });

		await ingestUploadedTranscript(INPUT);

		const stored = mocks.createUploadedTranscript.mock.calls[0]?.[0];
		expect(stored.summary).toBe("A short summary.");
		expect(stored.content).toContain("word word");
	});

	describe("a file that cannot be used", () => {
		it("refuses one over the limit, whatever size the browser reported", async () => {
			mocks.downloadFile.mockResolvedValue({
				data: Buffer.alloc(25 * 1024 * 1024 + 1),
			});

			const result = await ingestUploadedTranscript(INPUT);

			expect(result.outcome).toBe("rejected");
			expect(failureMessage()).toContain("25MB");
			expect(mocks.createUploadedTranscript).not.toHaveBeenCalled();
		});

		it("refuses a format this surface does not accept", async () => {
			mocks.contextFindFirst.mockResolvedValue(
				storedContext({ originalFilename: "Planning.pdf" }),
			);

			const result = await ingestUploadedTranscript(INPUT);

			expect(result.outcome).toBe("rejected");
			expect(failureMessage()).toContain(".txt, .vtt, .docx");
		});

		it("says so when there is no text in it", async () => {
			mocks.downloadFile.mockResolvedValue({
				data: Buffer.from("WEBVTT\n\n"),
			});

			const result = await ingestUploadedTranscript(INPUT);

			expect(result.outcome).toBe("rejected");
			expect(failureMessage()).toContain("no text");
		});

		it("says so when a Word file cannot be opened", async () => {
			mocks.contextFindFirst.mockResolvedValue(
				storedContext({ originalFilename: "Planning.docx" }),
			);
			mocks.extract.mockRejectedValue(new Error("not a zip"));

			const result = await ingestUploadedTranscript(INPUT);

			expect(result.outcome).toBe("rejected");
			expect(failureMessage()).toContain("could not be opened");
		});
	});

	describe("the same content twice", () => {
		it("does not store it again", async () => {
			mocks.findUploadedTranscript.mockResolvedValue({
				id: "transcript-0",
			});

			const result = await ingestUploadedTranscript(INPUT);

			expect(result).toEqual({
				outcome: "duplicate",
				transcriptRecordId: "transcript-0",
			});
			expect(mocks.createUploadedTranscript).not.toHaveBeenCalled();
			expect(failureMessage()).toContain("already");
		});

		it("treats losing the race to the unique index the same way", async () => {
			mocks.createUploadedTranscript.mockRejectedValue(
				Object.assign(new Error("unique"), { code: "P2002" }),
			);

			const result = await ingestUploadedTranscript(INPUT);

			expect(result.outcome).toBe("duplicate");
			expect(failureMessage()).toContain("already");
		});
	});

	it("on a retry after it stored the file, hands back the transcript so the pipelines still start", async () => {
		mocks.contextFindFirst.mockResolvedValue(
			storedContext({ extractionStatus: "COMPLETED" }),
		);
		mocks.transcriptFindFirst.mockResolvedValue({ id: "transcript-1" });

		const result = await ingestUploadedTranscript(INPUT);

		expect(result).toEqual({
			outcome: "ingested",
			transcriptRecordId: "transcript-1",
		});
		expect(mocks.downloadFile).not.toHaveBeenCalled();
		expect(mocks.transcriptFindFirst.mock.calls[0]?.[0].where).toEqual({
			projectId: "project-1",
			contextId: "context-1",
		});
	});

	describe("the person who uploaded it, when the job runs", () => {
		it("stops if they can no longer add context to the project", async () => {
			mocks.canCreateProjectContexts.mockResolvedValue(false);

			const result = await ingestUploadedTranscript(INPUT);

			expect(result.outcome).toBe("rejected");
			expect(failureMessage()).toContain("access");
			expect(mocks.canCreateProjectContexts).toHaveBeenCalledWith(
				"project-1",
				"user-1",
			);
			expect(mocks.downloadFile).not.toHaveBeenCalled();
		});

		it("stops if the organization is not the project's", async () => {
			mocks.projectFindUnique.mockResolvedValue({
				organizationId: "another-org",
			});

			const result = await ingestUploadedTranscript(INPUT);

			expect(result.outcome).toBe("rejected");
			expect(mocks.downloadFile).not.toHaveBeenCalled();
		});

		it("accepts a personal project, which has no organization", async () => {
			mocks.projectFindUnique.mockResolvedValue({ organizationId: null });

			const result = await ingestUploadedTranscript({
				...INPUT,
				organizationId: undefined,
			});

			expect(result.outcome).toBe("ingested");
		});
	});

	it("only touches a transcript context of this project", async () => {
		mocks.contextFindFirst.mockResolvedValue(null);

		await expect(ingestUploadedTranscript(INPUT)).rejects.toThrow(
			"context-1",
		);

		expect(mocks.contextFindFirst.mock.calls[0]?.[0].where).toEqual({
			id: "context-1",
			projectId: "project-1",
			type: "MEETING_TRANSCRIPT",
		});
	});

	it("lets a storage failure throw, so Temporal retries it", async () => {
		mocks.downloadFile.mockRejectedValue(new Error("S3 is down"));

		await expect(ingestUploadedTranscript(INPUT)).rejects.toThrow(
			"S3 is down",
		);
		expect(mocks.updateStatus).not.toHaveBeenCalled();
	});
});

describe("startUploadedTranscriptPipelines", () => {
	const meetingDate = new Date("2026-11-02T12:00:00Z");

	beforeEach(() => {
		mocks.transcriptFindFirst.mockResolvedValue({
			id: "transcript-1",
			linkedMeetingId: "series-1",
			meetingId: "upload:abc",
			transcriptId: "abc",
			meetingSubject: "Planning",
			meetingDate,
		});
		mocks.contextFindFirst.mockResolvedValue({ content: "the body" });
	});

	it("starts the same pipelines as a Teams transcript, from what was stored", async () => {
		await startUploadedTranscriptPipelines({
			...INPUT,
			transcriptRecordId: "transcript-1",
		});

		expect(mocks.startPipelines).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			organizationId: "org-1",
			transcriptRecordId: "transcript-1",
			contextId: "context-1",
			linkedMeetingId: "series-1",
			meetingId: "upload:abc",
			transcriptId: "abc",
			meetingSubject: "Planning",
			meetingDate: meetingDate.toISOString(),
			transcriptText: "the body",
			provider: "file-upload",
			embeddingWorkflowId: "context-embedding-context-1-upload",
		});
	});

	it("does nothing when the transcript has gone, for example if it was removed meanwhile", async () => {
		mocks.transcriptFindFirst.mockResolvedValue(null);

		await startUploadedTranscriptPipelines({
			...INPUT,
			transcriptRecordId: "transcript-1",
		});

		expect(mocks.startPipelines).not.toHaveBeenCalled();
	});
});

describe("markUploadedTranscriptFailed", () => {
	it("leaves a reason the user can read", async () => {
		await markUploadedTranscriptFailed({ contextId: "context-1" });

		expect(mocks.updateStatus).toHaveBeenCalledWith(
			"context-1",
			"FAILED",
			expect.objectContaining({
				extractionError: expect.stringContaining("try again"),
			}),
		);
	});
});
