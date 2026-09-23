/**
 * The vision loader is the only path from an attached image to a model's
 * pixels. The Orchestrator chat now creates chat documents for a turn's images
 * (Fizzy #2040, F35) — this pins what the loader will and will not resolve:
 * only the caller's own documents, in the run's tenant, and only images.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
const downloadFile = vi.fn();

vi.mock("@repo/database", () => ({ db: { chatDocument: { findMany } } }));
vi.mock("@repo/storage", () => ({ downloadFile }));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { chatDocuments: "chat-docs" } } },
}));
vi.mock("@repo/logs", () => ({ logger: { warn: vi.fn() } }));

const { resolveImageAttachments } = await import("../vision-image-attachments");

beforeEach(() => {
	findMany.mockReset();
	downloadFile.mockReset();
	downloadFile.mockResolvedValue({ data: Buffer.from([1, 2, 3]) });
});

describe("resolveImageAttachments", () => {
	it("scopes the lookup to the caller, the organization and image MIME types", async () => {
		findMany.mockResolvedValue([
			{
				id: "doc-1",
				filename: "a.png",
				mimeType: "image/png",
				s3Path: "org-1/a.png",
			},
		]);

		const result = await resolveImageAttachments(
			["doc-1", "doc-2"],
			"user-1",
			"org-1",
		);

		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: { in: ["doc-1", "doc-2"] },
					userId: "user-1",
					organizationId: "org-1",
					mimeType: { startsWith: "image/" },
				},
			}),
		);
		expect(downloadFile).toHaveBeenCalledWith("org-1/a.png", {
			bucket: "chat-docs",
		});
		expect(result).toEqual([
			{
				filename: "a.png",
				mediaType: "image/png",
				bytes: new Uint8Array([1, 2, 3]),
			},
		]);
	});

	it("never matches another tenant's rows when no organization is given", async () => {
		findMany.mockResolvedValue([]);

		await resolveImageAttachments(["doc-1"], "user-1");

		expect(findMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ organizationId: null }),
			}),
		);
	});

	it("skips an image whose download fails and keeps the others", async () => {
		findMany.mockResolvedValue([
			{ id: "d1", filename: "a.png", mimeType: "image/png", s3Path: "a" },
			{
				id: "d2",
				filename: "b.webp",
				mimeType: "image/webp",
				s3Path: "b",
			},
		]);
		downloadFile
			.mockRejectedValueOnce(new Error("gone"))
			.mockResolvedValueOnce({ data: Buffer.from([9]) });

		const result = await resolveImageAttachments(
			["d1", "d2"],
			"user-1",
			"org-1",
		);

		expect(result.map((r) => r.mediaType)).toEqual(["image/webp"]);
	});

	it("does not query at all for an empty list", async () => {
		expect(await resolveImageAttachments([], "user-1", "org-1")).toEqual(
			[],
		);
		expect(findMany).not.toHaveBeenCalled();
	});
});
