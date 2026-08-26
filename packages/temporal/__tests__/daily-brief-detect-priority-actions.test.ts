import { describe, expect, it, vi } from "vitest";

// Mock external dependencies so the module can be loaded without network/DB access.
vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		projectStoryStatus: { findMany: vi.fn() },
		userStory: { findMany: vi.fn() },
	},
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
}));

import type { PriorityAction } from "@repo/database";
import {
	isPrReviewStale,
	isStoryStale,
	PR_REVIEW_STALE_THRESHOLD_DAYS,
	STORY_STALE_THRESHOLD_DAYS,
	sortPriorityActions,
} from "../src/activities/daily-brief/detect-priority-actions";

describe("isStoryStale", () => {
	const now = new Date("2026-04-23T12:00:00Z");

	it("returns false when status is not active", () => {
		expect(
			isStoryStale({
				statusName: "Done",
				updatedAt: new Date("2026-01-01T00:00:00Z"),
				now,
			}),
		).toBe(false);
	});

	it("returns false when updated within the threshold", () => {
		const justNow = new Date(now.getTime() - 24 * 60 * 60 * 1000);
		expect(
			isStoryStale({
				statusName: "In Progress",
				updatedAt: justNow,
				now,
			}),
		).toBe(false);
	});

	it("returns true for active stories idle past the threshold", () => {
		const stale = new Date(
			now.getTime() -
				(STORY_STALE_THRESHOLD_DAYS + 1) * 24 * 60 * 60 * 1000,
		);
		expect(
			isStoryStale({
				statusName: "In Progress",
				updatedAt: stale,
				now,
			}),
		).toBe(true);
	});
});

describe("isPrReviewStale", () => {
	const now = new Date("2026-04-23T12:00:00Z");

	it("returns false for merged or closed PRs", () => {
		expect(
			isPrReviewStale({
				state: "merged",
				updatedAt: new Date("2026-01-01T00:00:00Z"),
				now,
			}),
		).toBe(false);
	});

	it("returns true for open PRs with no update past threshold", () => {
		const stale = new Date(
			now.getTime() -
				(PR_REVIEW_STALE_THRESHOLD_DAYS + 1) * 24 * 60 * 60 * 1000,
		);
		expect(isPrReviewStale({ state: "open", updatedAt: stale, now })).toBe(
			true,
		);
	});
});

// Minimal factory for test fixtures.
function mkAction(
	kind: PriorityAction["kind"],
	targetCuid: string,
): PriorityAction {
	return {
		kind,
		title: `${kind} action`,
		whyItMatters: "",
		targetCuid,
		targetIdentifier: targetCuid,
		targetType: "story",
		fabricLink: "/x",
	};
}

describe("sortPriorityActions", () => {
	it("orders by kind priority: security_findings → blocker → decisions_proposed → story_stale → due_date_risk → missing_ownership → pr_review_stale → unresolved_dependency", () => {
		const input: PriorityAction[] = [
			mkAction("unresolved_dependency", "u1"),
			mkAction("pr_review_stale", "p1"),
			mkAction("missing_ownership", "m1"),
			mkAction("due_date_risk", "d1"),
			mkAction("story_stale", "s1"),
			mkAction("decisions_proposed", "ad1"),
			mkAction("blocker", "b1"),
			mkAction("security_findings", "sec1"),
		];
		const sorted = sortPriorityActions(input);
		expect(sorted.map((a) => a.kind)).toEqual([
			"security_findings",
			"blocker",
			"decisions_proposed",
			"story_stale",
			"due_date_risk",
			"missing_ownership",
			"pr_review_stale",
			"unresolved_dependency",
		]);
	});

	it("preserves input order within a single kind (stable)", () => {
		const input: PriorityAction[] = [
			mkAction("blocker", "first"),
			mkAction("blocker", "second"),
			mkAction("blocker", "third"),
		];
		const sorted = sortPriorityActions(input);
		expect(sorted.map((a) => a.targetCuid)).toEqual([
			"first",
			"second",
			"third",
		]);
	});

	it("returns an empty array for empty input", () => {
		expect(sortPriorityActions([])).toEqual([]);
	});

	it("does not mutate the input array", () => {
		const input: PriorityAction[] = [
			mkAction("pr_review_stale", "a"),
			mkAction("blocker", "b"),
		];
		const snapshot = [...input];
		sortPriorityActions(input);
		expect(input).toEqual(snapshot);
	});
});
