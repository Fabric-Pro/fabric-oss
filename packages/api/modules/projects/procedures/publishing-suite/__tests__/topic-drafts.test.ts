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

vi.mock("@repo/database", () => ({
	listTopicDrafts: vi.fn(),
}));
const flagMocks = vi.hoisted(() => ({
	isPublishingSuiteEnabled: vi.fn(() => true),
}));
vi.mock("@repo/utils/feature-flag", () => ({
	isPublishingSuiteEnabled: flagMocks.isPublishingSuiteEnabled,
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

beforeEach(() => {
	vi.clearAllMocks();
	flagMocks.isPublishingSuiteEnabled.mockReturnValue(true);
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
		flagMocks.isPublishingSuiteEnabled.mockReturnValue(false);

		await expect(handler({ input: INPUT })).rejects.toThrow(
			/Publishing Suite is not enabled/,
		);
		// And nothing reached the database.
		expect(listTopicDrafts).not.toHaveBeenCalled();
	});

	it("scopes the read by BOTH projectId and topicId", async () => {
		await handler({ input: INPUT });

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
		await handler({ input: INPUT });

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

		await expect(handler({ input: INPUT })).resolves.toEqual(payload);
	});
});
