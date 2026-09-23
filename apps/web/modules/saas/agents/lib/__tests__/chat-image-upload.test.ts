import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Pasted/dropped images skipped the shaping the paperclip applies, and the
 * orchestrator's upload hid why an image failed (review F37).
 */
const prepareImageForAi = vi.fn();
const toastError = vi.fn();
vi.mock("@saas/projects/lib/image-upload-utils", () => ({
	prepareImageForAi: (file: File) => prepareImageForAi(file),
}));
vi.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m) } }));

const { describeImageUploadFailure, shapePastedImageForAi } = await import(
	"../chat-image-upload"
);
const { CHAT_IMAGE_UPLOAD_MAX_BYTES } = await import(
	"../chat-image-upload-limit"
);

beforeEach(() => {
	prepareImageForAi.mockReset();
	toastError.mockReset();
});

describe("shapePastedImageForAi", () => {
	it("returns the shaped file, as the paperclip path does", async () => {
		const raw = new File(["raw"], "shot.png", { type: "image/png" });
		const shaped = new File(["s"], "shot.jpg", { type: "image/jpeg" });
		prepareImageForAi.mockResolvedValue({ ok: true, file: shaped });

		await expect(shapePastedImageForAi(raw)).resolves.toBe(shaped);
		expect(prepareImageForAi).toHaveBeenCalledWith(raw);
	});

	it("refuses an image it cannot bring within budget, and says why", async () => {
		prepareImageForAi.mockResolvedValue({
			ok: false,
			error: '"shot.png" is too detailed to send to the AI',
		});

		await expect(
			shapePastedImageForAi(new File(["raw"], "shot.png")),
		).resolves.toBeNull();
		expect(toastError).toHaveBeenCalledWith(
			'"shot.png" is too detailed to send to the AI',
		);
	});
});

describe("describeImageUploadFailure", () => {
	it("explains the hosting platform's non-JSON 413", () => {
		expect(describeImageUploadFailure(413, null, "shot.png")).toMatch(
			/shot\.png.*larger than 4 MB/,
		);
	});

	it("shows the route's own message", () => {
		expect(
			describeImageUploadFailure(
				400,
				{ error: "Unsupported file type: image/tiff" },
				"a.tiff",
			),
		).toBe("Couldn't upload a.tiff: Unsupported file type: image/tiff");
	});

	it("stays below the hosting body limit", () => {
		expect(CHAT_IMAGE_UPLOAD_MAX_BYTES).toBeLessThan(4.5 * 1024 * 1024);
	});
});
