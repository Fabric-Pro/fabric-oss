import type { MyWorkResult } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
	buildNeedsYou,
	buildProjectActivity,
	healthNotifications,
	type HomeNotification,
} from "../home-model";

function notification(
	overrides: Partial<HomeNotification> = {},
): HomeNotification {
	return {
		id: "notification-1",
		type: "STORY_MENTION",
		title: "You were mentioned",
		snippet: "Example feature",
		link: "projects/project-1/stories/story-1",
		readAt: null,
		createdAt: "2026-11-05T10:00:00.000Z",
		projectId: "project-1",
		projectName: "Example Portal",
		organizationSlug: "example-org",
		...overrides,
	};
}

function emptyWork(): MyWorkResult {
	return {
		inProgress: { items: [], total: 0 },
		needsReview: { items: [], total: 0 },
		blocked: { items: [], total: 0 },
		drafts: { items: [], total: 0 },
		assignedFeatures: { items: [], total: 0 },
		projectCount: 0,
		projectVisits: [],
	};
}

describe("buildNeedsYou", () => {
	it("prioritizes failures and decisions and deduplicates destinations", () => {
		const work = emptyWork();
		work.blocked = {
			total: 1,
			items: [
				{
					id: "run-1",
					kind: "codingRun",
					title: "Billing export",
					subtitle: "Provider timed out",
					projectName: "Example Portal",
					href: "/app/example-org/projects/project-1/stories/story-1",
					updatedAt: new Date("2026-11-05T09:00:00.000Z"),
				},
			],
		};
		const result = buildNeedsYou({
			work,
			notifications: [
				notification({
					id: "duplicate",
					title: "Billing export",
					link: "/app/example-org/projects/project-1/stories/story-1",
				}),
				notification({
					id: "decision",
					type: "DECISION_OWNER_ASSIGNED",
					title: "Answer the authentication decision",
					link: "/app/example-org/projects/project-1?tab=decisions",
				}),
			],
			todos: [],
			basePath: "/app/example-org",
			includeTodos: false,
		});

		expect(result.items.map((item) => item.id)).toEqual([
			"blocked-codingRun-run-1",
			"notification-decision",
		]);
		expect(result.items[1].actionLabel).toBe("Answer");
	});

	it("links an unopenable to-do project to the to-do list instead", () => {
		const result = buildNeedsYou({
			notifications: [],
			todos: [
				{
					id: "todo-1",
					title: "Send the revised estimate",
					projectId: "project-1",
					projectName: "Example Portal",
					canOpenProject: false,
					meetingTitle: "Weekly planning",
					sourceDate: "2026-11-05T09:00:00.000Z",
					isCompleted: false,
				},
			],
			basePath: "/app/example-org",
			includeTodos: true,
		});

		expect(result.items[0].href).toBe("/app/example-org/todos");
	});

	it("keeps distinct to-dos that share a project destination", () => {
		const todo = {
			projectId: "project-1",
			projectName: "Example Portal",
			canOpenProject: true,
			meetingTitle: null,
			sourceDate: "2026-11-05T09:00:00.000Z",
			isCompleted: false,
		};
		const result = buildNeedsYou({
			notifications: [],
			todos: [
				{ ...todo, id: "todo-1", title: "First commitment" },
				{ ...todo, id: "todo-2", title: "Second commitment" },
			],
			basePath: "/app/example-org",
			includeTodos: true,
		});

		expect(result.items).toHaveLength(2);
	});

	it("keeps distinct failures that share a destination", () => {
		const work = emptyWork();
		work.blocked = {
			total: 2,
			items: [
				{
					id: "task-1",
					kind: "task",
					title: "First agent",
					subtitle: "First failure",
					href: "/app/example-org/agents?tab=tasks",
					updatedAt: new Date("2026-11-05T09:00:00.000Z"),
				},
				{
					id: "task-2",
					kind: "task",
					title: "Second agent",
					subtitle: "Second failure",
					href: "/app/example-org/agents?tab=tasks",
					updatedAt: new Date("2026-11-05T10:00:00.000Z"),
				},
			],
		};
		const result = buildNeedsYou({
			work,
			notifications: [
				notification({
					id: "unrelated",
					title: "A different agent update",
					link: "/app/example-org/agents?tab=tasks",
				}),
			],
			todos: [],
			basePath: "/app/example-org",
			includeTodos: false,
		});

		expect(result.items).toHaveLength(3);
		expect(result.total).toBe(3);
	});
});

describe("healthNotifications", () => {
	it("hides system-admin incidents from other members", () => {
		const notifications = [
			notification({ id: "incident", type: "INTEGRATION_INCIDENT" }),
			notification({
				id: "token",
				type: "REPO_INTEGRATION_TOKEN_EXPIRED",
			}),
		];
		expect(healthNotifications(notifications, false)).toHaveLength(1);
		expect(healthNotifications(notifications, true)).toHaveLength(2);
	});
});

describe("buildProjectActivity", () => {
	it("includes only changes after the project was last opened", () => {
		const result = buildProjectActivity({
			notifications: [
				notification({
					id: "old",
					createdAt: "2026-11-04T10:00:00.000Z",
				}),
				notification({
					id: "new",
					type: "DOCUMENT_GENERATION_COMPLETED",
					createdAt: "2026-11-05T10:00:00.000Z",
				}),
			],
			visits: [
				{
					projectId: "project-1",
					lastVisitedAt: "2026-11-05T00:00:00.000Z",
				},
			],
			basePath: "/app/example-org",
		});

		expect(result).toHaveLength(1);
		expect(result[0].summary).toBe("1 document generated");
	});
});
