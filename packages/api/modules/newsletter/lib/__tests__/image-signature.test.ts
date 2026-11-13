/**
 * Unit tests for the signature check a review image's bytes must pass before
 * the upload is kept. Pure, so it is tested directly; the procedures that call
 * it are covered in `procedures/__tests__/sends-images.test.ts`.
 *
 * Run with: pnpm --filter @repo/api test image-signature
 */

import { describe, expect, it } from "vitest";
import { hasImageSignature } from "../image-signature";

const PNG = Uint8Array.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const text = (value: string) => new TextEncoder().encode(value);

describe("hasImageSignature", () => {
	it("accepts a PNG labelled image/png", () => {
		expect(hasImageSignature(PNG, "image/png")).toBe(true);
	});

	it("accepts a JPEG labelled image/jpeg", () => {
		expect(hasImageSignature(JPEG, "image/jpeg")).toBe(true);
	});

	it("refuses a real image labelled as the other type", () => {
		expect(hasImageSignature(JPEG, "image/png")).toBe(false);
		expect(hasImageSignature(PNG, "image/jpeg")).toBe(false);
	});

	it("refuses a buffer shorter than the signature", () => {
		expect(hasImageSignature(PNG.subarray(0, 7), "image/png")).toBe(false);
		expect(hasImageSignature(JPEG.subarray(0, 2), "image/jpeg")).toBe(
			false,
		);
		expect(hasImageSignature(new Uint8Array(), "image/png")).toBe(false);
	});

	it.each([
		["an HTML page", "<!doctype html><script>alert(1)</script>"],
		[
			"an SVG image",
			'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
		],
	])("refuses %s labelled image/png", (_label, body) => {
		expect(hasImageSignature(text(body), "image/png")).toBe(false);
		expect(hasImageSignature(text(body), "image/jpeg")).toBe(false);
	});
});
