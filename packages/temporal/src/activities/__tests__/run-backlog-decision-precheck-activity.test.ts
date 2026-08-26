/**
 * Behavioral tests for the async backlog decision pre-check (card #1365).
 *
 * `runBacklogDecisionPrecheckActivity` is the thin activity the AI-Update
 * analysis workflow runs OFF the proposal's critical path so generation is never
 * blocked on the ~20s LLM judge. It must:
 *   - build one pre-check item per change (ref.index preserved, title + flattened
 *     text) via the shared `buildBacklogPrecheckItems` helper,
 *   - call `runDecisionPrecheck` with `surface: "backlog_proposal"`,
 *   - return that result verbatim (the workflow folds findings into its
 *     queryable proposal),
 *   - never throw (delegating degradation to `runDecisionPrecheck`).
 *
 * The pre-check module is mocked so we assert the wiring, not the judge.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChangeProposal } from "../backlog-context/analyze-context";

const { mocks } = vi.hoisted(() => ({
	mocks: {
		runDecisionPrecheck: vi.fn(),
	},
}));

vi.mock("../../lib/decision-precheck", () => ({
	runDecisionPrecheck: (...args: unknown[]) =>
		mocks.runDecisionPrecheck(...args),
}));

const { buildBacklogPrecheckItems, runBacklogDecisionPrecheckActivity } =
	await import("../backlog-context/analyze-context");

const changes: ChangeProposal["changes"] = [
	{
		type: "feature",
		action: "create",
		title: { to: "Add caching layer" },
		description: { to: "Introduce a Redis cache in front of the API." },
		acceptanceCriteria: { to: "Cache hit ratio > 80%." },
		reasoning: "Discussed in the meeting as a perf win.",
		sourceContext: "meeting_transcript",
	},
	{
		type: "bug",
		action: "create",
		title: { to: "Fix login redirect loop" },
		reasoning: "Users report an infinite redirect on SSO login.",
		sourceContext: "slack_messages",
	},
];

const okResult = {
	checkedAt: "2020-01-01T00:00:00.000Z",
	status: "ok" as const,
	findings: [],
};

const conflictResult = {
	checkedAt: "2020-01-01T00:00:00.000Z",
	status: "conflicts" as const,
	findings: [
		{
			decisionId: "dec-1",
			decisionIdentifier: "ADR-003",
			decisionTitle: "Use Postgres for storage",
			natureOfConflict: "Reintroduces Redis as a datastore.",
			conflictType: "violates_accepted" as const,
			confidence: 0.9,
			changeRef: { index: 0, title: "Add caching layer" },
		},
	],
};

const params = {
	projectId: "project-1",
	userId: "user-1",
	organizationId: "org-1",
	changes,
};

beforeEach(() => {
	mocks.runDecisionPrecheck.mockReset();
	mocks.runDecisionPrecheck.mockResolvedValue(okResult);
});

describe("buildBacklogPrecheckItems", () => {
	it("builds one item per change with ref.index/title and flattened text", () => {
		const items = buildBacklogPrecheckItems(changes);
		expect(items).toHaveLength(2);
		expect(items[0]?.ref).toEqual({ index: 0, title: "Add caching layer" });
		// Flattened text folds title + description + acceptance criteria + reasoning.
		expect(items[0]?.text).toContain("Add caching layer");
		expect(items[0]?.text).toContain("Redis cache");
		expect(items[0]?.text).toContain("Cache hit ratio > 80%");
		expect(items[0]?.text).toContain("perf win");
		expect(items[1]?.ref).toEqual({
			index: 1,
			title: "Fix login redirect loop",
		});
	});
});

describe("runBacklogDecisionPrecheckActivity", () => {
	it("calls runDecisionPrecheck with the backlog surface + built items", async () => {
		await runBacklogDecisionPrecheckActivity(params);

		expect(mocks.runDecisionPrecheck).toHaveBeenCalledTimes(1);
		const arg = mocks.runDecisionPrecheck.mock.calls[0]?.[0] as {
			projectId: string;
			userId: string;
			organizationId?: string;
			artifact: {
				surface: string;
				items: Array<{ ref?: { index: number } }>;
			};
		};
		expect(arg.projectId).toBe("project-1");
		expect(arg.userId).toBe("user-1");
		expect(arg.organizationId).toBe("org-1");
		expect(arg.artifact.surface).toBe("backlog_proposal");
		expect(arg.artifact.items).toEqual(buildBacklogPrecheckItems(changes));
	});

	it("returns the pre-check result verbatim (findings for the workflow to fold in)", async () => {
		mocks.runDecisionPrecheck.mockResolvedValue(conflictResult);
		const result = await runBacklogDecisionPrecheckActivity(params);
		expect(result).toEqual(conflictResult);
	});

	it("returns the empty 'ok' result when there are no conflicts", async () => {
		const result = await runBacklogDecisionPrecheckActivity(params);
		expect(result.status).toBe("ok");
		expect(result.findings).toHaveLength(0);
	});
});
