/**
 * Tests for `buildArtifactLink` — Fizzy #1412 §5.1.
 *
 * Builds an absolute URL to a Fabric artifact (story, document, task)
 * for inclusion in operation-result chat messages. Distinct from
 * `buildStoryDetailsRoute` because:
 *
 *   - Returns an ABSOLUTE URL (chat messages may be opened by clients
 *     that don't share the current document origin — e.g. Slack
 *     unfurls, email digests, push notifications, mobile WebView).
 *   - Handles three artifact kinds (story / document / task) via a
 *     discriminated union rather than just stories.
 *   - Optionally accepts `parentStoryId` for task kind (tasks live
 *     under a story route).
 *
 * `buildStoryDetailsRoute` is reused for the story segment so the two
 * helpers stay in sync — if the story route ever moves, only one
 * helper needs editing.
 */

import { describe, expect, it } from "vitest";
import { buildArtifactLink } from "../buildArtifactLink";

const BASE = "https://fabric.pro";

describe("buildArtifactLink — story kind", () => {
	it("org context: joins baseUrl + /app/{slug}/projects/{p}/stories/{s}", () => {
		const url = buildArtifactLink({
			kind: "story",
			id: "story-1",
			projectId: "proj-1",
			organizationSlug: "acme",
			baseUrl: BASE,
		});
		expect(url).toBe(`${BASE}/app/acme/projects/proj-1/stories/story-1`);
	});

	it("personal context (no organizationSlug): /app/projects/{p}/stories/{s}", () => {
		const url = buildArtifactLink({
			kind: "story",
			id: "story-1",
			projectId: "proj-1",
			baseUrl: BASE,
		});
		expect(url).toBe(`${BASE}/app/projects/proj-1/stories/story-1`);
	});
});

describe("buildArtifactLink — document kind", () => {
	it("org context: documents nested under project", () => {
		const url = buildArtifactLink({
			kind: "document",
			id: "doc-1",
			projectId: "proj-1",
			organizationSlug: "acme",
			baseUrl: BASE,
		});
		expect(url).toBe(`${BASE}/app/acme/projects/proj-1/documents/doc-1`);
	});

	it("personal context: documents nested under project, no org segment", () => {
		const url = buildArtifactLink({
			kind: "document",
			id: "doc-1",
			projectId: "proj-1",
			baseUrl: BASE,
		});
		expect(url).toBe(`${BASE}/app/projects/proj-1/documents/doc-1`);
	});
});

describe("buildArtifactLink — task kind", () => {
	it("org context: task under parent story", () => {
		const url = buildArtifactLink({
			kind: "task",
			id: "task-1",
			projectId: "proj-1",
			parentStoryId: "story-1",
			organizationSlug: "acme",
			baseUrl: BASE,
		});
		expect(url).toBe(
			`${BASE}/app/acme/projects/proj-1/stories/story-1/tasks/task-1`,
		);
	});

	it("personal context: task under parent story without org segment", () => {
		const url = buildArtifactLink({
			kind: "task",
			id: "task-1",
			projectId: "proj-1",
			parentStoryId: "story-1",
			baseUrl: BASE,
		});
		expect(url).toBe(
			`${BASE}/app/projects/proj-1/stories/story-1/tasks/task-1`,
		);
	});
});

describe("buildArtifactLink — input validation", () => {
	it("rejects when baseUrl is empty", () => {
		expect(() =>
			buildArtifactLink({
				kind: "story",
				id: "s",
				projectId: "p",
				baseUrl: "",
			}),
		).toThrow(/baseUrl/);
	});

	it("rejects when task kind is missing parentStoryId", () => {
		expect(() =>
			buildArtifactLink({
				// biome-ignore lint/suspicious/noExplicitAny: testing input contract
				kind: "task" as any,
				id: "t",
				projectId: "p",
				baseUrl: BASE,
				// parentStoryId omitted
			} as never),
		).toThrow(/parentStoryId/);
	});

	it("strips trailing slash on baseUrl so concatenation is clean", () => {
		const url = buildArtifactLink({
			kind: "story",
			id: "story-1",
			projectId: "proj-1",
			baseUrl: `${BASE}/`,
		});
		expect(url).toBe(`${BASE}/app/projects/proj-1/stories/story-1`);
	});
});
