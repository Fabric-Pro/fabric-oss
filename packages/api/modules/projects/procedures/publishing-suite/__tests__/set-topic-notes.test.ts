import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `setTopicNotes` — a topic's private notebook. Handler-level, mirroring
 * `update-topic-assignees.test.ts`.
 *
 * Three things here are load-bearing rather than hygiene:
 *
 * TRIM TO TEST, STORE UNTRIMMED. Whitespace-only input clears the column, but
 * anything else is stored exactly as typed. A notebook that silently eats the
 * trailing blank line on every autosave is one that fights the person typing in
 * it, so the two halves are asserted separately — an implementation that
 * trimmed before storing would still pass a test that only checked clearing.
 *
 * TENANCY COMES FROM THE PROJECT. `organizationId` is an F2 client-org shape
 * guard this handler never reads. Pinned with exact equality, not
 * `objectContaining`, so an added tenant key fails rather than slips through.
 *
 * NOTES ARE NEVER AI INPUT. Asserted here as a module-level fact rather than a
 * behaviour: this file imports nothing from the prompt/generation layer, and
 * the column appears in no AI-facing select. The guard that matters lives in
 * the Temporal generation activities, each of which lists its columns
 * explicitly — see the procedure's own doc comment.
 */

const flagMocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
}));
const dbMocks = vi.hoisted(() => ({
	setPublishingTopicNotes: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	setPublishingTopicNotes: dbMocks.setPublishingTopicNotes,
	// `resolveProjectTenant` MUST point at flagMocks, not a bare vi.fn(): the
	// gate reads a null return as "project not resolvable" and throws NOT_FOUND,
	// so an unconfigured mock would fail every test here for the wrong reason.
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

import { setPublishingTopicNotes } from "@repo/database";
import { setPublishingTopicNotesProcedure } from "../set-topic-notes";

const handler = (
	setPublishingTopicNotesProcedure as unknown as { handler: Function }
).handler;
const permission = (
	setPublishingTopicNotesProcedure as unknown as { __permission: string }
).__permission;

const BASE_INPUT = {
	projectId: "project-1",
	topicId: "topic-1",
	organizationId: "org-1",
};
const CONTEXT = { user: { id: "actor-1", name: "Ada" } };

function call(notes: string, over: Record<string, unknown> = {}) {
	return handler({
		input: { ...BASE_INPUT, notes, ...over },
		context: CONTEXT,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	flagMocks.isFeatureEnabled.mockResolvedValue(true);
	// ADR-018 ("An organization is the only tenant context").
	flagMocks.resolveProjectTenant.mockResolvedValue({
		organizationId: "org-1",
		userId: "u1",
	});
	dbMocks.setPublishingTopicNotes.mockResolvedValue(1);
});

describe("setTopicNotes procedure", () => {
	it("is gated on PUBLISHING_TOPIC_UPDATE", () => {
		expect(permission).toBe("publishing-topic:update");
	});

	it("refuses when the Publishing Suite feature flag is off", async () => {
		flagMocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(call("Some thoughts")).rejects.toThrow(
			/Publishing Suite is not enabled/,
		);
		expect(setPublishingTopicNotes).not.toHaveBeenCalled();
	});

	it("saves the notebook and reports saved", async () => {
		await expect(call("Some thoughts")).resolves.toEqual({ saved: true });

		expect(setPublishingTopicNotes).toHaveBeenCalledWith({
			id: "topic-1",
			projectId: "project-1",
			notes: "Some thoughts",
		});
	});

	it("stores the text UNTRIMMED — the trim only decides whether it is empty", async () => {
		// The half a naive implementation gets wrong: it trims to test, then
		// stores the trimmed value, and every autosave quietly rewrites what the
		// person typed.
		await call("  line one\n\n  ");

		expect(setPublishingTopicNotes).toHaveBeenCalledWith(
			expect.objectContaining({ notes: "  line one\n\n  " }),
		);
	});

	it("clears the column when the submission is empty", async () => {
		await expect(call("")).resolves.toEqual({ saved: true });

		expect(setPublishingTopicNotes).toHaveBeenCalledWith({
			id: "topic-1",
			projectId: "project-1",
			notes: null,
		});
	});

	it("clears the column when the submission is whitespace only", async () => {
		await call("   \n\t  ");

		expect(setPublishingTopicNotes).toHaveBeenCalledWith(
			expect.objectContaining({ notes: null }),
		);
	});

	it("surfaces a cross-tenant miss as NOT_FOUND — the same answer a missing topic gives", async () => {
		// The helper's `updateMany` is scoped on (id, projectId), so a topic id
		// from another project matches no row and comes back 0.
		dbMocks.setPublishingTopicNotes.mockResolvedValue(0);

		await expect(call("Some thoughts")).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
	});

	it("cannot be redirected by a caller-supplied organizationId", async () => {
		await call("Some thoughts", {
			organizationId: "org-the-caller-typed",
		});

		// EXACT equality: the regression this guards against is a tenant key
		// being added to the write.
		expect(setPublishingTopicNotes).toHaveBeenCalledWith({
			id: "topic-1",
			projectId: "project-1",
			notes: "Some thoughts",
		});
	});

	it("ignores organizationId: null the same way — it is a shape guard, never a route", async () => {
		await call("Some thoughts", { organizationId: null });

		expect(setPublishingTopicNotes).toHaveBeenCalledWith({
			id: "topic-1",
			projectId: "project-1",
			notes: "Some thoughts",
		});
	});

	it("never touches the summary — a notebook write is not an edit to generation input", async () => {
		await call("Some thoughts");

		const [args] = dbMocks.setPublishingTopicNotes.mock.calls[0];
		expect(args).not.toHaveProperty("pitch");
		expect(args).not.toHaveProperty("pitchUpdatedAt");
	});
});
