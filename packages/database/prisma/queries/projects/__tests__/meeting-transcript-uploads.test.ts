/**
 * Transcripts uploaded as files (Fizzy #1877) reuse the Teams tables, so that
 * the digest, insights and action items need no second path. The risk that
 * creates is the reverse one: a row with no Teams meeting behind it reaching
 * anything that talks to Microsoft. These tests pin that it cannot.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	linkedFindMany: vi.fn(),
	linkedCount: vi.fn(),
	linkedUpdateMany: vi.fn(),
	linkedCreate: vi.fn(),
	linkedDeleteMany: vi.fn(),
	transcriptFindUnique: vi.fn(),
	transcriptCreate: vi.fn(),
	contextUpdate: vi.fn(),
	contextDeleteMany: vi.fn(),
}));

vi.mock("../../../client", () => {
	const client = {
		projectLinkedMeeting: {
			findMany: db.linkedFindMany,
			count: db.linkedCount,
			updateMany: db.linkedUpdateMany,
			create: db.linkedCreate,
			deleteMany: db.linkedDeleteMany,
		},
		projectMeetingTranscript: {
			findUnique: db.transcriptFindUnique,
			create: db.transcriptCreate,
		},
		projectContext: {
			update: db.contextUpdate,
			deleteMany: db.contextDeleteMany,
		},
	};
	return {
		db: {
			...client,
			$transaction: (fn: (tx: typeof client) => unknown) => fn(client),
		},
	};
});

import { deleteUnmanagedContextRow } from "../contexts";
import {
	countSyncableLinkedMeetings,
	createUploadedTranscript,
	findUploadedTranscript,
	getLinkedMeetingJoinUrls,
	getLinkedMeetings,
	recordMeetingSyncFailure,
	uploadedTranscriptKeys,
} from "../meeting-transcripts";

const SHA = "a".repeat(64);

function firstArg(mock: { mock: { calls: unknown[][] } }) {
	const [call] = mock.mock.calls;
	if (!call) {
		throw new Error("expected a call");
	}
	return call[0] as any;
}

beforeEach(() => {
	vi.clearAllMocks();
	db.linkedFindMany.mockResolvedValue([]);
	db.linkedCount.mockResolvedValue(0);
	db.linkedUpdateMany.mockResolvedValue({ count: 0 });
	db.linkedCreate.mockResolvedValue({ id: "series-1" });
	db.transcriptCreate.mockResolvedValue({ id: "transcript-1" });
});

describe("the Teams sync never sees an uploaded file", () => {
	it("leaves it out of the meetings the sync reads", async () => {
		await getLinkedMeetingJoinUrls("project-1");

		expect(firstArg(db.linkedFindMany).where).toEqual({
			projectId: "project-1",
			deactivatedAt: null,
			source: "TEAMS",
		});
	});

	it("does not count it as something to sync", async () => {
		await countSyncableLinkedMeetings("project-1");

		expect(firstArg(db.linkedCount).where.source).toBe("TEAMS");
	});

	it("leaves it out of the linked meetings list", async () => {
		await getLinkedMeetings("project-1");

		expect(firstArg(db.linkedFindMany).where.source).toBe("TEAMS");
	});

	it("does not blame it when Microsoft cannot be reached", async () => {
		await recordMeetingSyncFailure({
			projectId: "project-1",
			errorMessage: "down",
		});

		expect(firstArg(db.linkedUpdateMany).where.source).toBe("TEAMS");
	});
});

describe("deleting an uploaded transcript's context", () => {
	beforeEach(() => {
		db.contextDeleteMany.mockResolvedValue({ count: 1 });
		db.linkedDeleteMany.mockResolvedValue({ count: 1 });
	});

	it("takes its series along in the same transaction, so the file can be added again", async () => {
		await deleteUnmanagedContextRow({
			contextId: "context-1",
			projectId: "project-1",
		});

		expect(firstArg(db.linkedDeleteMany).where).toEqual({
			projectId: "project-1",
			source: "UPLOAD",
			transcripts: { some: { contextId: "context-1" } },
		});
	});

	it("leaves the series alone when the context was not deleted", async () => {
		db.contextDeleteMany.mockResolvedValue({ count: 0 });

		await deleteUnmanagedContextRow({
			contextId: "context-1",
			projectId: "project-1",
		}).catch(() => undefined);

		expect(db.linkedDeleteMany).not.toHaveBeenCalled();
	});
});

describe("uploadedTranscriptKeys", () => {
	it("keys a file on its content, so the same file is the same transcript", () => {
		expect(uploadedTranscriptKeys(SHA)).toEqual({
			joinUrl: `upload:${SHA}`,
			meetingId: `upload:${SHA}`,
			transcriptId: SHA,
		});
	});
});

describe("findUploadedTranscript", () => {
	it("looks in this project only", async () => {
		db.transcriptFindUnique.mockResolvedValue(null);

		await findUploadedTranscript("project-1", SHA);

		expect(firstArg(db.transcriptFindUnique).where).toEqual({
			projectId_meetingId_transcriptId: {
				projectId: "project-1",
				meetingId: `upload:${SHA}`,
				transcriptId: SHA,
			},
		});
	});
});

describe("createUploadedTranscript", () => {
	const input = {
		projectId: "project-1",
		contextId: "context-1",
		contentSha256: SHA,
		meetingSubject: "Planning",
		meetingDate: new Date("2026-11-02T12:00:00Z"),
		content: "## Meeting Transcript: Planning\nAnna: hello",
		contentHash: "hash",
		sourceTitle: "Meeting Transcript: Planning",
		metadata: { provider: "file-upload" },
		speakerNames: ["Anna"],
		summary: undefined,
		userId: "user-1",
		organizationId: "org-1",
	};

	it("files it under a series of its own, marked as an upload", async () => {
		await createUploadedTranscript(input);

		expect(firstArg(db.linkedCreate).data).toEqual({
			projectId: "project-1",
			joinUrl: `upload:${SHA}`,
			subject: "Planning",
			source: "UPLOAD",
			userId: "user-1",
			organizationId: "org-1",
		});
	});

	it("fills the context row the upload created and marks it finished", async () => {
		await createUploadedTranscript(input);

		const update = firstArg(db.contextUpdate);
		expect(update.where).toEqual({ id: "context-1" });
		expect(update.data).toMatchObject({
			content: input.content,
			contentHash: "hash",
			sourceTitle: "Meeting Transcript: Planning",
			metadata: { provider: "file-upload" },
			extractionStatus: "COMPLETED",
		});
		expect(update.data.extractedAt).toBeInstanceOf(Date);
	});

	it("writes the record the digest, insights and action items read", async () => {
		const record = await createUploadedTranscript(input);

		expect(firstArg(db.transcriptCreate).data).toMatchObject({
			projectId: "project-1",
			linkedMeetingId: "series-1",
			meetingId: `upload:${SHA}`,
			transcriptId: SHA,
			meetingSubject: "Planning",
			contextId: "context-1",
			speakerNames: ["Anna"],
			contentLength: input.content.length,
			wasSummarized: false,
			userId: "user-1",
			organizationId: "org-1",
		});
		expect(record).toEqual({
			transcriptRecordId: "transcript-1",
			linkedMeetingId: "series-1",
		});
	});
});
