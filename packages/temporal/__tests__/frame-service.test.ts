import { describe, expect, it } from "vitest";
import {
	validateCreateFrameArgs,
	validateUpdateFrameArgs,
} from "../src/activities/shared/frame-args";

describe("frame-args", () => {
	it.each([
		"[content omitted: 3005 chars - rendered to frame]",
		" \n[content omitted: 0 chars - rendered to frame]\t ",
	])(
		"rejects retained placeholder content in both write operations: %s",
		(content) => {
			const args = {
				frameId: "frame-1",
				title: "Example",
				blocks: [{ id: "page", type: "html", content }],
			};
			for (const result of [
				validateCreateFrameArgs(args),
				validateUpdateFrameArgs(args),
			]) {
				expect(result).toMatchObject({ ok: false });
				if (!result.ok) {
					expect(result.error).toContain(
						"Provide actual block content",
					);
					expect(result.error).toContain("fabric_get_frame");
				}
			}
		},
	);

	it("also rejects placeholder content supplied through the create components fallback", () => {
		expect(
			validateCreateFrameArgs({
				title: "Example",
				components: [
					{
						type: "html",
						content:
							"[content omitted: 12 chars - rendered to frame]",
					},
				],
			}),
		).toMatchObject({ ok: false });
	});

	it.each([
		"<p>Actual page content</p>",
		"A text example: [content omitted: 3005 chars - rendered to frame]",
	])("preserves legitimate block content: %s", (content) => {
		const blocks = [{ id: "page", type: "html", content }];
		const args = { frameId: "frame-1", title: "Example", blocks };
		for (const result of [
			validateCreateFrameArgs(args),
			validateUpdateFrameArgs(args),
		]) {
			expect(result).toMatchObject({ ok: true, value: { blocks } });
		}
	});

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
