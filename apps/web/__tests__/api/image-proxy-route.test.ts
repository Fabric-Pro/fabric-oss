// @vitest-environment node
/**
 * `GET /image-proxy/<bucket>/<path>` is unauthenticated: it redirects to a
 * one-hour signed URL. It serves avatars, and published release-notes images
 * at exactly `<projectContexts bucket>/newsletter-public/<32+ hex>.<png|jpg|jpeg>`
 * — never a review-stage image or anything else in that bucket.
 */

import { config } from "@repo/config";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getSignedUrl } = vi.hoisted(() => ({ getSignedUrl: vi.fn() }));

vi.mock("@repo/storage", () => ({ getSignedUrl }));

import { GET } from "../../app/image-proxy/[...path]/route";

const AVATARS = config.storage.bucketNames.avatars;
const CONTEXTS = config.storage.bucketNames.projectContexts;
const FILE = `${"a".repeat(32)}.png`;

function get(...path: string[]) {
	return GET(
		new Request(`https://fabric.example.com/image-proxy/${path.join("/")}`),
		{ params: Promise.resolve({ path }) },
	);
}

beforeEach(() => {
	getSignedUrl.mockReset();
	getSignedUrl.mockResolvedValue("https://storage.example.com/signed");
});

describe("/image-proxy", () => {
	it("still redirects an avatar to a one-hour signed URL", async () => {
		const response = await get(AVATARS, "user-1.png");

		expect(response.status).toBe(307);
		expect(response.headers.get("location")).toBe(
			"https://storage.example.com/signed",
		);
		expect(getSignedUrl).toHaveBeenCalledWith("user-1.png", {
			bucket: AVATARS,
			expiresIn: 3600,
		});
	});

	it.each([
		["a PNG", FILE, "image/png"],
		["a JPG", `${"0123456789abcdef".repeat(2)}.jpg`, "image/jpeg"],
		["a JPEG", `${"f".repeat(64)}.jpeg`, "image/jpeg"],
	])(
		"serves %s published release-notes image inline",
		async (_label, file, type) => {
			const response = await get(CONTEXTS, "newsletter-public", file);

			expect(response.status).toBe(307);
			expect(getSignedUrl).toHaveBeenCalledWith(
				`newsletter-public/${file}`,
				{
					bucket: CONTEXTS,
					expiresIn: 3600,
					responseContentType: type,
					responseContentDisposition: "inline",
				},
			);
		},
	);

	it.each([
		[
			"a review-stage image",
			["org-1", "newsletter-images", "send-1", FILE],
		],
		["the bare public prefix", ["newsletter-public"]],
		[
			"a nested path under the public prefix",
			["newsletter-public", "x", FILE],
		],
		[
			"a file of another type",
			["newsletter-public", `${"a".repeat(32)}.svg`],
		],
		["a name that is too short", ["newsletter-public", "abc.png"]],
		["an upper-case name", ["newsletter-public", `${"A".repeat(32)}.png`]],
		["a traversal", ["newsletter-public", `../${FILE}`]],
		["something after the name", ["newsletter-public", `${FILE}.html`]],
		["another prefix of the bucket", ["organization-brand", FILE]],
	])("answers %s with a 404 and signs nothing", async (_label, rest) => {
		const response = await get(CONTEXTS, ...rest);

		expect(response.status).toBe(404);
		expect(getSignedUrl).not.toHaveBeenCalled();
	});

	it("serves the public prefix of no other bucket", async () => {
		const response = await get(
			"workspace-documents",
			"newsletter-public",
			FILE,
		);

		expect(response.status).toBe(404);
		expect(getSignedUrl).not.toHaveBeenCalled();
	});
});
