import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createUploadUrl: vi.fn(),
	startUploadIngest: vi.fn(),
	deleteContext: vi.fn(),
	fetch: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			meetingTranscriptSync: {
				createUploadUrl: mocks.createUploadUrl,
				startUploadIngest: mocks.startUploadIngest,
			},
			contexts: { delete: mocks.deleteContext },
		},
	},
}));

import {
	transcriptFileProblem,
	uploadTranscriptFile,
} from "../upload-transcript-file";

const SCOPE = { projectId: "project-1", organizationId: "org-1" };
const file = new File(["Anna: hello"], "Planning.vtt");

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("fetch", mocks.fetch);
	mocks.fetch.mockResolvedValue({ ok: true });
	mocks.startUploadIngest.mockResolvedValue({ status: "EXTRACTING" });
	mocks.deleteContext.mockResolvedValue({});
	mocks.createUploadUrl.mockResolvedValue({
		status: "upload",
		contextId: "context-1",
		signedUploadUrl: "https://storage/signed",
		contentType: "text/vtt",
	});
});

describe("transcriptFileProblem", () => {
	it("passes a file it can take", () => {
		expect(transcriptFileProblem(file)).toBeNull();
	});

	it("names the file and the formats when the type is wrong", () => {
		const problem = transcriptFileProblem(new File(["x"], "Planning.pdf"));

		expect(problem).toContain("Planning.pdf");
		expect(problem).toContain(".txt, .vtt, .docx");
	});

	it("names the file and the limit when it is too large", () => {
		const big = { name: "Planning.txt", size: 25 * 1024 * 1024 + 1 };

		const problem = transcriptFileProblem(big);

		expect(problem).toContain("Planning.txt");
		expect(problem).toContain("25MB");
	});
});

describe("uploadTranscriptFile", () => {
	it("asks with the file's hash, sends it, then starts reading it", async () => {
		const result = await uploadTranscriptFile({ ...SCOPE, file });

		expect(result).toEqual({ status: "started" });
		const request = mocks.createUploadUrl.mock.calls[0]?.[0];
		expect(request).toMatchObject({
			projectId: "project-1",
			organizationId: "org-1",
			filename: "Planning.vtt",
			size: file.size,
		});
		expect(request.contentSha256).toMatch(/^[a-f0-9]{64}$/);
		expect(mocks.fetch).toHaveBeenCalledWith("https://storage/signed", {
			method: "PUT",
			body: file,
			headers: { "Content-Type": "text/vtt" },
		});
		expect(mocks.startUploadIngest).toHaveBeenCalledWith({
			projectId: "project-1",
			organizationId: "org-1",
			contextId: "context-1",
		});
	});

	it("sends the same hash for the same content", async () => {
		await uploadTranscriptFile({ ...SCOPE, file });
		await uploadTranscriptFile({
			...SCOPE,
			file: new File(["Anna: hello"], "Renamed.vtt"),
		});

		const [first, second] = mocks.createUploadUrl.mock.calls;
		expect(first?.[0].contentSha256).toBe(second?.[0].contentSha256);
	});

	it("stops at a duplicate and sends nothing", async () => {
		const addedAt = new Date("2026-10-30T10:00:00Z");
		mocks.createUploadUrl.mockResolvedValue({
			status: "duplicate",
			meetingSubject: "Planning",
			addedAt,
		});

		const result = await uploadTranscriptFile({ ...SCOPE, file });

		expect(result).toEqual({
			status: "duplicate",
			meetingSubject: "Planning",
			addedAt,
		});
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.startUploadIngest).not.toHaveBeenCalled();
	});

	it("passes on the choice to process a duplicate again", async () => {
		mocks.createUploadUrl.mockResolvedValue({ status: "reprocessing" });

		const result = await uploadTranscriptFile({
			...SCOPE,
			file,
			reprocess: true,
		});

		expect(result).toEqual({ status: "reprocessing" });
		expect(mocks.createUploadUrl.mock.calls[0]?.[0].reprocess).toBe(true);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("removes the row when the file never reached storage", async () => {
		mocks.fetch.mockResolvedValue({ ok: false });

		await expect(uploadTranscriptFile({ ...SCOPE, file })).rejects.toThrow(
			"Planning.vtt",
		);

		expect(mocks.deleteContext).toHaveBeenCalledWith({
			id: "context-1",
			projectId: "project-1",
		});
		expect(mocks.startUploadIngest).not.toHaveBeenCalled();
	});

	it("removes the row when the network drops during the upload", async () => {
		mocks.fetch.mockRejectedValue(new TypeError("Failed to fetch"));

		await expect(uploadTranscriptFile({ ...SCOPE, file })).rejects.toThrow(
			"Planning.vtt",
		);

		expect(mocks.deleteContext).toHaveBeenCalledWith({
			id: "context-1",
			projectId: "project-1",
		});
		expect(mocks.startUploadIngest).not.toHaveBeenCalled();
	});

	it("reports the upload failure even if the clean-up fails too", async () => {
		mocks.fetch.mockResolvedValue({ ok: false });
		mocks.deleteContext.mockRejectedValue(new Error("offline"));

		await expect(uploadTranscriptFile({ ...SCOPE, file })).rejects.toThrow(
			"Planning.vtt",
		);
	});

	it("refuses a storage it cannot send to directly", async () => {
		mocks.createUploadUrl.mockResolvedValue({
			status: "upload",
			contextId: "context-1",
			signedUploadUrl: null,
			contentType: "text/vtt",
		});

		await expect(uploadTranscriptFile({ ...SCOPE, file })).rejects.toThrow(
			"direct uploads",
		);
		expect(mocks.deleteContext).toHaveBeenCalled();
	});
});
