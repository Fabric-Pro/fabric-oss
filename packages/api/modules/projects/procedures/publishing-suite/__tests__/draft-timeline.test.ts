import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `listDraftTimeline` — the unified draft version sequence. Handler-level; the
 * projection itself is proved in
 * `packages/database/__tests__/publishing-draft-timeline.test.ts`.
 *
 * Read-gated and read-permissive, matching `listAnalysisTimelineProcedure`.
 * `organizationId` is an F2 shape guard the handler never reads; the DB call is
 * pinned with exact equality so an added tenant key fails rather than slips
 * through.
 */

const flagMocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
}));
const dbMocks = vi.hoisted(() => ({
	listDraftTimeline: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	listDraftTimeline: dbMocks.listDraftTimeline,
	// `resolveProjectTenant` MUST point at flagMocks: the gate reads a null
	// return as "project not resolvable" and throws NOT_FOUND.
	isFeatureEnabled: flagMocks.isFeatureEnabled,
	resolveProjectTenant: flagMocks.resolveProjectTenant,
}));
vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const meth of ["use", "route", "input", "output"]) {
		chain[meth] = () => chain;
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
		Permissions: { PUBLISHING_TOPIC_READ: "publishing-topic:read" },
	};
});

import { listDraftTimeline } from "@repo/database";
import { listDraftTimelineProcedure } from "../draft-timeline";

const handler = (listDraftTimelineProcedure as unknown as { handler: Function })
	.handler;
const permission = (
	listDraftTimelineProcedure as unknown as { __permission: string }
).__permission;

const BASE_INPUT = {
	projectId: "project-1",
	topicId: "topic-1",
	organizationId: "org-1",
	postType: "BLOG_POST" as const,
};
const CONTEXT = { user: { id: "actor-1", name: "Ada" } };

const PAGE = {
	entries: [
		{
			kind: "restored" as const,
			seq: 3,
			revisionId: "revision-1",
			revisionVersion: 1,
			sourceDraftVersion: 1,
			sourceSeq: 1,
			changeSummary: "Restored from version 1",
			createdAt: new Date("2026-09-17T12:00:00Z"),
			author: { id: "u2", name: "Grace" },
		},
	],
	nextCursor: 2,
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
	dbMocks.listDraftTimeline.mockResolvedValue(PAGE);
});

describe("listDraftTimeline procedure", () => {
	it("is gated on PUBLISHING_TOPIC_READ, not UPDATE", () => {
		expect(permission).toBe("publishing-topic:read");
	});

	it("refuses when the Publishing Suite feature flag is off", async () => {
		flagMocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(call()).rejects.toThrow(/Publishing Suite is not enabled/);
		expect(listDraftTimeline).not.toHaveBeenCalled();
	});

	it("returns the page and its cursor verbatim", async () => {
		await expect(call()).resolves.toEqual({
			entries: PAGE.entries,
			nextCursor: 2,
		});
	});

	it("passes the content type, cursor and limit through", async () => {
		await call({ postType: "TWEET", cursor: 5, limit: 10 });

		expect(listDraftTimeline).toHaveBeenCalledWith({
			topicId: "topic-1",
			projectId: "project-1",
			postType: "TWEET",
			cursor: 5,
			limit: 10,
		});
	});

	it("cannot be redirected by a caller-supplied organizationId", async () => {
		await call({ organizationId: "org-the-caller-typed" });

		// EXACT equality: the regression this guards against is a tenant key
		// reaching the query.
		expect(listDraftTimeline).toHaveBeenCalledWith({
			topicId: "topic-1",
			projectId: "project-1",
			postType: "BLOG_POST",
			cursor: undefined,
			limit: undefined,
		});
	});

	it("surfaces a content type with no history as an empty page, never an error", async () => {
		dbMocks.listDraftTimeline.mockResolvedValue({
			entries: [],
			nextCursor: null,
		});

		await expect(call()).resolves.toEqual({
			entries: [],
			nextCursor: null,
		});
	});

	it("keeps nextCursor in the response even when null", async () => {
		dbMocks.listDraftTimeline.mockResolvedValue({
			entries: PAGE.entries,
			nextCursor: null,
		});

		expect(await call()).toHaveProperty("nextCursor", null);
	});
});
