/**
 * The feature-decisions agent tool must never show a retracted answer (#1910).
 *
 * This handler renders a thread's replies straight into an agent's context under
 * a stance line calling resolved decisions authoritative for the feature's
 * current intent. An answer that a later amendment superseded is retracted — if
 * it reaches the model, the agent receives two equally authoritative answers to
 * one question and has no way to tell which one still stands. Nothing fails
 * loudly when that happens, which is exactly why it needs a test.
 *
 * The filtering itself is exercised against real Postgres in
 * `@repo/database`'s `feature-maturation.test.ts`. What is pinned HERE is the
 * call shape: that this handler asks for the filtered set at all. Dropping
 * `excludeSuperseded` is a one-line regression that no other test would catch.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { listDecisionLogThreads, hasProjectAccess, userStoryFindFirst } =
	vi.hoisted(() => ({
		listDecisionLogThreads: vi.fn(),
		hasProjectAccess: vi.fn(),
		userStoryFindFirst: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	listDecisionLogThreads,
	hasProjectAccess,
	db: { userStory: { findFirst: userStoryFindFirst } },
}));

import { FeatureDecisionsHandler } from "../src/activities/orchestrator/execution/handlers/feature-decisions-handler";

describe("feature-decisions agent tool — superseded answers", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		hasProjectAccess.mockResolvedValue(true);
		userStoryFindFirst.mockResolvedValue({
			id: "s1",
			identifier: "F-001",
			title: "A feature",
		});
		listDecisionLogThreads.mockResolvedValue([]);
	});

	it("requests the superseded-filtered thread set", async () => {
		const handler = new FeatureDecisionsHandler();
		const result = await handler.execute({
			input: {
				userId: "u1",
				organizationId: "o1",
				projectId: "p1",
				step: { inputs: { storyId: "s1" } },
			},
		} as never);

		// The handler must have reached the query — a short-circuit here would make
		// the assertion below vacuous, which is the whole failure mode this guards.
		expect(result.handled).toBe(true);
		expect(listDecisionLogThreads).toHaveBeenCalledTimes(1);
		expect(listDecisionLogThreads).toHaveBeenCalledWith(
			expect.objectContaining({
				userStoryId: "s1",
				excludeSuperseded: true,
			}),
		);
	});
});
