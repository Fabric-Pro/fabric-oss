import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `summarizeAnalysisChanges` — the confirm-time digest of an assistant rewrite.
 * Handler-level, mirroring `set-topic-notes.test.ts`.
 *
 * Four things here are load-bearing rather than hygiene:
 *
 * READ-GATED, AND READ-ONLY. `PUBLISHING_TOPIC_READ`, not UPDATE: reading a
 * summary of a proposal is not an edit, and a member who can see the analysis
 * must be able to see what the assistant changed in it. The procedure backs
 * that up by writing nothing — no revision, no outcome event, no topic column —
 * which is what lets it run against unsaved editor text without racing
 * `saveAnalysisRevision`.
 *
 * TENANCY COMES FROM THE PROJECT. `organizationId` is an F2 client-org shape
 * guard this handler never scopes by; the org handed to the model resolver is
 * the one on the loaded Project row. Pinned with exact equality so an added
 * tenant key fails rather than slips through.
 *
 * THE RATCHET RUNS EVEN THOUGH THIS IS A READ. `requireEligibleProjectForTopic`
 * is what derives that org (SOC 2 CC6.1/CC6.3) and what stops a model call
 * being opened against an archived project — the deliberate exception to
 * `analysis-revision.ts`'s read-permissive rule, which exists to stop a panel
 * 404ing beside a sibling that renders. Nothing renders here on refusal.
 *
 * ADVISORY. A model failure propagates rather than becoming `[]`: the two are
 * different facts and only the caller can act on the difference.
 */

const flagMocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
	projectFindFirst: vi.fn(),
}));
const libMocks = vi.hoisted(() => ({
	summarizeAnalysisChanges: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	// `resolveProjectTenant` MUST point at flagMocks, not a bare vi.fn(): the
	// gate reads a null return as "project not resolvable" and throws NOT_FOUND,
	// so an unconfigured mock would fail every test here for the wrong reason.
	isFeatureEnabled: flagMocks.isFeatureEnabled,
	resolveProjectTenant: flagMocks.resolveProjectTenant,
	db: { project: { findFirst: flagMocks.projectFindFirst } },
}));
vi.mock("../../../lib/summarize-analysis-changes", () => ({
	summarizeAnalysisChanges: libMocks.summarizeAnalysisChanges,
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

import { summarizeAnalysisChanges } from "../../../lib/summarize-analysis-changes";
import { summarizeAnalysisChangesProcedure } from "../summarize-analysis-changes";

const handler = (
	summarizeAnalysisChangesProcedure as unknown as { handler: Function }
).handler;
const permission = (
	summarizeAnalysisChangesProcedure as unknown as { __permission: string }
).__permission;

const BASE_INPUT = {
	projectId: "project-1",
	topicId: "topic-1",
	organizationId: "org-1",
	before: "### Risks\nbefore",
	after: "### Risks\nafter",
};
const CONTEXT = { user: { id: "actor-1", name: "Ada" } };

function call(over: Record<string, unknown> = {}) {
	return handler({ input: { ...BASE_INPUT, ...over }, context: CONTEXT });
}

beforeEach(() => {
	vi.clearAllMocks();
	flagMocks.isFeatureEnabled.mockResolvedValue(true);
	// ADR-018 ("An organization is the only tenant context").
	flagMocks.resolveProjectTenant.mockResolvedValue({
		organizationId: "org-1",
		userId: "u1",
	});
	flagMocks.projectFindFirst.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	libMocks.summarizeAnalysisChanges.mockResolvedValue([
		"Risks — added a customer-consent caveat",
	]);
});

describe("summarizeAnalysisChanges procedure", () => {
	it("is gated on PUBLISHING_TOPIC_READ", () => {
		expect(permission).toBe("publishing-topic:read");
	});

	it("refuses when the Publishing Suite feature flag is off", async () => {
		flagMocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(call()).rejects.toThrow(/Publishing Suite is not enabled/);
		expect(summarizeAnalysisChanges).not.toHaveBeenCalled();
	});

	it("gates BEFORE the project is loaded, so a disabled suite reveals nothing", async () => {
		flagMocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(call()).rejects.toThrow(/Publishing Suite is not enabled/);
		expect(flagMocks.projectFindFirst).not.toHaveBeenCalled();
	});

	it("returns the summarizer's bullets under `changeSummary`", async () => {
		await expect(call()).resolves.toEqual({
			changeSummary: ["Risks — added a customer-consent caveat"],
		});
	});

	it("passes an empty summary through — nothing substantive changed", async () => {
		libMocks.summarizeAnalysisChanges.mockResolvedValue([]);

		await expect(call()).resolves.toEqual({ changeSummary: [] });
	});

	it("takes the tenant from the PROJECT ROW, never from caller input", async () => {
		flagMocks.projectFindFirst.mockResolvedValue({
			id: "project-1",
			organizationId: "org-from-row",
		});

		await call({ organizationId: null });

		expect(summarizeAnalysisChanges).toHaveBeenCalledWith({
			before: BASE_INPUT.before,
			after: BASE_INPUT.after,
			tenantFilter: {
				organizationId: "org-from-row",
				userId: "actor-1",
			},
			projectId: "project-1",
		});
	});

	it("only loads an ACTIVE, non-deleted project", async () => {
		await call();

		expect(flagMocks.projectFindFirst).toHaveBeenCalledWith({
			where: { id: "project-1", status: "ACTIVE", deletedAt: null },
			select: { id: true, organizationId: true },
		});
	});

	it("refuses an archived or soft-deleted project as NOT_FOUND", async () => {
		flagMocks.projectFindFirst.mockResolvedValue(null);

		await expect(call()).rejects.toThrow(/Project not found/);
		expect(summarizeAnalysisChanges).not.toHaveBeenCalled();
	});

	it("rejects a positively-wrong organizationId guard", async () => {
		await expect(
			call({ organizationId: "someone-elses-org" }),
		).rejects.toThrow(/organizationId does not match the project/);
		expect(summarizeAnalysisChanges).not.toHaveBeenCalled();
	});

	it("accepts a null guard, which a page with no org in the URL legitimately sends", async () => {
		await expect(call({ organizationId: null })).resolves.toEqual({
			changeSummary: ["Risks — added a customer-consent caveat"],
		});
	});

	it("propagates a model failure instead of reporting an empty summary", async () => {
		libMocks.summarizeAnalysisChanges.mockRejectedValue(
			new Error("model refused"),
		);

		await expect(call()).rejects.toThrow("model refused");
	});

	it("never resolves the topic id to a row — both versions arrive in the body", async () => {
		await call({ topicId: "a-topic-in-another-project" });

		// The only `findFirst` this handler makes is the project ratchet above.
		expect(flagMocks.projectFindFirst).toHaveBeenCalledTimes(1);
		expect(summarizeAnalysisChanges).toHaveBeenCalledWith(
			expect.objectContaining({ projectId: "project-1" }),
		);
	});
});
