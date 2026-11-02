import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	uploadFile: vi.fn(),
	deleteFile: vi.fn(),
	getFileMetadata: vi.fn(),
	recordChatMediaObject: vi.fn(),
	resolveChatMediaAccess: vi.fn(),
	isBeforeChatMediaLegacyCutoff: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	recordChatMediaObject: mocks.recordChatMediaObject,
	resolveChatMediaAccess: mocks.resolveChatMediaAccess,
	isBeforeChatMediaLegacyCutoff: mocks.isBeforeChatMediaLegacyCutoff,
}));

vi.mock("@repo/storage", () => ({
	uploadFile: mocks.uploadFile,
	deleteFile: mocks.deleteFile,
	getFileMetadata: mocks.getFileMetadata,
}));

import {
	ChatMediaPersistenceError,
	canUseChatMedia,
	chatMediaProxyUrl,
	uploadRecordedChatMedia,
} from "../chat-media";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.resolveChatMediaAccess.mockResolvedValue("allow");
	mocks.isBeforeChatMediaLegacyCutoff.mockResolvedValue(false);
});

describe("uploadRecordedChatMedia", () => {
	it("records TTS audio before returning a proxy-compatible owner path", async () => {
		const path = await uploadRecordedChatMedia({
			data: Buffer.from("example"),
			contentType: "audio/mpeg",
			extension: "mp3",
			storageKind: "tts-audio",
			recordKind: "TTS_AUDIO",
			userId: "example-user",
			organizationId: "example-org",
			conversationId: "example-conversation",
		});

		expect(path).toMatch(/^example-org\/tts-audio\/\d+-[a-z0-9]+\.mp3$/);
		expect(mocks.recordChatMediaObject).toHaveBeenCalledWith({
			storageKey: path,
			kind: "TTS_AUDIO",
			userId: "example-user",
			organizationId: "example-org",
			conversationId: "example-conversation",
		});
		expect(mocks.uploadFile.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.recordChatMediaObject.mock.invocationCallOrder[0],
		);
		expect(chatMediaProxyUrl(path, "example-org")).toContain(
			`path=${encodeURIComponent(path)}&orgId=example-org`,
		);
	});

	it("deletes the uploaded object and throws a retryable failure when recording fails", async () => {
		mocks.recordChatMediaObject.mockRejectedValueOnce(
			new Error("database unavailable"),
		);

		await expect(
			uploadRecordedChatMedia({
				data: Buffer.from("example"),
				contentType: "image/png",
				extension: "png",
				storageKind: "generated-images",
				recordKind: "GENERATED_IMAGE",
				userId: "example-user",
			}),
		).rejects.toBeInstanceOf(ChatMediaPersistenceError);
		expect(mocks.deleteFile).toHaveBeenCalledWith(
			expect.stringMatching(
				/^example-user\/generated-images\/\d+-[a-z0-9]+\.png$/,
			),
			{ bucket: "chat-documents" },
		);
	});
});

describe("canUseChatMedia", () => {
	it("refuses a private peer object before a downstream download", async () => {
		mocks.resolveChatMediaAccess.mockResolvedValueOnce("deny");

		expect(
			await canUseChatMedia({
				storageKey:
					"example-org/generated-images/1794200000000-abc123xy.png",
				userId: "example-viewer",
				organizationId: "example-org",
			}),
		).toBe(false);
	});

	it("accepts an exact old-worker external API key only with readable pre-cutoff metadata", async () => {
		mocks.resolveChatMediaAccess.mockResolvedValue("deny");
		mocks.isBeforeChatMediaLegacyCutoff
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false)
			.mockResolvedValueOnce(false);
		mocks.getFileMetadata.mockResolvedValueOnce({
			uploadedAt: new Date("2026-11-01T23:59:59Z"),
		});
		const legacyKey =
			"example-org/api-images/123e4567-e89b-12d3-a456-426614174000.png";

		expect(
			await canUseChatMedia({
				storageKey: legacyKey,
				userId: "example-user",
				organizationId: "example-org",
			}),
		).toBe(true);

		mocks.getFileMetadata.mockResolvedValueOnce({
			uploadedAt: new Date("2026-11-02T00:00:00Z"),
		});
		expect(
			await canUseChatMedia({
				storageKey: legacyKey,
				userId: "example-user",
				organizationId: "example-org",
			}),
		).toBe(false);
		expect(mocks.isBeforeChatMediaLegacyCutoff).toHaveBeenNthCalledWith(
			1,
			new Date("2026-11-01T23:59:59Z"),
		);
		expect(mocks.isBeforeChatMediaLegacyCutoff).toHaveBeenNthCalledWith(
			2,
			new Date("2026-11-02T00:00:00Z"),
		);

		mocks.getFileMetadata.mockRejectedValueOnce(new Error("unreadable"));
		expect(
			await canUseChatMedia({
				storageKey: legacyKey,
				userId: "example-user",
				organizationId: "example-org",
			}),
		).toBe(false);
		expect(mocks.isBeforeChatMediaLegacyCutoff).toHaveBeenCalledTimes(2);
	});
});
