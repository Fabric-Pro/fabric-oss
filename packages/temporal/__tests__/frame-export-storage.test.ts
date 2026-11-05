import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	upload: vi.fn(),
	sign: vi.fn(),
	remove: vi.fn(),
	read: vi.fn(),
	signal: new AbortController(),
	id: "frame-export-v2-11111111111111111111111111111111-11111111-1111-4111-8111-111111111111",
}));
vi.mock("@repo/storage", () => ({
	uploadFile: m.upload,
	getSignedUrl: m.sign,
	deleteFile: m.remove,
}));
vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => ({
			cancellationSignal: m.signal.signal,
			info: { workflowExecution: { workflowId: m.id } },
		}),
	},
}));
vi.mock("../src/activities/frame-export/get-frame-content", () => ({
	getFrameContentActivity: m.read,
}));

import {
	deleteFrameExportActivity,
	uploadToS3Activity,
} from "../src/activities/frame-export/upload-to-s3";

const actor = {
	frameId: "example-frame",
	userId: "example-user",
	organizationId: "example-org",
	expectedUpdatedAt: "2026-11-01T00:00:00Z",
};
const key = () =>
	`exports/frames-managed/${createHash("sha256").update(JSON.stringify(actor.organizationId)).digest("hex").slice(0, 32)}/${m.id}.pdf`;
const input = () => ({
	buffer: Buffer.from("%PDF-example"),
	key: key(),
	contentType: "application/pdf",
	managed: {
		...actor,
		expiresAt: new Date(Date.now() + 3600000).toISOString(),
	},
});
beforeEach(() => {
	vi.clearAllMocks();
	m.signal = new AbortController();
	m.read.mockResolvedValue({});
	m.upload.mockResolvedValue({});
	m.remove.mockResolvedValue(undefined);
});
it("uploads privately under the fixed job identity after live read/revision validation without issuing a bearer", async () => {
	expect(await uploadToS3Activity(input())).toBe(key());
	expect(m.read).toHaveBeenCalledWith(expect.objectContaining(actor));
	expect(m.upload).toHaveBeenCalledWith(
		key(),
		expect.any(Buffer),
		expect.objectContaining({
			access: "private",
			contentType: "application/pdf",
		}),
	);
	expect(m.sign).not.toHaveBeenCalled();
});
it("refuses another job, organization, arbitrary key and expired artifact before upload", async () => {
	for (const edit of [
		{ key: "exports/other.pdf" },
		{ key: key().replace("example", "other") + "suffix" },
		{
			managed: {
				...input().managed,
				organizationId: "example-other-org",
			},
		},
		{ managed: { ...input().managed, expiresAt: "2020-01-01T00:00:00Z" } },
	]) {
		await expect(
			uploadToS3Activity({ ...input(), ...edit }),
		).rejects.toMatchObject({ nonRetryable: true });
	}
	expect(m.upload).not.toHaveBeenCalled();
});
it("refuses a revoked reader and a cancellation that arrives during permission read", async () => {
	m.read.mockRejectedValueOnce(new Error("Access revoked"));
	await expect(uploadToS3Activity(input())).rejects.toThrow("Access revoked");
	m.read.mockImplementationOnce(async () => {
		m.signal.abort();
	});
	await expect(uploadToS3Activity(input())).rejects.toThrow();
	expect(m.upload).not.toHaveBeenCalled();
});
it("deletes only its own managed object and tolerates repeated cleanup", async () => {
	await deleteFrameExportActivity({ key: key() });
	await deleteFrameExportActivity({ key: key() });
	expect(m.remove).toHaveBeenCalledTimes(2);
	await expect(
		deleteFrameExportActivity({ key: "../example.pdf" }),
	).rejects.toMatchObject({ type: "FRAME_EXPORT_INVALID" });
});
