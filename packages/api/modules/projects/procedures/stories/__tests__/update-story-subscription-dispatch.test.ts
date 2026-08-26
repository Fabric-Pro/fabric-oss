/**
 * Dispatch-gating for subscriber notifications on feature (story) update.
 *
 *  - title-only edit (updateStory leaves version untouched) → NO notify
 *  - description change (version bumped) → notify with changeKind "content"
 *
 * Mocks the db + side-effects + oRPC chain so the handler is a plain function;
 * asserts on the fanOut.subscriptionUpdate spy.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { priorFindFirst, updateStoryFn, subUpdate, assigned } = vi.hoisted(
	() => ({
		priorFindFirst: vi.fn(),
		updateStoryFn: vi.fn(),
		subUpdate: vi.fn(),
		assigned: vi.fn(),
	}),
);

vi.mock("@repo/database", async () => {
	const { z } = await import("zod");
	// Real schemas so `.optional()` in the procedure's input builder works.
	return {
		db: { userStory: { findFirst: priorFindFirst, findUnique: vi.fn() } },
		updateStory: updateStoryFn,
		FeatureDraftingStageSchema: z.string(),
		MaturationStatusSchema: z.string(),
	};
});

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: {
		subscriptionUpdate: subUpdate.mockResolvedValue(undefined),
		assigned: assigned.mockResolvedValue(undefined),
	},
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: vi.fn(),
}));

// `update-story` now runs the Ready-for-Dev auto-draft trigger, whose module
// graph reaches the Temporal client. Mocked at the trigger so this suite
// stays about its own subject and never loads a workflow client.
vi.mock("../../../lib/auto-draft-test-cases", () => ({
	maybeAutoDraftOnStageChange: vi.fn(),
}));
vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../../lib/validate-stage-for-kind", () => ({
	validateStageForKind: vi.fn(),
}));

vi.mock("../../scan/lib/start-scan", () => ({
	maybeTriggerMaturationScan: vi.fn(),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const makeChain = () => {
		const chain: any = {
			use: () => chain,
			route: () => chain,
			input: () => chain,
			output: () => chain,
			handler: (h: any) => h,
		};
		return chain;
	};
	return {
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => () => undefined,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		get tenantProtectedProcedure() {
			return makeChain();
		},
	};
});

import { updateStoryProcedure } from "../update-story";

const ctx = {
	context: { user: { id: "u1", name: "Alice" }, session: {} },
} as const;

beforeEach(() => {
	vi.clearAllMocks();
});

async function run(input: Record<string, unknown>) {
	return (updateStoryProcedure as any)({
		...ctx,
		input: { projectId: "p1", storyId: "story-1", ...input },
	});
}

describe("update-story subscriber dispatch gating", () => {
	it("does NOT notify on a title-only edit (version unchanged)", async () => {
		priorFindFirst.mockResolvedValue({
			assigneeId: null,
			title: "Old",
			version: 2,
		});
		updateStoryFn.mockResolvedValue({
			id: "story-1",
			title: "New title",
			version: 2, // updateStory does not bump on title-only
			pmAutoSyncEnabled: false,
			externalId: null,
		});

		await run({ title: "New title" });

		expect(subUpdate).not.toHaveBeenCalled();
	});

	it("notifies with changeKind 'content' when the version bumps", async () => {
		priorFindFirst.mockResolvedValue({
			assigneeId: null,
			title: "Feature",
			version: 2,
		});
		updateStoryFn.mockResolvedValue({
			id: "story-1",
			title: "Feature",
			version: 3, // bumped → real content change
			pmAutoSyncEnabled: false,
			externalId: null,
		});

		await run({ description: "new description" });

		expect(subUpdate).toHaveBeenCalledTimes(1);
		expect(subUpdate.mock.calls[0][0]).toMatchObject({
			subjectType: "FEATURE",
			subjectId: "story-1",
			changeKind: "content",
		});
	});
});
