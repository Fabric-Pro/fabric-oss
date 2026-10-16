import { describe, expect, it } from "vitest";
import { isUnattendedFrame, usesStrictSandbox } from "../strict-sandbox";

describe("usesStrictSandbox", () => {
	it("holds a frame of a project to the strict sandbox", () => {
		expect(usesStrictSandbox({ projectId: "project-1" })).toBe(true);
	});

	it.each(["artifact", "workspace"])(
		"holds a frame on the %s surface to it, with or without a project",
		(surface) => {
			expect(usesStrictSandbox({ surface })).toBe(true);
			expect(usesStrictSandbox({ surface, projectId: "project-1" })).toBe(
				true,
			);
		},
	);

	it("leaves a frame that predates both on the historical renderer", () => {
		expect(usesStrictSandbox({})).toBe(false);
		expect(usesStrictSandbox({ projectId: null, surface: null })).toBe(
			false,
		);
		expect(
			usesStrictSandbox({ projectId: undefined, surface: undefined }),
		).toBe(false);
		expect(usesStrictSandbox({ projectId: "" })).toBe(false);
	});

	it("holds a frame an unattended run wrote to it, even without a project or surface", () => {
		expect(usesStrictSandbox({ sourceRunType: "workflow" })).toBe(true);
	});

	describe("for a viewer", () => {
		it("keeps the author's own loose frame on the historical renderer", () => {
			expect(usesStrictSandbox({ userId: "author" }, "author")).toBe(
				false,
			);
		});

		it("holds somebody else's loose frame to the strict sandbox", () => {
			expect(usesStrictSandbox({ userId: "author" }, "viewer")).toBe(
				true,
			);
		});

		it("holds a frame with no known author to it for any viewer", () => {
			expect(usesStrictSandbox({}, "viewer")).toBe(true);
		});

		it("still holds the author's own frame of a project, surface or unattended run to it", () => {
			expect(
				usesStrictSandbox({ userId: "a", projectId: "p" }, "a"),
			).toBe(true);
			expect(
				usesStrictSandbox({ userId: "a", surface: "workspace" }, "a"),
			).toBe(true);
			expect(
				usesStrictSandbox(
					{ userId: "a", sourceRunType: "workflow" },
					"a",
				),
			).toBe(true);
		});
	});
});

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
