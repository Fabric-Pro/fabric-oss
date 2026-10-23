/**
 * `decodeBrandFont` (Fizzy #2946): a Brand kit font is stored and served
 * only when it decodes, not merely when its container holds together.
 */
import { validateFontFile } from "@repo/utils/brand-assets";
import { describe, expect, it } from "vitest";
import {
	forgedTrueType,
	forgedWoff2,
	realTrueType,
	realWoff2,
} from "../../__tests__/support/font-fixtures";
import { decodeBrandFont } from "../brand-font";

describe("decodeBrandFont", () => {
	it("decodes a real WOFF2 and a real TrueType font, under either TrueType tag", () => {
		expect(decodeBrandFont(realWoff2())).toBe("woff2");
		expect(decodeBrandFont(realTrueType())).toBe("ttf");
		const apple = realTrueType();
		apple.write("true", 0, "latin1");
		expect(decodeBrandFont(apple)).toBe("ttf");
	});

	it("decodes a font padded to the 512 KiB cap with trailing bytes", () => {
		expect(decodeBrandFont(realTrueType(512 * 1024))).toBe("ttf");
	});

	// The forged files are what the structural check alone admitted.
	it("refuses containers that hold together but do not decode", () => {
		expect(validateFontFile(forgedWoff2())).toBe("woff2");
		expect(decodeBrandFont(forgedWoff2())).toBeNull();
		expect(validateFontFile(forgedTrueType())).toBe("ttf");
		expect(decodeBrandFont(forgedTrueType())).toBeNull();
	});

	it("refuses a real font whose data was damaged", () => {
		const woff2 = realWoff2();
		expect(
			decodeBrandFont(Buffer.from(woff2).fill(0xff, 2000, 6000)),
		).toBeNull();
		const ttf = realTrueType();
		expect(
			decodeBrandFont(Buffer.from(ttf).fill(0xff, 2000, 6000)),
		).toBeNull();
		expect(
			decodeBrandFont(ttf.subarray(0, ttf.length - 20_000)),
		).toBeNull();
	});

	it("refuses what the structural check refuses, before decoding", () => {
		expect(decodeBrandFont(new Uint8Array())).toBeNull();
		expect(
			decodeBrandFont(Buffer.from("OTTO\0\0\0\0", "latin1")),
		).toBeNull();
	});
});
