/**
 * The ADO attachment upload (`uploadAdoImageAttachments`) on a rejected PAT.
 *
 * Azure DevOps answers an invalid or expired PAT with HTTP 203 and an HTML
 * sign-in page, and `Response.ok` is true for 203. The upload must treat it
 * as the failed upload a 401 is: keep the original `src` and log the failure,
 * never read the body as an attachment record.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn, error: vi.fn(), log: vi.fn() },
}));

vi.mock("@repo/storage", () => ({
	getStorageProvider: vi.fn(() => ({ getSignedUrl: vi.fn() })),
}));

vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { projectContexts: "test-bucket" } } },
}));

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

import { uploadAdoImageAttachments } from "../story-sync-media";

const target = { pat: "PAT", org: "example-org" };
const image = {
	src: "https://images.example.com/shot.png",
	alt: "shot.png",
	s3Key: null,
};
const ATTACHMENT_URL =
	"https://dev.azure.com/example-org/_apis/wit/attachments/abc12345-0000-0000-0000-000000000001";

function sourceImage() {
	return new Response(new Uint8Array([137, 80, 78, 71]), {
		status: 200,
		headers: { "content-type": "image/png" },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mockFetch.mockReset();
});

describe("uploadAdoImageAttachments — rejected PAT", () => {
	it("rewrites the src to the attachment URL on a 201", async () => {
		mockFetch.mockResolvedValueOnce(sourceImage()).mockResolvedValueOnce(
			new Response(JSON.stringify({ id: "a", url: ATTACHMENT_URL }), {
				status: 201,
			}),
		);

		const out = await uploadAdoImageAttachments([image], target);

		expect(out[0].src).toBe(ATTACHMENT_URL);
	});

	it("keeps the original src and logs a failed upload on ADO's 203 sign-in page", async () => {
		// The body is a valid attachment record: only the status can reject it.
		mockFetch.mockResolvedValueOnce(sourceImage()).mockResolvedValueOnce(
			new Response(JSON.stringify({ id: "a", url: ATTACHMENT_URL }), {
				status: 203,
				headers: { "content-type": "text/html" },
			}),
		);

		const out = await uploadAdoImageAttachments([image], target);

		expect(out[0].src).toBe(image.src);
		expect(warn).toHaveBeenCalledWith(
			"[ADO Attachments] Upload failed",
			expect.objectContaining({ status: 203 }),
		);
	});

	it("does not read an HTML sign-in body (no 'Upload threw')", async () => {
		mockFetch.mockResolvedValueOnce(sourceImage()).mockResolvedValueOnce(
			new Response("<html>sign in</html>", {
				status: 203,
				headers: { "content-type": "text/html" },
			}),
		);

		const out = await uploadAdoImageAttachments([image], target);

		expect(out[0].src).toBe(image.src);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0][0]).toBe("[ADO Attachments] Upload failed");
	});

	it("a real 401 takes the same failed-upload path", async () => {
		mockFetch
			.mockResolvedValueOnce(sourceImage())
			.mockResolvedValueOnce(
				new Response("unauthorized", { status: 401 }),
			);

		const out = await uploadAdoImageAttachments([image], target);

		expect(out[0].src).toBe(image.src);
		expect(warn).toHaveBeenCalledWith(
			"[ADO Attachments] Upload failed",
			expect.objectContaining({ status: 401 }),
		);
	});
});
