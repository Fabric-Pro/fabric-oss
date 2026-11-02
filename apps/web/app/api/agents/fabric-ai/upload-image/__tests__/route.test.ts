import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getSession: vi.fn(),
	uploadFile: vi.fn(),
	getSignedUrl: vi.fn(),
	deleteFile: vi.fn(),
	recordChatMediaObject: vi.fn(),
}));

vi.mock("@repo/config", () => ({
	config: {
		storage: { bucketNames: { chatDocuments: "example-chat-documents" } },
	},
}));

vi.mock("@repo/database", () => ({
	recordChatMediaObject: mocks.recordChatMediaObject,
}));

vi.mock("@repo/storage", () => ({
	uploadFile: mocks.uploadFile,
	getSignedUrl: mocks.getSignedUrl,
	deleteFile: mocks.deleteFile,
}));

vi.mock("@saas/auth/lib/server", () => ({
	getSession: mocks.getSession,
}));

import { POST } from "../route";

const USER_ID = "example-user";
const ORGANIZATION_ID = "example-org";

function request(): NextRequest {
	const form = new FormData();
	form.set("organizationId", ORGANIZATION_ID);
	form.set(
		"file",
		new File([new Uint8Array([1, 2, 3])], "example.png", {
			type: "image/png",
		}),
	);
	return {
		formData: vi.fn().mockResolvedValue(form),
	} as unknown as NextRequest;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getSession.mockResolvedValue({
		user: { id: USER_ID },
		session: { activeOrganizationId: ORGANIZATION_ID },
	});
	mocks.getSignedUrl.mockResolvedValue("https://storage.example/signed");
	mocks.deleteFile.mockResolvedValue(undefined);
});

describe("POST /api/agents/fabric-ai/upload-image", () => {
	it("records the uploaded image before returning its signed URL", async () => {
		const response = await POST(request());
		const payload = await response.json();

		expect(response.status).toBe(200);
		expect(mocks.recordChatMediaObject).toHaveBeenCalledWith({
			storageKey: payload.storagePath,
			kind: "UPLOADED_IMAGE",
			userId: USER_ID,
			organizationId: ORGANIZATION_ID,
			conversationId: null,
		});
		expect(
			mocks.recordChatMediaObject.mock.invocationCallOrder[0],
		).toBeLessThan(mocks.getSignedUrl.mock.invocationCallOrder[0]);
	});

	it("fails closed and best-effort deletes the object when recording fails", async () => {
		mocks.recordChatMediaObject.mockRejectedValueOnce(
			new Error("record unavailable"),
		);

		const response = await POST(request());

		expect(response.status).toBe(500);
		expect(mocks.deleteFile).toHaveBeenCalledWith(
			expect.stringContaining(`${ORGANIZATION_ID}/chat-images/`),
			{ bucket: "example-chat-documents" },
		);
		expect(mocks.getSignedUrl).not.toHaveBeenCalled();
	});
});
