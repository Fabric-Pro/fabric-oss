/**
 * Handler-level lock: `update-story` neither returns `labels` nor writes a
 * caller-supplied one.
 *
 * `UserStory.labels` is system-owned state for the GitLab label↔status sync
 * pipeline (see `label-status-map` / `pmLabelValues`) plus internal provenance
 * markers like `supersedes:<id>`. The column stays — the sync reads and writes
 * it — but it is not a user-facing concept.
 *
 * SCOPE — this harness mocks the whole oRPC builder, so `input: () => chainable`
 * DISCARDS the zod schema. Therefore:
 *   - proves: the handler's response omits `labels`, and its write payload is an
 *     explicit allowlist that drops `labels` even with validation absent
 *     entirely — a stronger guarantee than one that leans on zod.
 *   - does NOT prove: anything about the input schema. That `labels` is rejected
 *     at the zod layer is untested here; re-adding it to the schema would keep
 *     these green.
 * `no-labels-leak.test.ts` covers the response side across every procedure;
 * this file covers the write side in depth for the one that matters most.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		updateStory: vi.fn(),
		userStoryFindFirst: vi.fn(),
		enqueuePmSync: vi.fn(),
		recordAuditFromRequest: vi.fn(),
		fanOut: vi.fn(),
		maybeTriggerMaturationScan: vi.fn(),
	};
	return { handlers, mocks };
});

/** A row exactly as Prisma returns it: labels present, tags present. */
const DB_ROW = {
	id: "story-1",
	projectId: "project-1",
	identifier: "F-001",
	title: "A feature",
	statusId: "status-1",
	priority: "P2_MEDIUM",
	externalId: null,
	pmAutoSyncEnabled: false,
	version: 1,
	labels: ["workflow::in-review", "supersedes:F-042", "legacy-label"],
	tags: [{ id: "tag-1", value: "checkout", createdById: "user-1" }],
};

vi.mock("@repo/database", () => ({
	db: { userStory: { findFirst: mocks.userStoryFindFirst } },
	updateStory: mocks.updateStory,
	FeatureDraftingStageSchema: { optional: () => ({ nullable: () => ({}) }) },
	MaturationStatusSchema: { optional: () => ({ nullable: () => ({}) }) },
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAuditFromRequest,
}));
// `fanOut` is an object of senders, not a function, and update-story chains
// `.catch()` onto the result (update-story.ts:190-202) — so it must resolve.
vi.mock("../../../../../lib/notification-service", () => ({
	fanOut: {
		subscriptionUpdate: mocks.fanOut,
		mention: vi.fn(),
		reply: vi.fn(),
		assigned: vi.fn(),
	},
}));
// `update-story` now runs the Ready-for-Dev auto-draft trigger, whose module
// graph reaches the Temporal client. Mocked at the trigger so this suite
// stays about its own subject and never loads a workflow client.
vi.mock("../../../lib/auto-draft-test-cases", () => ({
	maybeAutoDraftOnStageChange: vi.fn(),
}));
vi.mock("../../../lib/enqueue-pm-sync", () => ({
	enqueuePmSync: mocks.enqueuePmSync,
}));
vi.mock("../../../lib/validate-stage-for-kind", () => ({
	validateStageForKind: () => undefined,
}));
vi.mock("../scan/lib/start-scan", () => ({
	maybeTriggerMaturationScan: mocks.maybeTriggerMaturationScan,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.updateStory = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null) =>
			organizationId,
	};
});

await import("../update-story");

const ctx = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
	headers: new Headers(),
};

describe("story API boundary — labels", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.updateStory.mockResolvedValue({ ...DB_ROW });
		mocks.userStoryFindFirst.mockResolvedValue({
			id: "story-1",
			externalId: null,
		});
		mocks.fanOut.mockResolvedValue(undefined);
	});

	it("update-story does not return labels, even though the row carries them", async () => {
		const result = (await handlers.updateStory({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				priority: "P1_HIGH",
			},
			context: ctx,
		})) as { story: Record<string, unknown> };

		// The DB helper really did hand back a row with labels...
		expect(mocks.updateStory).toHaveBeenCalled();
		// ...and the boundary dropped them.
		expect(result.story).not.toHaveProperty("labels");
	});

	it("update-story still returns tags — they are the user-facing primitive", async () => {
		const result = (await handlers.updateStory({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				priority: "P1_HIGH",
			},
			context: ctx,
		})) as { story: { tags: unknown } };

		expect(result.story.tags).toEqual([
			{ id: "tag-1", value: "checkout", createdById: "user-1" },
		]);
	});

	it("update-story never writes a caller-supplied `labels` through to the DB", async () => {
		await handlers.updateStory({
			input: {
				projectId: "project-1",
				storyId: "story-1",
				organizationId: null,
				priority: "P1_HIGH",
				// A stale integration still sending the removed field. Zod strips
				// unknown keys, so this arrives as noise; assert it never reaches
				// the write. If it did, it would be pushed to GitLab/ADO by the
				// next sync with no UI to ever remove it.
				labels: ["injected-by-stale-client"],
			},
			context: ctx,
		});

		const writePayload = mocks.updateStory.mock.calls[0]?.[2] as Record<
			string,
			unknown
		>;
		expect(writePayload).not.toHaveProperty("labels");
	});
});
// "By whom" is the half of the requirement that automated verification never
// exercised on a deployed environment: every check there ran as a single
// account, so nothing proved the name follows the acting user rather than being
// fixed, cached, or read from the wrong place.
describe("story API boundary — who an edit is credited to", () => {
	beforeEach(() => {
		mocks.updateStory.mockResolvedValue({ ...DB_ROW });
	});

	const editAs = async (user: { id: string; name?: string | null }) => {
		mocks.updateStory.mockClear();
		await handlers.updateStory({
			input: {
				projectId: "proj-1",
				storyId: "story-1",
				title: `Title from ${user.id}`,
			},
			context: {
				user,
				session: { activeOrganizationId: null },
				headers: new Headers(),
			},
		});
		return mocks.updateStory.mock.calls[0]?.[3] as {
			lastEditedByName?: string | null;
			lastEditedSource?: string;
		};
	};

	it("credits the acting user, and two people are told apart", async () => {
		const first = await editAs({ id: "user-1", name: "Grace Hopper" });
		expect(first.lastEditedByName).toBe("Grace Hopper");
		expect(first.lastEditedSource).toBe("MANUAL");

		const second = await editAs({ id: "user-2", name: "Ada Lovelace" });
		expect(second.lastEditedByName).toBe("Ada Lovelace");
		expect(second.lastEditedSource).toBe("MANUAL");
	});

	it("records no name rather than a stale one when the user has none", async () => {
		await editAs({ id: "user-1", name: "Grace Hopper" });
		const nameless = await editAs({ id: "user-3", name: null });
		expect(nameless.lastEditedByName).toBeNull();
		expect(nameless.lastEditedSource).toBe("MANUAL");
	});
});
