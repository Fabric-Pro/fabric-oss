import { describe, expect, it } from "vitest";
import type { HomeActionItem, HomeProjectShortcut } from "../home-model";
import { buildCuratedCards } from "../curated-model";

const action: HomeActionItem = {
	id: "run-1",
	title: "Review billing export",
	reason: "Run failed",
	projectName: "Example Portal",
	href: "/app/example-org/projects/project-1/stories/story-1",
	actionLabel: "Open",
	updatedAt: new Date("2026-11-05T10:00:00.000Z"),
	priority: 0,
	blocked: true,
};
const project: HomeProjectShortcut = {
	id: "project-1",
	name: "Example Portal",
	organizationSlug: "example-org",
	lastVisitedAt: new Date("2026-11-05T10:00:00.000Z"),
};

describe("buildCuratedCards", () => {
	it("prioritizes the current action, recent project, and admin automation", () => {
		const cards = buildCuratedCards({
			needsYou: [action],
			projects: [project],
			basePath: "/app/example-org",
			isOrganizationAdmin: true,
		});

		expect(cards.map((card) => card.kind)).toEqual([
			"review",
			"project",
			"automate",
		]);
		expect(cards[0]?.href).toBe(action.href);
		expect(cards[2]?.href).toBe("/app/example-org/workflows/new");
	});

	it("offers creation, context, and Fabric guidance without existing work", () => {
		const cards = buildCuratedCards({
			needsYou: [],
			projects: [project],
			basePath: "/app/example-org",
			isOrganizationAdmin: false,
		});

		expect(cards.map((card) => card.kind)).toEqual([
			"project",
			"create",
			"context",
		]);
		expect(cards[1]?.href).toBe(
			"/app/example-org/projects/project-1?createStory=true",
		);
	});

	it("provides a real first-project path and avoids duplicates", () => {
		const cards = buildCuratedCards({
			needsYou: [],
			projects: [],
			basePath: "/app/example-org",
			isOrganizationAdmin: false,
		});

		expect(cards.map((card) => card.kind)).toEqual(["create", "ask"]);
		expect(cards[0]?.href).toBe("/app/example-org/projects/new");
		expect(cards[1]?.href).toContain(
			"/app/example-org/agents/fabric-ai?prompt=",
		);
		expect(new Set(cards.map((card) => card.href)).size).toBe(cards.length);
	});

	it("ranks every eligible action with pins, bounded clicks and project affinity", () => {
		const otherAction = {
			...action,
			id: "run-2",
			title: "Review deployment",
			updatedAt: new Date("2026-10-01T10:00:00.000Z"),
		};
		const cards = buildCuratedCards({
			needsYou: [action, otherAction],
			projects: [project],
			basePath: "/app/example-org",
			isOrganizationAdmin: false,
			now: new Date("2026-11-06T10:00:00.000Z"),
			feedback: [
				{
					cardKey: "review:run-2",
					pinnedAt: null,
					dismissedAt: null,
					clickCount: 5,
					lastClickedAt: new Date("2026-11-06T09:00:00.000Z"),
				},
			],
		});

		expect(cards[0]?.key).toBe("review:run-2");
		expect(cards[0]?.score).toBeLessThanOrEqual(125);
	});

	it("pins cards, hides dismissals, and restores them", () => {
		const input = {
			needsYou: [action],
			projects: [project],
			basePath: "/app/example-org",
			isOrganizationAdmin: false,
		};
		const feedback = {
			pinnedAt: null,
			dismissedAt: null,
			clickCount: 0,
			lastClickedAt: null,
		};
		expect(
			buildCuratedCards({
				...input,
				feedback: [
					{
						...feedback,
						cardKey: `project:${project.id}`,
						pinnedAt: new Date(),
					},
				],
			})[0]?.key,
		).toBe(`project:${project.id}`);
		expect(
			buildCuratedCards({
				...input,
				feedback: [
					{
						...feedback,
						cardKey: `review:${action.id}`,
						dismissedAt: new Date(),
					},
				],
			}).some((card) => card.key === `review:${action.id}`),
		).toBe(false);
		expect(
			buildCuratedCards({
				...input,
				feedback: [
					{
						...feedback,
						cardKey: `review:${action.id}`,
						dismissedAt: null,
					},
				],
			}).some((card) => card.key === `review:${action.id}`),
		).toBe(true);
	});
});
