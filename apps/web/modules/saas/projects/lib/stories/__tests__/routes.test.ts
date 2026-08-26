import { describe, expect, it } from "vitest";
import { buildStoryDetailsRoute, buildStoryQaRoute } from "../routes";

// Spec: specs/2026-05-25-backlog-context-menu-open-in-new-tab/spec.md §9.1.
// Locks the single source of truth that the context-menu "Open in new tab"
// action and the row's left-click navigation share. Drift in either path is
// a bug — FR-14.

describe("buildStoryDetailsRoute", () => {
	it("composes the org-context path with the org-prefixed basePath", () => {
		expect(buildStoryDetailsRoute("/app/acme", "p1", "s1")).toBe(
			"/app/acme/projects/p1/stories/s1",
		);
	});

	it("composes the personal-context path with the bare /app basePath", () => {
		expect(buildStoryDetailsRoute("/app", "p1", "s1")).toBe(
			"/app/projects/p1/stories/s1",
		);
	});

	it("accepts an empty basePath and returns a relative path starting with /projects", () => {
		// Edge case documented in spec §9.1. An empty basePath is permissible
		// because the helper is purely string concatenation — the call site is
		// responsible for passing a sensible value.
		expect(buildStoryDetailsRoute("", "p1", "s1")).toBe(
			"/projects/p1/stories/s1",
		);
	});

	it("does NOT URL-encode IDs — concatenates literally (v1 behavior)", () => {
		// Spec §9.1: special characters in IDs are intentionally NOT escaped
		// in v1. UserStory and Project IDs in the database are opaque strings
		// (cuid / nanoid style) so URL-encoding has no benefit today.
		expect(
			buildStoryDetailsRoute("/app/acme", "proj a/b", "story?id=1"),
		).toBe("/app/acme/projects/proj a/b/stories/story?id=1");
	});
});

describe("buildStoryQaRoute", () => {
	it("opens the feature on its QA tab (case→criterion direction)", () => {
		expect(buildStoryQaRoute("/app/acme", "p1", "s1")).toBe(
			"/app/acme/projects/p1/stories/s1?storyTab=qa",
		);
	});
});
