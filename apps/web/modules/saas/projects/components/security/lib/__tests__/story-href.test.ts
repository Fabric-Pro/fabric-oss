import { describe, expect, it } from "vitest";
import { buildStoryHref } from "../story-href";

describe("buildStoryHref", () => {
	// This is the REAL production case: the Security view is a client-side tab,
	// so `usePathname()` returns the project root — it does NOT end in
	// `/security`. The old `pathname.replace(/\/security$/, …)` no-op'd here and
	// left every finding link pointing at the project root; this asserts the fix.
	it("appends /stories/<id> to the project-root pathname (real Security tab URL)", () => {
		expect(
			buildStoryHref("/app/example-org/projects/proj-1", "story-77"),
		).toBe("/app/example-org/projects/proj-1/stories/story-77");
	});

	it("handles a legacy `…/security` pathname by dropping the tab segment", () => {
		expect(
			buildStoryHref("/app/org/projects/proj-1/security", "story-77"),
		).toBe("/app/org/projects/proj-1/stories/story-77");
	});

	it("ignores any other client-side tab suffix and targets the story", () => {
		expect(
			buildStoryHref("/app/org/projects/proj-1/settings", "story-77"),
		).toBe("/app/org/projects/proj-1/stories/story-77");
	});

	it("works for the personal (non-org) project route", () => {
		expect(buildStoryHref("/app/projects/proj-1", "story-9")).toBe(
			"/app/projects/proj-1/stories/story-9",
		);
	});

	it("falls back to the `/security` strip when there is no /projects/ segment", () => {
		expect(buildStoryHref("/some/other/path/security", "story-1")).toBe(
			"/some/other/path/stories/story-1",
		);
	});
});
