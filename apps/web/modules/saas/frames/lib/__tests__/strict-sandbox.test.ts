import { describe, expect, it } from "vitest";
import { isUnattendedFrame } from "../strict-sandbox";

describe("isUnattendedFrame", () => {
	it("is true only for a frame the Publish Frame step created", () => {
		expect(isUnattendedFrame({ sourceRunType: "workflow" })).toBe(true);
	});

	it.each([
		"direct-chat",
		"MCP_GATEWAY",
		"orchestrator",
		"ORCHESTRATOR",
		"coding_run",
		"",
		null,
		undefined,
	])("is false for a source run type of %s", (sourceRunType) => {
		expect(isUnattendedFrame({ sourceRunType })).toBe(false);
	});

	it("is false for a frame with no source run type at all", () => {
		expect(isUnattendedFrame({})).toBe(false);
	});
});
