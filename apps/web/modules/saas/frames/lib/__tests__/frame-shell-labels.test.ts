import { describe, expect, it } from "vitest";
import { frameShellLabels } from "../frame-shell-labels";

describe("frameShellLabels", () => {
	it.each([
		["artifact", "Artifact", "Loading artifact…"],
		["workspace", "Workspace", "Loading workspace…"],
	] as const)(
		"names a page on the %s surface by the surface",
		(surface, eyebrow, loading) => {
			expect(
				frameShellLabels({ surface, headerMode: "authenticated" }),
			).toEqual({ eyebrow, showKindBadge: false, loading });
		},
	);

	it("names any other page by what it is, with the kind badge", () => {
		expect(frameShellLabels({ headerMode: "authenticated" })).toEqual({
			eyebrow: "Interactive content",
			showKindBadge: true,
			loading: "Loading interactive frame…",
		});
	});

	it("names a shared page by being shared", () => {
		expect(frameShellLabels({ headerMode: "public" })).toMatchObject({
			eyebrow: "Shared Frame",
			showKindBadge: true,
		});
	});

	it("lets the surface name a page whoever is looking", () => {
		expect(
			frameShellLabels({ surface: "workspace", headerMode: "public" })
				.eyebrow,
		).toBe("Workspace");
	});
});
