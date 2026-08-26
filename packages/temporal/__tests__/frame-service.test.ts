import { describe, expect, it } from "vitest";
import {
	validateCreateFrameArgs,
	validateUpdateFrameArgs,
} from "../src/activities/shared/frame-service";

describe("frame-service", () => {
	it("validates create args with defaults", () => {
		const result = validateCreateFrameArgs({
			title: "Frame",
			description: "Test frame",
		});
		expect(result).toEqual({
			ok: true,
			value: {
				title: "Frame",
				description: "Test frame",
				format: "html",
				components: [],
				kind: "frame",
				shareOnCreate: false,
			},
		});
	});

	it("accepts slideshow create args", () => {
		const result = validateCreateFrameArgs({
			title: "Deck",
			kind: "slideshow",
			format: "mermaid",
			shareOnCreate: true,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.value.kind).toBe("slideshow");
			expect(result.value.format).toBe("mermaid");
			expect(result.value.shareOnCreate).toBe(true);
		}
	});

	it("requires a frame id for updates", () => {
		expect(validateUpdateFrameArgs({ title: "Nope" })).toEqual({
			ok: false,
			error: "Frame ID is required. Provide `frameId` for the frame to update.",
		});
	});
});
