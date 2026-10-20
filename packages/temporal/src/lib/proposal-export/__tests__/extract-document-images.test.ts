import sharp from "sharp";
import { beforeAll, describe, expect, it, vi } from "vitest";

// The module's default reader imports both at load; every test injects its
// own reader, so neither is ever called.
vi.mock("@repo/storage", () => ({
	downloadFile: vi.fn(async () => {
		throw new Error("the default reader is not used in these tests");
	}),
}));
vi.mock("@repo/config", () => ({
	config: { storage: { bucketNames: { projectContexts: "example-bucket" } } },
}));

import {
	createExportImageBudget,
	type ExportImageReader,
	extractDocumentImages,
	uploadedImageKeys,
} from "../extract-document-images";
import { prepareExportMarkdown } from "../markdown";

const PROJECT = "project-example-1";
const DOCUMENT = "document-example-1";

function mediaKey(name: string, documentId = DOCUMENT): string {
	return `document-media/${PROJECT}/${documentId}/${name}`;
}

function imageTag(key: string): string {
	return `<img src="https://example.com/signed/image.png" alt="Example chart" width="320" data-s3-key="${key}" data-caption="Example caption" />`;
}

let png: Buffer;
let jpeg: Buffer;
let gif: Buffer;

beforeAll(async () => {
	const create = (alpha: boolean) =>
		sharp({
			create: {
				width: 40,
				height: 30,
				channels: alpha ? 4 : 3,
				background: alpha
					? { r: 10, g: 120, b: 200, alpha: 0.5 }
					: { r: 10, g: 120, b: 200 },
			},
		});
	png = await create(true).png().toBuffer();
	jpeg = await create(false).jpeg().toBuffer();
	gif = await create(true).gif().toBuffer();
});

/** A reader over an in-memory bucket that records every key it was asked for. */
function fakeReader(objects: Record<string, Buffer>): {
	read: ExportImageReader;
	reads: string[];
} {
	const reads: string[] = [];
	return {
		reads,
		read: async (key) => {
			reads.push(key);
			const bytes = objects[key];
			if (!bytes) {
				throw new Error("NoSuchKey");
			}
			return bytes;
		},
	};
}

function prepared(markdown: string) {
	return prepareExportMarkdown(markdown).root;
}

describe("uploadedImageKeys", () => {
	it("finds uploaded images anywhere in the tree, once each, in order, and never Markdown images", () => {
		const root = prepared(
			[
				"# Example Proposal",
				"",
				imageTag(mediaKey("a.png")),
				"",
				`> ${imageTag(mediaKey("b.png"))}`,
				"",
				`- item ${imageTag(mediaKey("c.png"))}`,
				"",
				"| Col |",
				"| --- |",
				`| ${imageTag(mediaKey("d.png"))} |`,
				"",
				imageTag(mediaKey("a.png")),
				"",
				`![markdown image](${mediaKey("e.png")})`,
			].join("\n"),
		);

		expect(uploadedImageKeys(root)).toEqual([
			mediaKey("a.png"),
			mediaKey("b.png"),
			mediaKey("c.png"),
			mediaKey("d.png"),
		]);
	});
});

describe("extractDocumentImages", () => {
	it("reads each of the document's own images once and re-encodes it", async () => {
		const reader = fakeReader({
			[mediaKey("photo.jpg")]: jpeg,
			[mediaKey("logo.png")]: png,
			[mediaKey("anim.gif")]: gif,
		});
		const onImage = vi.fn();

		const result = await extractDocumentImages({
			root: prepared(
				[
					imageTag(mediaKey("photo.jpg")),
					"",
					imageTag(mediaKey("logo.png")),
					"",
					imageTag(mediaKey("photo.jpg")),
					"",
					imageTag(mediaKey("anim.gif")),
				].join("\n"),
			),
			projectId: PROJECT,
			documentId: DOCUMENT,
			read: reader.read,
			onImage,
		});

		expect(reader.reads).toEqual([
			mediaKey("photo.jpg"),
			mediaKey("logo.png"),
			mediaKey("anim.gif"),
		]);
		expect(onImage).toHaveBeenCalledTimes(3);
		expect(result.warnings).toEqual([]);
		expect(result.images.get(mediaKey("photo.jpg"))).toMatchObject({
			mimeType: "image/jpeg",
			width: 40,
			height: 30,
		});
		expect(result.images.get(mediaKey("logo.png"))?.mimeType).toBe(
			"image/png",
		);
		expect(["image/png", "image/jpeg"]).toContain(
			result.images.get(mediaKey("anim.gif"))?.mimeType,
		);
	});

	it("reads an image whose alt and caption hold < and >, and counts a refused stored-image tag as dropped", async () => {
		const shown = mediaKey("shown.png");
		const refused = mediaKey("refused.png");
		const reader = fakeReader({ [shown]: png, [refused]: png });

		const result = await extractDocumentImages({
			root: prepared(
				[
					`<img src="https://example.com/a.png" alt="Before -> after" data-s3-key="${shown}" data-caption="1 < 2" />`,
					`<img src="https://example.com/b.png" alt="x" data-s3-key="${refused}" data-s3-key="${refused}" />`,
				].join("\n\n"),
			),
			projectId: PROJECT,
			documentId: DOCUMENT,
			read: reader.read,
		});

		expect(reader.reads).toEqual([shown]);
		expect([...result.images.keys()]).toEqual([shown]);
		expect(result.warnings).toEqual([{ code: "IMAGE_DROPPED", count: 1 }]);
	});

	it("counts an image tag the parser could not read, and one with no key, as dropped without reading either", async () => {
		const key = mediaKey("desk.png");
		const reader = fakeReader({ [key]: png });

		const result = await extractDocumentImages({
			root: prepared(
				[
					`<img src="https://example.com/signed/desk.png" alt="27" display.png" data-s3-key="${key}" />`,
					`<img src="https://storage.example.com/${key}?X-Amz-Signature=abc" alt="Desk" />`,
				].join("\n\n"),
			),
			projectId: PROJECT,
			documentId: DOCUMENT,
			read: reader.read,
		});

		expect(reader.reads).toEqual([]);
		expect(result.images.size).toBe(0);
		expect(result.warnings).toEqual([{ code: "IMAGE_DROPPED", count: 2 }]);
	});

	it("never reads a key outside this document's media prefix", async () => {
		const elsewhere = [
			mediaKey("other.png", "document-example-2"),
			`document-media/${PROJECT}/${DOCUMENT}/../document-example-2/x.png`,
			"organization-logos/example-org/logo.png",
		];
		const reader = fakeReader(
			Object.fromEntries(elsewhere.map((key) => [key, png])),
		);

		const result = await extractDocumentImages({
			root: prepared(elsewhere.map(imageTag).join("\n\n")),
			projectId: PROJECT,
			documentId: DOCUMENT,
			read: reader.read,
		});

		expect(reader.reads).toEqual([]);
		expect(result.images.size).toBe(0);
		expect(result.warnings).toEqual([{ code: "IMAGE_DROPPED", count: 3 }]);
	});

	it("drops a missing object, refused bytes and an oversized object, counting each", async () => {
		const svg = Buffer.from(
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
		);
		const big = Buffer.concat([jpeg, Buffer.alloc(4096)]);
		const reader = fakeReader({
			[mediaKey("ok.jpg")]: jpeg,
			[mediaKey("vector.svg")]: svg,
			[mediaKey("big.jpg")]: big,
		});
		const budget = createExportImageBudget(1_000_000);

		const result = await extractDocumentImages({
			root: prepared(
				["ok.jpg", "missing.png", "vector.svg", "big.jpg"]
					.map((name) => imageTag(mediaKey(name)))
					.join("\n\n"),
			),
			projectId: PROJECT,
			documentId: DOCUMENT,
			read: reader.read,
			budget,
			limits: { maxImageBytes: jpeg.byteLength + 100 },
		});

		expect([...result.images.keys()]).toEqual([mediaKey("ok.jpg")]);
		expect(result.warnings).toEqual([{ code: "IMAGE_DROPPED", count: 3 }]);
		// The oversized object is never decoded, so it is not charged.
		expect(budget.remainingBytes).toBe(
			1_000_000 - jpeg.byteLength - svg.byteLength,
		);
		// Warnings are counts only.
		expect(JSON.stringify(result.warnings)).not.toContain("document-media");
	});

	it("carries at most maxImages distinct images and counts the rest", async () => {
		const names = ["1.png", "2.png", "3.png", "4.png", "5.png"];
		const reader = fakeReader(
			Object.fromEntries(names.map((name) => [mediaKey(name), png])),
		);

		const result = await extractDocumentImages({
			root: prepared(
				[...names, "1.png"]
					.map((name) => imageTag(mediaKey(name)))
					.join("\n\n"),
			),
			projectId: PROJECT,
			documentId: DOCUMENT,
			read: reader.read,
			limits: { maxImages: 2 },
		});

		expect(reader.reads).toEqual([mediaKey("1.png"), mediaKey("2.png")]);
		expect(result.images.size).toBe(2);
		expect(result.warnings).toEqual([{ code: "IMAGE_LIMIT", count: 3 }]);
	});

	it("shares one byte budget with whatever the caller charged first", async () => {
		const reader = fakeReader({
			[mediaKey("first.png")]: png,
			[mediaKey("second.png")]: png,
		});
		const budget = createExportImageBudget(png.byteLength * 3);
		// A brand logo read before the document's images.
		expect(budget.charge(png.byteLength * 2)).toBe(true);

		const result = await extractDocumentImages({
			root: prepared(
				[
					imageTag(mediaKey("first.png")),
					imageTag(mediaKey("second.png")),
				].join("\n\n"),
			),
			projectId: PROJECT,
			documentId: DOCUMENT,
			read: reader.read,
			budget,
		});

		expect([...result.images.keys()]).toEqual([mediaKey("first.png")]);
		expect(result.warnings).toEqual([{ code: "IMAGE_DROPPED", count: 1 }]);
		expect(budget.remainingBytes).toBe(0);
		expect(budget.charge(1)).toBe(false);
	});
});
