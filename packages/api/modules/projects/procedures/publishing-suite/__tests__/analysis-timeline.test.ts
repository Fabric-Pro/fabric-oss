import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `listAnalysisTimeline` — the unified analysis version sequence.
 * Handler-level, mirroring `update-topic-assignees.test.ts`: the procedure
 * chain and the DB layer are mocked, so what is under test is the handler's own
 * contract. The projection itself is proved in
 * `packages/database/__tests__/publishing-analysis-timeline.test.ts`.
 *
 * Two things here are load-bearing:
 *
 * READ-PERMISSIVE. Gated on PUBLISHING_TOPIC_READ and deliberately WITHOUT the
 * `requireEligibleProjectForTopic` ratchet, matching
 * `listAnalysisRevisionsProcedure`. That ratchet filters archived and
 * soft-deleted projects, which is right for a write and wrong for a read — it
 * would 404 this history on an archived project while the tab's own
 * current-state read kept rendering. Asserted by the absence of the import, and
 * by the handler still answering when nothing about eligibility is configured.
 *
 * TENANCY COMES FROM THE PROJECT. `organizationId` is an F2 shape guard the
 * handler never reads; the DB call is pinned with exact equality so an added
 * tenant key fails rather than slips through.
 */

const flagMocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
}));
const dbMocks = vi.hoisted(() => ({
	listAnalysisTimeline: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listAnalysisTimeline: dbMocks.listAnalysisTimeline,
	// `resolveProjectTenant` MUST point at flagMocks: the gate reads a null
	// return as "project not resolvable" and throws NOT_FOUND, so an
	// unconfigured mock would fail every test here for the wrong reason.
	isFeatureEnabled: flagMocks.isFeatureEnabled,
	resolveProjectTenant: flagMocks.resolveProjectTenant,
}));
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
		},
	};
});

import { listAnalysisTimeline } from "@repo/database";
import { listAnalysisTimelineProcedure } from "../analysis-timeline";

const handler = (
	listAnalysisTimelineProcedure as unknown as { handler: Function }
).handler;
const permission = (
	listAnalysisTimelineProcedure as unknown as { __permission: string }
).__permission;

const BASE_INPUT = {
	projectId: "project-1",
	topicId: "topic-1",
	organizationId: "org-1",
};
const CONTEXT = { user: { id: "actor-1", name: "Ada" } };

const PAGE = {
	entries: [
		{
			kind: "revision" as const,
			seq: 7,
			revisionId: "revision-1",
			revisionVersion: 1,
			sourceAnalysisVersion: 6,
			sourceSeq: 6,
			changeSummary: null,
			createdAt: new Date("2026-09-01T00:07:00Z"),
			author: { id: "u2", name: "Grace" },
		},
	],
	nextCursor: 6,
};

function call(over: Record<string, unknown> = {}) {
	return handler({ input: { ...BASE_INPUT, ...over }, context: CONTEXT });
}

beforeEach(() => {
	vi.clearAllMocks();
	flagMocks.isFeatureEnabled.mockResolvedValue(true);
	flagMocks.resolveProjectTenant.mockResolvedValue({
		organizationId: "org-1",
		userId: "u1",
	});
	dbMocks.listAnalysisTimeline.mockResolvedValue(PAGE);
});

describe("listAnalysisTimeline procedure", () => {
	it("is gated on PUBLISHING_TOPIC_READ, not UPDATE", () => {
		expect(permission).toBe("publishing-topic:read");
	});

	it("refuses when the Publishing Suite feature flag is off", async () => {
		flagMocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(call()).rejects.toThrow(/Publishing Suite is not enabled/);
		expect(listAnalysisTimeline).not.toHaveBeenCalled();
	});

	it("returns the page and its cursor verbatim", async () => {
		await expect(call()).resolves.toEqual({
			entries: PAGE.entries,
			nextCursor: 6,
		});
	});

	it("passes cursor and limit through to the query", async () => {
		await call({ cursor: 6, limit: 10 });

		expect(listAnalysisTimeline).toHaveBeenCalledWith({
			topicId: "topic-1",
			projectId: "project-1",
			cursor: 6,
			limit: 10,
		});
	});

	it("cannot be redirected by a caller-supplied organizationId", async () => {
		await call({ organizationId: "org-the-caller-typed" });

		// EXACT equality: the regression this guards against is a tenant key
		// reaching the query.
		expect(listAnalysisTimeline).toHaveBeenCalledWith({
			topicId: "topic-1",
			projectId: "project-1",
			cursor: undefined,
			limit: undefined,
		});
	});

	it("surfaces a topic with no history as an empty page, never an error", async () => {
		// Same answer a topic id from another project produces — this endpoint
		// cannot be used to probe for topics the caller cannot see (DV16).
		dbMocks.listAnalysisTimeline.mockResolvedValue({
			entries: [],
			nextCursor: null,
		});

		await expect(call()).resolves.toEqual({
			entries: [],
			nextCursor: null,
		});
	});

	it("keeps nextCursor in the response even when null", async () => {
		dbMocks.listAnalysisTimeline.mockResolvedValue({
			entries: PAGE.entries,
			nextCursor: null,
		});

		const result = await call();

		// Present-and-null, so a client can tell "no more pages" from "this
		// server does not page".
		expect(result).toHaveProperty("nextCursor", null);
	});

	it("does NOT apply the archived/soft-deleted project ratchet — reads stay permissive", async () => {
		// The write sibling calls `requireEligibleProjectForTopic`; this read
		// must not, or the drawer 404s on an archived project while the tab's
		// own current-state read keeps rendering. Nothing about project
		// eligibility is configured in this file, so a handler that consulted it
		// would throw here rather than answer.
		await expect(call()).resolves.toMatchObject({ nextCursor: 6 });
	});
});
