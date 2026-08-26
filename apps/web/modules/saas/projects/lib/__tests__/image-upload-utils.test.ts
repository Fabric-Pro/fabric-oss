/**
 * Unit tests for image-upload-utils.ts
 *
 * Tests validation, compression skipping, S3 key extraction from HTML content,
 * and the uploadToS3 helper.
 */

import { describe, expect, it, vi } from "vitest";

// Mock the orpcClient used by getUploadUrl / resolveImageUrls
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			documents: {
				media: {
					createUploadUrl: vi.fn(),
					resolveUrls: vi.fn(),
				},
			},
		},
	},
}));

import {
	compressImage,
	compressImageToBudget,
	encodedSizeOf,
	exceedsProviderImageBudget,
	extractS3KeysFromContent,
	extractStoryS3KeyFromImgSrc,
	MAX_ENCODED_IMAGE_BYTES,
	MAX_RAW_IMAGE_BYTES,
	validateImageFile,
} from "../image-upload-utils";

// Helper to create a mock File
function createMockFile(name: string, size: number, type: string): File {
	const buffer = new ArrayBuffer(size);
	return new File([buffer], name, { type });
}

describe("validateImageFile", () => {
	it("accepts a valid PNG under 5 MB", () => {
		const file = createMockFile("photo.png", 1024 * 1024, "image/png");
		const result = validateImageFile(file);
		expect(result.valid).toBe(true);
		expect(result.error).toBeUndefined();
	});

	it("accepts a valid JPEG under 5 MB", () => {
		const file = createMockFile("photo.jpg", 2 * 1024 * 1024, "image/jpeg");
		const result = validateImageFile(file);
		expect(result.valid).toBe(true);
	});

	it("accepts a valid GIF under 5 MB", () => {
		const file = createMockFile("anim.gif", 500 * 1024, "image/gif");
		const result = validateImageFile(file);
		expect(result.valid).toBe(true);
	});

	it("accepts a valid WebP under 5 MB", () => {
		const file = createMockFile("photo.webp", 100 * 1024, "image/webp");
		const result = validateImageFile(file);
		expect(result.valid).toBe(true);
	});

	it("rejects files exceeding 5 MB", () => {
		const file = createMockFile("huge.png", 6 * 1024 * 1024, "image/png");
		const result = validateImageFile(file);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("File too large");
	});

	it("rejects exactly at 5 MB boundary + 1 byte", () => {
		const file = createMockFile(
			"edge.png",
			5 * 1024 * 1024 + 1,
			"image/png",
		);
		const result = validateImageFile(file);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("File too large");
	});

	it("accepts exactly at 5 MB boundary", () => {
		const file = createMockFile("edge.png", 5 * 1024 * 1024, "image/png");
		const result = validateImageFile(file);
		expect(result.valid).toBe(true);
	});

	it("rejects SVG files", () => {
		const file = createMockFile("icon.svg", 1024, "image/svg+xml");
		const result = validateImageFile(file);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Unsupported image type");
		expect(result.error).toContain("image/svg+xml");
	});

	it("rejects text files", () => {
		const file = createMockFile("readme.txt", 512, "text/plain");
		const result = validateImageFile(file);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Unsupported image type");
	});

	it("rejects PDF files", () => {
		const file = createMockFile("doc.pdf", 2048, "application/pdf");
		const result = validateImageFile(file);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Unsupported image type");
	});

	it("rejects BMP files", () => {
		const file = createMockFile("image.bmp", 4096, "image/bmp");
		const result = validateImageFile(file);
		expect(result.valid).toBe(false);
		expect(result.error).toContain("Unsupported image type");
	});
});

describe("extractS3KeysFromContent", () => {
	it("extracts data-s3-key attributes from HTML", () => {
		const html = `
			<img src="https://example.com/signed-url" data-s3-key="document-media/proj1/doc1/abc123.png" />
			<img src="https://example.com/signed-url2" data-s3-key="document-media/proj1/doc1/def456.jpg" />
		`;
		const keys = extractS3KeysFromContent(html);
		expect(keys).toContain("document-media/proj1/doc1/abc123.png");
		expect(keys).toContain("document-media/proj1/doc1/def456.jpg");
		expect(keys).toHaveLength(2);
	});

	it("extracts S3 keys from src-like paths matching document-media pattern", () => {
		const html = `<img src="document-media/proj1/doc1/img.webp" />`;
		const keys = extractS3KeysFromContent(html);
		expect(keys).toContain("document-media/proj1/doc1/img.webp");
	});

	it("deduplicates identical keys", () => {
		const html = `
			<img data-s3-key="document-media/p/d/same.png" />
			<img data-s3-key="document-media/p/d/same.png" />
		`;
		const keys = extractS3KeysFromContent(html);
		expect(keys).toHaveLength(1);
		expect(keys[0]).toBe("document-media/p/d/same.png");
	});

	it("returns empty array for external URLs without S3 keys", () => {
		const html = `
			<img src="https://example.com/photo.jpg" />
			<img src="https://cdn.example.com/img.png" />
		`;
		const keys = extractS3KeysFromContent(html);
		expect(keys).toHaveLength(0);
	});

	it("returns empty array for empty string", () => {
		expect(extractS3KeysFromContent("")).toHaveLength(0);
	});

	it("returns empty array for HTML with no images", () => {
		const html = "<p>Hello world</p><h1>Title</h1>";
		expect(extractS3KeysFromContent(html)).toHaveLength(0);
	});

	it("handles mixed content with both S3 and external images", () => {
		const html = `
			<img src="https://example.com/photo.jpg" />
			<img src="https://signed.s3.aws.com/x" data-s3-key="document-media/p/d/uploaded.png" />
			<p>Some text</p>
		`;
		const keys = extractS3KeysFromContent(html);
		expect(keys).toContain("document-media/p/d/uploaded.png");
		expect(keys.length).toBeGreaterThanOrEqual(1);
	});
});

/**
 * `compressImage` runs canvas + Image — JSDOM ships them but image decoding
 * is a no-op stub, so for the "needs downscale" case we bypass decoding by
 * providing a fake Image source via a setTimeout-driven onload trigger.
 *
 * Coverage targets per spec §9 (Vitest unit tests for image-upload-utils):
 *   - GIF pass-through (animation preserved)
 *   - Small-file pass-through (< MAX/2)
 *   - Already-within-2000px pass-through
 *   - Downscaling path (>2000px on longest side → resized File returned)
 */
describe("compressImage", () => {
	// JSDOM in Node lacks URL.createObjectURL / revokeObjectURL — stub for
	// the dimension-based branches that go past the GIF/small-file early
	// returns. Restored after each test to avoid polluting other suites.
	const installUrlStubs = (): (() => void) => {
		const originalCreate = (
			global.URL as unknown as { createObjectURL?: unknown }
		).createObjectURL;
		const originalRevoke = (
			global.URL as unknown as { revokeObjectURL?: unknown }
		).revokeObjectURL;
		(
			global.URL as unknown as { createObjectURL: () => string }
		).createObjectURL = () => "blob:mock";
		(
			global.URL as unknown as { revokeObjectURL: () => void }
		).revokeObjectURL = () => undefined;
		return () => {
			(
				global.URL as unknown as { createObjectURL?: unknown }
			).createObjectURL = originalCreate;
			(
				global.URL as unknown as { revokeObjectURL?: unknown }
			).revokeObjectURL = originalRevoke;
		};
	};

	it("returns the original GIF unchanged (preserves animation)", async () => {
		const file = createMockFile("anim.gif", 4 * 1024 * 1024, "image/gif");
		const result = await compressImage(file);
		expect(result).toBe(file);
	});

	it("returns small files (< 2.5MB) without compression", async () => {
		const file = createMockFile("small.png", 100 * 1024, "image/png");
		const result = await compressImage(file);
		expect(result).toBe(file);
	});

	it("returns the original file when dimensions are within 2000px", async () => {
		const file = createMockFile("medium.png", 3 * 1024 * 1024, "image/png");

		const restoreUrl = installUrlStubs();
		const originalImage = global.Image;
		// JSDOM's Image never fires onload because no decoder runs. Stub it
		// so onload fires with width/height ≤ 2000 (within limits → return
		// original file unchanged).
		class StubImage {
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			width = 1500;
			height = 1000;
			set src(_value: string) {
				queueMicrotask(() => this.onload?.());
			}
		}
		(global as unknown as { Image: typeof Image }).Image =
			StubImage as unknown as typeof Image;

		try {
			const result = await compressImage(file);
			expect(result).toBe(file);
		} finally {
			global.Image = originalImage;
			restoreUrl();
		}
	});

	it("downscales when image dimensions exceed 2000px on the longest side", async () => {
		const file = createMockFile("huge.png", 3 * 1024 * 1024, "image/png");

		const restoreUrl = installUrlStubs();
		const originalImage = global.Image;
		class StubImage {
			onload: (() => void) | null = null;
			onerror: (() => void) | null = null;
			width = 4000;
			height = 2000;
			set src(_value: string) {
				queueMicrotask(() => this.onload?.());
			}
		}
		(global as unknown as { Image: typeof Image }).Image =
			StubImage as unknown as typeof Image;

		// JSDOM canvas.toBlob calls back with a small Blob — capture the
		// call to assert the canvas was resized to 2000 on the longest side.
		const recordedCanvases: HTMLCanvasElement[] = [];
		const originalCreate = global.document.createElement.bind(
			global.document,
		);
		const createSpy = vi
			.spyOn(global.document, "createElement")
			.mockImplementation((tag: string) => {
				const element = originalCreate(tag);
				if (tag === "canvas") {
					const canvas = element as HTMLCanvasElement;
					recordedCanvases.push(canvas);
					// JSDOM ships canvas without a 2D context — stub one so
					// `compressImage` proceeds to `toBlob` instead of bailing
					// at the `if (!ctx)` early return.
					canvas.getContext = (() => ({
						drawImage: () => undefined,
					})) as unknown as HTMLCanvasElement["getContext"];
					canvas.toBlob = (cb: BlobCallback) => {
						// Hand back a tiny Blob — file becomes "smaller", so
						// `compressImage` returns the compressed File.
						queueMicrotask(() =>
							cb(new Blob(["x"], { type: "image/png" })),
						);
					};
				}
				return element;
			});

		try {
			const result = await compressImage(file);
			// Canvas must have been resized to 2000 on the longest side
			// (width=4000 → 2000; height=2000 → 1000 to keep aspect).
			expect(recordedCanvases.length).toBeGreaterThanOrEqual(1);
			const canvas = recordedCanvases[0];
			expect(canvas.width).toBe(2000);
			expect(canvas.height).toBe(1000);
			// Result is a new File with the same name and MIME, smaller than
			// original.
			expect(result).not.toBe(file);
			expect(result.name).toBe("huge.png");
			expect(result.type).toBe("image/png");
			expect(result.size).toBeLessThan(file.size);
		} finally {
			createSpy.mockRestore();
			global.Image = originalImage;
			restoreUrl();
		}
	});
});

describe("extractStoryS3KeyFromImgSrc", () => {
	it("returns null for empty string", () => {
		expect(extractStoryS3KeyFromImgSrc("")).toBeNull();
	});

	it("returns null when src has no story-media segment", () => {
		expect(
			extractStoryS3KeyFromImgSrc("https://example.com/img/foo.png"),
		).toBeNull();
	});

	it("extracts a bare key (markdown insertion form)", () => {
		// This is the shape `appendAttachmentsSection` writes into description:
		// `![alt](story-media/p/s/uuid.png)` — TipTap parses to <img src=BARE>.
		expect(extractStoryS3KeyFromImgSrc("story-media/p1/s1/uuid.png")).toBe(
			"story-media/p1/s1/uuid.png",
		);
	});

	it("extracts a root-relative key (legacy)", () => {
		expect(extractStoryS3KeyFromImgSrc("/story-media/p1/s1/uuid.png")).toBe(
			"story-media/p1/s1/uuid.png",
		);
	});

	it("extracts a key from a full signed URL and strips the query string", () => {
		expect(
			extractStoryS3KeyFromImgSrc(
				"https://bucket.s3.amazonaws.com/story-media/p1/s1/uuid.png?Sig=abc&Exp=1234",
			),
		).toBe("story-media/p1/s1/uuid.png");
	});

	it("does NOT match document-media (different keyspace)", () => {
		expect(
			extractStoryS3KeyFromImgSrc("/document-media/p1/d1/uuid.png"),
		).toBeNull();
	});

	it("treats `story-media` inside a longer path correctly", () => {
		expect(
			extractStoryS3KeyFromImgSrc(
				"/projects/{p}/stories/story-media/p1/s1/uuid.png",
			),
		).toBe("story-media/p1/s1/uuid.png");
	});

	it('stops at `?` and `"` to keep the canonical key', () => {
		// The capture must not include the query string OR a trailing quote.
		const result = extractStoryS3KeyFromImgSrc(
			"story-media/p1/s1/uuid.png?x=1",
		);
		expect(result).toBe("story-media/p1/s1/uuid.png");
		expect(result).not.toContain("?");
	});

	it("recovers the canonical key from the literal staging-incident shape", () => {
		// Regression guard for the exact `src` form TipTap produced from a
		// markdown insertion before this fix: a bare `story-media/...` value
		// that the browser resolved as a relative path against the current
		// page URL, yielding the broken-image 404 captured on staging
		// (story F-006). Grep-friendly so a future incident search lands here.
		expect(
			extractStoryS3KeyFromImgSrc(
				"story-media/cmn7n36yi000004jra0f71zud/cmpgtfjeb001304lbckamfzk3/1779448061651_r7q4vjab.png",
			),
		).toBe(
			"story-media/cmn7n36yi000004jra0f71zud/cmpgtfjeb001304lbckamfzk3/1779448061651_r7q4vjab.png",
		);
	});

	it("matches cross-origin URLs (host-agnostic by design) — server-side authz still gates", () => {
		// Documents the SECURITY NOTE in the helper's JSDoc: the regex
		// captures the key regardless of host, because the resolver does
		// not care about the CDN/bucket-host (only the keyspace pattern).
		// `resolveStoryImageUrls` server-side rejects any key outside the
		// authenticated story's `story-media/{projectId}/{userStoryId}/`
		// prefix — that is the actual authorization gate.
		expect(
			extractStoryS3KeyFromImgSrc(
				"https://other.example.com/story-media/p1/s1/uuid.png",
			),
		).toBe("story-media/p1/s1/uuid.png");
	});
});

/**
 * Images reach the model base64-encoded, which costs 4 bytes for every 3. A
 * file that clears the 5 MB upload cap therefore arrives at the provider as
 * ~6.7 MB and is refused — and that refusal surfaces later, as a failed AI
 * request rather than as feedback on the attachment.
 */
describe("provider image budget", () => {
	const MB = 1024 * 1024;

	it("accounts for base64 inflation", () => {
		expect(encodedSizeOf(3)).toBe(4);
		expect(encodedSizeOf(3 * MB)).toBe(4 * MB);
	});

	it("flags a file that passes the 5 MB upload cap but fails once encoded", () => {
		// The exact trap: under the app's own limit, over the provider's.
		const raw = 4.5 * MB;
		expect(raw).toBeLessThan(5 * MB);
		expect(encodedSizeOf(raw)).toBeGreaterThan(MAX_ENCODED_IMAGE_BYTES);
		expect(exceedsProviderImageBudget(raw)).toBe(true);
	});

	it("passes a file that fits once encoded", () => {
		expect(exceedsProviderImageBudget(2.79 * MB)).toBe(false);
	});

	it("derives a raw ceiling that survives encoding", () => {
		expect(exceedsProviderImageBudget(MAX_RAW_IMAGE_BYTES)).toBe(false);
		expect(exceedsProviderImageBudget(MAX_RAW_IMAGE_BYTES + 1024)).toBe(
			true,
		);
	});
});

describe("compressImageToBudget", () => {
	const MB = 1024 * 1024;

	it("passes an already-small image straight through, untouched", async () => {
		const file = createMockFile("small.png", 512 * 1024, "image/png");
		const out = await compressImageToBudget(file);
		expect(out.withinBudget).toBe(true);
		expect(out.file).toBe(file);
	});

	it("reports an oversized GIF as over budget instead of destroying it", async () => {
		// Canvas re-encoding drops the animation, so an oversized GIF is a
		// rejection to surface — never a silent resize.
		const file = createMockFile("anim.gif", 4.5 * MB, "image/gif");
		const out = await compressImageToBudget(file);
		expect(out.withinBudget).toBe(false);
		expect(out.file).toBe(file);
	});
});
