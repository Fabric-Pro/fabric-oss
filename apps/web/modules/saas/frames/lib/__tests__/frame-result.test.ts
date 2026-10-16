import { describe, expect, it } from "vitest";
import { extractFrameToolResult, isFrameToolName } from "../frame-result";

describe("isFrameToolName", () => {
	it.each([
		"fabric_create_frame",
		"fabric_update_frame",
		"fabric_get_frame",
		"fabric_list_frames",
		"fabric_share_frame",
		"fabric_create_slideshow",
		"fabric_duplicate_frame",
		"fabric_restore_frame_version",
	])("shows %s as a page the chat can open", (name) => {
		expect(isFrameToolName(name)).toBe(true);
	});

	it.each([
		"fabric_list_frame_versions",
		"fabric_page_comment_add",
		"fabric_get_page_viewer",
		"fabric_list_workflows",
	])("does not for %s", (name) => {
		expect(isFrameToolName(name)).toBe(false);
	});
});

describe("extractFrameToolResult", () => {
	it("reads the page a copy or a restore answers with", () => {
		expect(
			extractFrameToolResult({
				frameId: "frame-2",
				duplicatedFrom: "frame-1",
				title: "Delivery (Copy)",
				kind: "frame",
				frameUrl: "/app/frames/frame-2",
				embedUrl: "/app/frames/frame-2/embed",
				response: 'Frame "Delivery" is now your own copy.',
			}),
		).toMatchObject({
			frameId: "frame-2",
			title: "Delivery (Copy)",
			kind: "frame",
			frameUrl: "/app/frames/frame-2",
			embedUrl: "/app/frames/frame-2/embed",
		});
	});

	it("reads a result sent as text, and none that names no page", () => {
		expect(
			extractFrameToolResult(JSON.stringify({ frameId: "frame-3" })),
		).toMatchObject({ frameId: "frame-3" });
		expect(extractFrameToolResult({ title: "no id" })).toBeNull();
		expect(extractFrameToolResult("not json")).toBeNull();
		expect(extractFrameToolResult(null)).toBeNull();
	});
});
