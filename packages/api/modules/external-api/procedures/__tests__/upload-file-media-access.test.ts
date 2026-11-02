import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	uploadFile: vi.fn(),
	deleteFile: vi.fn(),
	recordChatMediaObject: vi.fn(),
	resolveChatMediaAccess: vi.fn(),
	isBeforeChatMediaLegacyCutoff: vi.fn(),
	getFileMetadata: vi.fn(),
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { chatDocuments: "example-chat-documents" } },
	},
}));
vi.mock("@repo/database", () => ({
	buildChatMediaStorageKey: ({
		ownerPrefix,
		kind,
		extension,
		hash,
	}: Record<string, string>) =>
		`${ownerPrefix}/${kind}/1794200000000-${hash}.${extension}`,
	recordChatMediaObject: mocks.recordChatMediaObject,
	resolveChatMediaAccess: mocks.resolveChatMediaAccess,
	isBeforeChatMediaLegacyCutoff: mocks.isBeforeChatMediaLegacyCutoff,
}));
vi.mock("@repo/storage", () => ({
	uploadFile: mocks.uploadFile,
	deleteFile: mocks.deleteFile,
	getFileMetadata: mocks.getFileMetadata,
}));

import { handleFileUpload, validateFileIdAccess } from "../upload-file";

const context = {
	userId: "example-user",
	organizationId: "example-org",
} as never;

beforeEach(() => {
	vi.clearAllMocks();
	mocks.resolveChatMediaAccess.mockResolvedValue("allow");
	mocks.isBeforeChatMediaLegacyCutoff.mockResolvedValue(false);
});

describe("handleFileUpload", () => {
	it("records a new external API image before returning its file id", async () => {
		const result = await handleFileUpload(
			new File([new Uint8Array([1, 2, 3])], "example.png", {
				type: "image/png",
			}),
			context,
		);

		expect(result.status).toBe(200);
		expect(mocks.recordChatMediaObject).toHaveBeenCalledWith({
			storageKey: expect.stringMatching(
				/^example-org\/chat-images\/1794200000000-[a-f0-9]+\.png$/,
			),
			kind: "UPLOADED_IMAGE",
			userId: "example-user",
			organizationId: "example-org",
			conversationId: null,
		});
	});

	it("fails closed and deletes the object when recording fails", async () => {
		mocks.recordChatMediaObject.mockRejectedValueOnce(
			new Error("unavailable"),
		);

		const result = await handleFileUpload(
			new File([new Uint8Array([1])], "example.png", {
				type: "image/png",
			}),
			context,
		);

		expect(result).toMatchObject({ status: 500, error: "unavailable" });
		expect(mocks.deleteFile).toHaveBeenCalledOnce();
	});
});

describe("validateFileIdAccess", () => {
	it("refuses a tenant-prefixed image when its live media decision denies it", async () => {
		mocks.resolveChatMediaAccess.mockResolvedValueOnce("deny");
		const path = "example-org/chat-images/1794200000000-abc123xy.png";

		expect(
			await validateFileIdAccess(
				Buffer.from(path).toString("base64url"),
				context,
			),
		).toEqual({ valid: false, error: "File is not accessible" });
	});

	it("allows only the exact pre-cutoff external API legacy shape", async () => {
		mocks.resolveChatMediaAccess.mockResolvedValue("deny");
		mocks.isBeforeChatMediaLegacyCutoff.mockResolvedValueOnce(true);
		mocks.getFileMetadata.mockResolvedValue({
			uploadedAt: new Date("2026-11-07T23:59:59Z"),
		});
		const legacyPath =
			"example-org/api-images/123e4567-e89b-12d3-a456-426614174000.png";

		expect(
			await validateFileIdAccess(
				Buffer.from(legacyPath).toString("base64url"),
				context,
			),
		).toEqual({ valid: true, storagePath: legacyPath });
		expect(mocks.isBeforeChatMediaLegacyCutoff).toHaveBeenCalledWith(
			new Date("2026-11-07T23:59:59Z"),
		);
		expect(
			await validateFileIdAccess(
				Buffer.from("example-org/api-images/private.png").toString(
					"base64url",
				),
				context,
			),
		).toEqual({ valid: false, error: "File is not accessible" });
	});
});
