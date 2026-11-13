import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compressImage } from "../image-upload-utils";
import { prepareNewsletterImage } from "../newsletter-image-prepare";
import { NEWSLETTER_IMAGE_UPLOAD_MAX_BYTES } from "../newsletter-review-images";

vi.mock("../image-upload-utils", () => ({
	compressImage: vi.fn(),
}));

const compress = vi.mocked(compressImage);

interface PixelSize {
	width: number;
	height: number;
}

/** Pixel size the fake decoder reports; a file without one fails to decode. */
const sizeByFile = new Map<Blob | MediaSource, PixelSize>();
const sizeByUrl = new Map<string, PixelSize>();

class FakeImage {
	onload: (() => void) | null = null;
	onerror: (() => void) | null = null;
	naturalWidth = 0;
	naturalHeight = 0;

	set src(url: string) {
		const size = sizeByUrl.get(url);
		queueMicrotask(() => {
			if (!size) {
				this.onerror?.();
				return;
			}
			this.naturalWidth = size.width;
			this.naturalHeight = size.height;
			this.onload?.();
		});
	}
}

function imageFile(bytes: number, type: string, size: PixelSize | null): File {
	const file = new File([new Uint8Array(bytes)], "screen", { type });
	if (size) {
		sizeByFile.set(file, size);
	}
	return file;
}

beforeEach(() => {
	let next = 0;
	vi.stubGlobal("Image", FakeImage);
	vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
		const url = `blob:test-${next++}`;
		const size = sizeByFile.get(blob);
		if (size) {
			sizeByUrl.set(url, size);
		}
		return url;
	});
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
	compress.mockReset();
	sizeByUrl.clear();
	sizeByFile.clear();
});

const OVER = NEWSLETTER_IMAGE_UPLOAD_MAX_BYTES + 1;

describe("prepareNewsletterImage", () => {
	it("accepts a light image wider than the downscale target unchanged", async () => {
		const file = imageFile(15_000, "image/png", {
			width: 1600,
			height: 900,
		});

		const result = await prepareNewsletterImage(file);

		expect(result).toEqual({
			ok: true,
			file,
			contentType: "image/png",
			width: 1600,
			height: 900,
		});
		expect(compress).not.toHaveBeenCalled();
	});

	it("keeps a heavy PNG a PNG when the downscale is enough", async () => {
		const file = imageFile(OVER, "image/png", {
			width: 2400,
			height: 1200,
		});
		const scaled = imageFile(100_000, "image/png", {
			width: 1200,
			height: 600,
		});
		compress.mockResolvedValueOnce(scaled);

		const result = await prepareNewsletterImage(file);

		expect(result).toMatchObject({
			ok: true,
			file: scaled,
			contentType: "image/png",
			width: 1200,
		});
		expect(compress).toHaveBeenCalledTimes(1);
		expect(compress).toHaveBeenCalledWith(file, {
			maxDimension: 1200,
			force: true,
		});
	});

	it("caps the width, not the height, of a tall image", async () => {
		const file = imageFile(OVER, "image/png", {
			width: 1500,
			height: 3000,
		});
		compress.mockResolvedValueOnce(
			imageFile(100_000, "image/png", { width: 1200, height: 2400 }),
		);

		await prepareNewsletterImage(file);

		expect(compress).toHaveBeenCalledWith(file, {
			maxDimension: 2400,
			force: true,
		});
	});

	it("re-encodes as JPEG at falling quality until the image fits", async () => {
		const file = imageFile(OVER + 100, "image/png", {
			width: 2400,
			height: 1200,
		});
		const jpeg = imageFile(200_000, "image/jpeg", {
			width: 1200,
			height: 600,
		});
		compress
			.mockResolvedValueOnce(file)
			.mockResolvedValueOnce(imageFile(OVER, "image/jpeg", null))
			.mockResolvedValueOnce(jpeg);

		const result = await prepareNewsletterImage(file);

		expect(result).toMatchObject({
			ok: true,
			file: jpeg,
			contentType: "image/jpeg",
		});
		expect(compress.mock.calls.slice(1).map(([, o]) => o?.quality)).toEqual(
			[0.85, 0.75],
		);
	});

	it("reports too_large when no encoding fits", async () => {
		const file = imageFile(OVER, "image/jpeg", {
			width: 2400,
			height: 1200,
		});
		compress.mockResolvedValue(file);

		expect(await prepareNewsletterImage(file)).toEqual({
			ok: false,
			code: "too_large",
		});
	});

	it("reports another file type as unsupported without decoding it", async () => {
		const file = imageFile(10, "image/gif", null);

		expect(await prepareNewsletterImage(file)).toEqual({
			ok: false,
			code: "unsupported",
		});
		expect(URL.createObjectURL).not.toHaveBeenCalled();
	});

	it("reports an image the browser cannot decode as unsupported", async () => {
		const file = imageFile(10, "image/png", null);

		expect(await prepareNewsletterImage(file)).toEqual({
			ok: false,
			code: "unsupported",
		});
	});
});
