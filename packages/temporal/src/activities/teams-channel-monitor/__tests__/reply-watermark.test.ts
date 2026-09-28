import { describe, expect, it } from "vitest";
import { isReplyNewerThanWatermark } from "../reply-watermark";

const WATERMARK = "2026-05-23T10:01:00.000Z";
const WATERMARK_MS = new Date(WATERMARK).getTime();

describe("isReplyNewerThanWatermark", () => {
	it("is true only for a timestamp strictly after the watermark", () => {
		expect(
			isReplyNewerThanWatermark("2026-05-23T10:01:00.001Z", WATERMARK_MS),
		).toBe(true);
		expect(isReplyNewerThanWatermark(WATERMARK, WATERMARK_MS)).toBe(false);
		expect(
			isReplyNewerThanWatermark("2026-05-23T10:00:59.999Z", WATERMARK_MS),
		).toBe(false);
	});

	it("is false for a missing or unparseable timestamp, which could never pass a watermark", () => {
		expect(isReplyNewerThanWatermark(undefined, WATERMARK_MS)).toBe(false);
		expect(isReplyNewerThanWatermark("", WATERMARK_MS)).toBe(false);
		expect(isReplyNewerThanWatermark("not-a-timestamp", WATERMARK_MS)).toBe(
			false,
		);
	});
});
