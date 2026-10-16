import { describe, expect, it } from "vitest";
import { findPublishedFrameId } from "../workflow-run-output";

describe("findPublishedFrameId", () => {
	it("reads the frame id off a step's output", () => {
		const output = { "publish-frame": { frameId: "frame-9", url: "/f/9" } };

		const frameId = findPublishedFrameId(output);

		expect(frameId).toBe("frame-9");
	});

	it("finds nothing in an output that is not a map of step outputs", () => {
		expect(findPublishedFrameId(null)).toBeNull();
		expect(findPublishedFrameId(undefined)).toBeNull();
		expect(findPublishedFrameId("frame-9")).toBeNull();
		expect(findPublishedFrameId([{ frameId: "frame-9" }])).toBeNull();
	});

	it("ignores an empty or non-string frame id", () => {
		expect(findPublishedFrameId({ a: { frameId: "" } })).toBeNull();
		expect(findPublishedFrameId({ a: { frameId: 4 } })).toBeNull();
	});
});
