import { describe, expect, it, vi } from "vitest";

const { storyFindMany } = vi.hoisted(() => ({
	storyFindMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		userStory: { findMany: storyFindMany },
	},
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
	fetchBacklogSnapshot,
	SNAPSHOT_DESCRIPTION_MAX_CHARS,
} from "../fetch-backlog-snapshot";

const longText = (chars: number) => "x".repeat(chars);

describe("fetchBacklogSnapshot — flat backlog (stories only)", () => {
	it("returns every story in orphanStories with empty legacy hierarchy arrays", async () => {
		storyFindMany.mockResolvedValueOnce([
			{
				id: "s1",
				identifier: "F-001",
				title: "A story",
				description: "Body",
				externalId: "ext-1",
				externalUrl: "https://example.com/items/1",
			},
		]);

		const snapshot = await fetchBacklogSnapshot({ projectId: "p1" });

		// Legacy arrays kept for workflow/replay shape compatibility — always empty.
		expect(snapshot.epics).toEqual([]);
		expect(snapshot.orphanFeatures).toEqual([]);
		expect(snapshot.orphanStories).toEqual([
			{
				id: "s1",
				identifier: "F-001",
				title: "A story",
				description: "Body",
				externalId: "ext-1",
				externalUrl: "https://example.com/items/1",
			},
		]);
	});

	it("scopes the query to the project", async () => {
		storyFindMany.mockResolvedValueOnce([]);

		await fetchBacklogSnapshot({ projectId: "p1" });

		expect(storyFindMany).toHaveBeenCalledWith(
			expect.objectContaining({ where: { projectId: "p1" } }),
		);
	});
});

describe("fetchBacklogSnapshot — description truncation", () => {
	it("caps story descriptions at SNAPSHOT_DESCRIPTION_MAX_CHARS", async () => {
		storyFindMany.mockResolvedValueOnce([
			{
				id: "s1",
				identifier: "F-001",
				title: "Long PRD as story",
				description: longText(50_000),
				externalId: null,
				externalUrl: null,
			},
		]);

		const snapshot = await fetchBacklogSnapshot({ projectId: "p1" });

		expect(snapshot.orphanStories).toHaveLength(1);
		expect(snapshot.orphanStories[0].description).toHaveLength(
			SNAPSHOT_DESCRIPTION_MAX_CHARS,
		);
	});

	it("preserves short descriptions unchanged", async () => {
		const shortDesc = "A normal-length description.";
		storyFindMany.mockResolvedValueOnce([
			{
				id: "s1",
				identifier: "F-001",
				title: "Short",
				description: shortDesc,
				externalId: null,
				externalUrl: null,
			},
		]);

		const snapshot = await fetchBacklogSnapshot({ projectId: "p1" });

		expect(snapshot.orphanStories[0].description).toBe(shortDesc);
	});

	it("passes through null/undefined descriptions", async () => {
		storyFindMany.mockResolvedValueOnce([
			{
				id: "s1",
				identifier: "F-001",
				title: "No description",
				description: null,
				externalId: null,
				externalUrl: null,
			},
		]);

		const snapshot = await fetchBacklogSnapshot({ projectId: "p1" });

		expect(snapshot.orphanStories[0].description).toBeNull();
	});

	it("keeps a realistic 300-story backlog under 2 MiB", async () => {
		const stories = Array.from({ length: 300 }, (_, i) => ({
			id: `s${i}`,
			identifier: `F-${i.toString().padStart(3, "0")}`,
			title: `Story ${i} title with some descriptive content for matching`,
			description: longText(50_000), // pathological 50KB-per-story descriptions
			externalId: `ext-${i}`,
			externalUrl: `https://example.com/items/${i}`,
		}));
		storyFindMany.mockResolvedValueOnce(stories);

		const snapshot = await fetchBacklogSnapshot({ projectId: "p1" });
		const serializedBytes = Buffer.byteLength(
			JSON.stringify(snapshot),
			"utf8",
		);

		// Temporal's default gRPC message size limit is 2 MiB.
		// With 300 stories at SNAPSHOT_DESCRIPTION_MAX_CHARS=500 each we expect
		// roughly 150KB; budget 1 MiB to leave room for envelope overhead in
		// the workflow input alongside other activity results.
		expect(serializedBytes).toBeLessThan(1024 * 1024);
	});
});
