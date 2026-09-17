import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `updateTopicSummary` — hand-editing a topic's summary (`pitch`).
 * Handler-level, mirroring `update-topic-assignees.test.ts`: the procedure
 * chain and the DB layer are mocked, so what is under test is the handler's own
 * contract.
 *
 * Two things here are load-bearing rather than hygiene:
 *
 * TENANCY COMES FROM THE PROJECT. `organizationId` is an F2 client-org shape
 * guard that this handler never reads. The assertions below pin the DB call to
 * EXACTLY `{ id, projectId, pitch }` — an exact-equality check, not
 * `objectContaining`, because the regression worth catching is a tenant key
 * being ADDED, and `objectContaining` would pass straight through it.
 *
 * NULL IS A VALUE, NOT AN OMISSION. `pitch: null` clears the summary and must
 * reach the helper as `null`. A handler that coalesced it away would turn
 * "delete this summary" into a silent no-op that still reported success.
 */

const flagMocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
}));
const dbMocks = vi.hoisted(() => ({
	updatePublishingTopicSummary: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	updatePublishingTopicSummary: dbMocks.updatePublishingTopicSummary,
	// The gate resolves the flag per organization and derives the tenant from
	// the Project row. `resolveProjectTenant` MUST point at flagMocks, not a
	// bare vi.fn(): the gate reads a null return as "project not resolvable"
	// and throws NOT_FOUND, so an unconfigured mock would fail every test in
	// this file for the wrong reason.
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
			PUBLISHING_TOPIC_UPDATE: "publishing-topic:update",
		},
	};
});

import { updatePublishingTopicSummary } from "@repo/database";
import { updatePublishingTopicSummaryProcedure } from "../update-topic-summary";

const handler = (
	updatePublishingTopicSummaryProcedure as unknown as { handler: Function }
).handler;
const permission = (
	updatePublishingTopicSummaryProcedure as unknown as { __permission: string }
).__permission;

const BASE_INPUT = {
	projectId: "project-1",
	topicId: "topic-1",
	organizationId: "org-1",
};
const CONTEXT = { user: { id: "actor-1", name: "Ada" } };

function call(pitch: string | null, over: Record<string, unknown> = {}) {
	return handler({
		input: { ...BASE_INPUT, pitch, ...over },
		context: CONTEXT,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	flagMocks.isFeatureEnabled.mockResolvedValue(true);
	// ADR-018 ("An organization is the only tenant context"): the default
	// tenant here is org-scoped, not personal.
	flagMocks.resolveProjectTenant.mockResolvedValue({
		organizationId: "org-1",
		userId: "u1",
	});
	dbMocks.updatePublishingTopicSummary.mockResolvedValue(1);
});

describe("updateTopicSummary procedure", () => {
	it("is gated on PUBLISHING_TOPIC_UPDATE", () => {
		expect(permission).toBe("publishing-topic:update");
	});

	it("refuses when the Publishing Suite feature flag is off", async () => {
		flagMocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(call("A new summary")).rejects.toThrow(
			/Publishing Suite is not enabled/,
		);
		expect(updatePublishingTopicSummary).not.toHaveBeenCalled();
	});

	it("writes the summary and reports saved", async () => {
		await expect(call("A new summary")).resolves.toEqual({ saved: true });

		expect(updatePublishingTopicSummary).toHaveBeenCalledWith({
			id: "topic-1",
			projectId: "project-1",
			pitch: "A new summary",
		});
	});

	it("passes null straight through to clear the summary", async () => {
		await expect(call(null)).resolves.toEqual({ saved: true });

		expect(updatePublishingTopicSummary).toHaveBeenCalledWith({
			id: "topic-1",
			projectId: "project-1",
			pitch: null,
		});
	});

	it("does NOT trim the summary — the stored text is what was submitted", async () => {
		// Unlike the notes endpoint, there is no empty-means-clear rule here:
		// `null` already says "clear", so whitespace is just whitespace.
		await call("  padded  ");

		expect(updatePublishingTopicSummary).toHaveBeenCalledWith(
			expect.objectContaining({ pitch: "  padded  " }),
		);
	});

	it("surfaces a cross-tenant miss as NOT_FOUND — the same answer a missing topic gives", async () => {
		// The helper's `updateMany` is scoped on (id, projectId), so a topic id
		// from another project matches no row and comes back 0. Answering
		// NOT_FOUND rather than FORBIDDEN is what stops this route being used to
		// probe for topics in projects the caller cannot see.
		dbMocks.updatePublishingTopicSummary.mockResolvedValue(0);

		await expect(call("A new summary")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	it("cannot be redirected by a caller-supplied organizationId", async () => {
		await call("A new summary", {
			organizationId: "org-the-caller-typed",
		});

		// EXACT equality, not objectContaining: the regression this guards
		// against is a tenant key being added to the write, and a containment
		// check would sail past it.
		expect(updatePublishingTopicSummary).toHaveBeenCalledWith({
			id: "topic-1",
			projectId: "project-1",
			pitch: "A new summary",
		});
	});

	it("ignores organizationId: null the same way — it is a shape guard, never a route", async () => {
		await call("A new summary", { organizationId: null });

		expect(updatePublishingTopicSummary).toHaveBeenCalledWith({
			id: "topic-1",
			projectId: "project-1",
			pitch: "A new summary",
		});
	});

	it("never passes a `now` override — the stamp is the server's clock", async () => {
		await call("A new summary");

		const [args] = dbMocks.updatePublishingTopicSummary.mock.calls[0];
		expect(args).not.toHaveProperty("now");
	});
});
