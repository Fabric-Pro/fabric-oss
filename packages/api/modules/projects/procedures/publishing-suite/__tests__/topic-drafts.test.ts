import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `listTopicDrafts` — the Topic Item Page's generation-tab read
 * (Fizzy #1853, Phase 2B-1).
 *
 * Handler-level, mirroring `topic-decisions.test.ts`: the procedure chain and
 * the DB layer are both mocked, so what is under test is the handler's own
 * contract — which permission gates it, that the feature flag is honoured, and
 * what it does and does not pass down.
 */

const flagMocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
}));

/**
 * A REAL, hand-written tuple — never `vi.fn()` — for the same construction-time
 * reason as `PUBLISHING_TOPIC_POST_TYPES` below. Named and hoisted separately
 * (rather than inlined into the `@repo/database` mock's returned object) so
 * the parity test further down can compare it against the ACTUAL
 * `@repo/database` export without comparing the mock against itself.
 */
const postTypeMocks = vi.hoisted(() => ({
	MOCK_PUBLISHING_TOPIC_POST_TYPES: [
		"TWEET",
		"LINKEDIN_POST",
		"BLOG_POST",
		"CASE_STUDY",
		"STAKEHOLDER_EMAIL",
		"WEBINAR_SCRIPT",
	],
}));
vi.mock("@repo/database", () => ({
	listTopicDrafts: vi.fn(),
	// Read alongside the drafts so a tab can say it changed since the caller's
	// last visit. Always the CALLER's markers — the input carries no userId.
	getTopicDraftReadMarkers: vi.fn().mockResolvedValue({}),
	markTopicDraftRead: vi.fn().mockResolvedValue(true),
	// A REAL tuple, not a vi.fn(): topic-drafts.ts builds its OUTPUT schema with
	// `z.enum(PUBLISHING_TOPIC_POST_TYPES)` at module load, so a mock function
	// here is a construction-time TypeError rather than a failing assertion.
	// Kept complete rather than trimmed to the types a case happens to use — a
	// post type missing from this list is stripped by output validation, which
	// is the exact silent failure the shared tuple exists to prevent.
	PUBLISHING_TOPIC_POST_TYPES: postTypeMocks.MOCK_PUBLISHING_TOPIC_POST_TYPES,
	// The gate resolves the flag per organization and derives the tenant from
	// the Project row. `resolveProjectTenant` MUST point at flagMocks, not a
	// bare vi.fn(): the gate reads a null return as "project not resolvable"
	// and throws NOT_FOUND, so an unconfigured mock would fail every test in
	// this file for the wrong reason.
	isFeatureEnabled: flagMocks.isFeatureEnabled,
	resolveProjectTenant: flagMocks.resolveProjectTenant,
}));

// Imported OUTSIDE the vi.mock factory above, so this is the REAL tuple —
// comparing it against a value the factory itself produced would be a test
// that cannot fail. An incomplete-but-non-empty mock tuple loads fine and
// silently strips the missing post type via output validation; Task 2's
// `packages/database` pin catches that class in its own package but runs in a
// different vitest project and cannot see this file's `vi.mock` factory,
// which is why this file needs its own copy of the check.
const actualDatabaseModule =
	await vi.importActual<typeof import("@repo/database")>("@repo/database");

it("the mocked post-type tuple matches the real one", () => {
	expect(new Set(postTypeMocks.MOCK_PUBLISHING_TOPIC_POST_TYPES)).toEqual(
		new Set(actualDatabaseModule.PUBLISHING_TOPIC_POST_TYPES),
	);
});
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({
		handler: fn,
		__permission: chain.__permission,
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (p: string) => {
			chain.__permission = p;
			return () => chain;
		},
		Permissions: {
			PUBLISHING_TOPIC_READ: "publishing-topic:read",
			PUBLISHING_TOPIC_UPDATE: "publishing-topic:update",
		},
	};
});

import { listTopicDrafts } from "@repo/database";
import { listTopicDraftsProcedure } from "../topic-drafts";

const handler = (listTopicDraftsProcedure as unknown as { handler: Function })
	.handler;
const permission = (
	listTopicDraftsProcedure as unknown as { __permission: string }
).__permission;

const INPUT = {
	projectId: "project-1",
	topicId: "topic-1",
	organizationId: "org-1",
};

/**
 * The read markers are the CALLER's, always — the procedure takes the user from
 * the session and the input carries no userId, so nobody can read when a
 * colleague last opened a draft.
 */
const CONTEXT = { user: { id: "user-1" } };

beforeEach(() => {
	vi.clearAllMocks();
	flagMocks.isFeatureEnabled.mockResolvedValue(true);
	// ADR-018 ("An organization is the only tenant context"): the default
	// tenant here is org-scoped, not personal — assertPublishingSuiteFeatureEnabled
	// now refuses a project with no organization outright, so a null-organization
	// default would make every test below fail the gate before reaching what it
	// actually means to exercise.
	flagMocks.resolveProjectTenant.mockResolvedValue({
		organizationId: "org-1",
		userId: "u1",
	});
	(listTopicDrafts as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
		drafts: [],
		workingDrafts: [],
	});
});

describe("listTopicDrafts procedure", () => {
	it("is gated on PUBLISHING_TOPIC_READ, the weakest publishing permission", () => {
		// A read, so READ and not UPDATE. Gating a read on UPDATE would hide the
		// tab strip from a viewer who is allowed to see the topic.
		expect(permission).toBe("publishing-topic:read");
	});

	it("refuses when the Publishing Suite feature flag is off", async () => {
		// resolveProjectTenant still resolves — the project is real, only the
		// flag is off — so this fails for the flag reason, not because the
		// project looked unresolvable to the gate.
		flagMocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(
			handler({ input: INPUT, context: CONTEXT }),
		).rejects.toThrow(/Publishing Suite is not enabled/);
		// And nothing reached the database.
		expect(listTopicDrafts).not.toHaveBeenCalled();
	});

	it("scopes the read by BOTH projectId and topicId", async () => {
		await handler({ input: INPUT, context: CONTEXT });

		expect(listTopicDrafts).toHaveBeenCalledWith({
			projectId: "project-1",
			topicId: "topic-1",
		});
	});

	it("never forwards organizationId as a scoping key", async () => {
		// The tenant is settled by the permission middleware and the loaded
		// project row. Passing the client's own organizationId down would make a
		// client input part of the scope, which is the shape every tenancy bug
		// in this area has had.
		await handler({ input: INPUT, context: CONTEXT });

		const passed = (listTopicDrafts as unknown as ReturnType<typeof vi.fn>)
			.mock.calls[0][0];
		expect(passed).not.toHaveProperty("organizationId");
	});

	it("returns what the query layer produced, unchanged", async () => {
		const payload = {
			drafts: [
				{
					postType: "TWEET",
					latestAttempt: null,
					latestReady: null,
				},
			],
			workingDrafts: [],
		};
		(
			listTopicDrafts as unknown as ReturnType<typeof vi.fn>
		).mockResolvedValue(payload);

		// Plus the caller's own read markers, which the procedure fetches
		// alongside — the query layer's payload is passed through untouched.
		await expect(
			handler({ input: INPUT, context: CONTEXT }),
		).resolves.toEqual({ ...payload, readMarkers: {} });
	});
});
