import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `updateTopicContributors` — the topic's user contributor override
 * (Fizzy #2311-ish, Task 4). Handler-level, mirroring `topic-drafts.test.ts`:
 * the procedure chain and the DB layer are both mocked, so what is under test
 * is the handler's own contract — which permission gates it, that the feature
 * flag is honoured, and the membership/grandfather check that makes this
 * endpoint safe.
 *
 * The check is security-critical, not hygiene: `resolveContributorNames`
 * (packages/temporal) runs an UNSCOPED `db.user.findMany({ where: { id: { in:
 * ids } } })` on whatever ids land in `contributors`, justified by those ids
 * being server-written. This procedure makes them user-written, so an
 * unchecked id would let any caller read back an arbitrary user's display
 * name. Every submitted id MUST be either a current project member
 * (`getProjectMembers`) or already present in the topic's current effective
 * contributor set (`getPublishingTopicEffectiveContributorIds`, the
 * "grandfather" rule) before the write is allowed.
 */

const flagMocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
}));
const dbMocks = vi.hoisted(() => ({
	getProjectMembers: vi.fn(),
	getPublishingTopicEffectiveContributorIds: vi.fn(),
	updatePublishingTopicContributors: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getProjectMembers: dbMocks.getProjectMembers,
	getPublishingTopicEffectiveContributorIds:
		dbMocks.getPublishingTopicEffectiveContributorIds,
	updatePublishingTopicContributors:
		dbMocks.updatePublishingTopicContributors,
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

import {
	getProjectMembers,
	getPublishingTopicEffectiveContributorIds,
	updatePublishingTopicContributors,
} from "@repo/database";
import { updatePublishingTopicContributorsProcedure } from "../update-topic-contributors";

const handler = (
	updatePublishingTopicContributorsProcedure as unknown as {
		handler: Function;
	}
).handler;
const permission = (
	updatePublishingTopicContributorsProcedure as unknown as {
		__permission: string;
	}
).__permission;

const BASE_INPUT = {
	projectId: "project-1",
	topicId: "topic-1",
	organizationId: "org-1",
};

function memberRow(userId: string) {
	return {
		userId,
		role: "MEMBER",
		user: {
			id: userId,
			name: "A Member",
			email: "member@example.com",
			image: null,
		},
		isOwner: false,
		isCreator: false,
		isGuest: false,
		invitedAt: new Date("2026-01-01T00:00:00Z"),
		acceptedAt: new Date("2026-01-02T00:00:00Z"),
		expiresAt: null,
	};
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
	dbMocks.getProjectMembers.mockResolvedValue([memberRow("member-1")]);
	// Default: the topic carries no effective contributors of its own, so
	// most tests exercise the plain membership check. Tests for the
	// grandfather rule override this explicitly.
	dbMocks.getPublishingTopicEffectiveContributorIds.mockResolvedValue([]);
	dbMocks.updatePublishingTopicContributors.mockResolvedValue({
		topic: { id: "topic-1", contributors: ["member-1"] },
	});
});

describe("updateTopicContributors procedure", () => {
	it("is gated on PUBLISHING_TOPIC_UPDATE", () => {
		expect(permission).toBe("publishing-topic:update");
	});

	it("refuses when the Publishing Suite feature flag is off", async () => {
		flagMocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(
			handler({
				input: { ...BASE_INPUT, contributorUserIds: ["member-1"] },
			}),
		).rejects.toThrow(/Publishing Suite is not enabled/);
		expect(getProjectMembers).not.toHaveBeenCalled();
		expect(updatePublishingTopicContributors).not.toHaveBeenCalled();
	});

	it("accepts a member id and reaches updatePublishingTopicContributors", async () => {
		await handler({
			input: { ...BASE_INPUT, contributorUserIds: ["member-1"] },
		});

		expect(updatePublishingTopicContributors).toHaveBeenCalledWith({
			id: "topic-1",
			projectId: "project-1",
			contributorUserIds: ["member-1"],
		});
	});

	it("rejects a non-member id with BAD_REQUEST and never calls the DB helper", async () => {
		dbMocks.getProjectMembers.mockResolvedValue([memberRow("member-1")]);

		await expect(
			handler({
				input: { ...BASE_INPUT, contributorUserIds: ["a-stranger"] },
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(updatePublishingTopicContributors).not.toHaveBeenCalled();
	});

	it("rejects a mixed array (member + non-member) with BAD_REQUEST and never calls the DB helper", async () => {
		dbMocks.getProjectMembers.mockResolvedValue([memberRow("member-1")]);

		await expect(
			handler({
				input: {
					...BASE_INPUT,
					contributorUserIds: ["member-1", "a-stranger"],
				},
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(updatePublishingTopicContributors).not.toHaveBeenCalled();
	});

	it("null resets and skips the membership/grandfather check entirely", async () => {
		await handler({
			input: { ...BASE_INPUT, contributorUserIds: null },
		});

		expect(getProjectMembers).not.toHaveBeenCalled();
		expect(
			getPublishingTopicEffectiveContributorIds,
		).not.toHaveBeenCalled();
		expect(updatePublishingTopicContributors).toHaveBeenCalledWith({
			id: "topic-1",
			projectId: "project-1",
			contributorUserIds: null,
		});
	});

	it("allows an id that is not a current member but IS already in the topic's effective contributor set (grandfather rule)", async () => {
		dbMocks.getProjectMembers.mockResolvedValue([memberRow("member-1")]);
		dbMocks.getPublishingTopicEffectiveContributorIds.mockResolvedValue([
			"former-member",
		]);

		await handler({
			input: {
				...BASE_INPUT,
				contributorUserIds: ["member-1", "former-member"],
			},
		});

		expect(updatePublishingTopicContributors).toHaveBeenCalledWith({
			id: "topic-1",
			projectId: "project-1",
			contributorUserIds: ["member-1", "former-member"],
		});
	});

	it("rejects an id that is NEITHER a current member NOR in the topic's effective contributor set, with BAD_REQUEST, and never calls the write helper — the grandfather rule's security property", async () => {
		dbMocks.getProjectMembers.mockResolvedValue([memberRow("member-1")]);
		dbMocks.getPublishingTopicEffectiveContributorIds.mockResolvedValue([
			"former-member",
		]);

		await expect(
			handler({
				input: {
					...BASE_INPUT,
					contributorUserIds: ["former-member", "a-stranger"],
				},
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });

		expect(updatePublishingTopicContributors).not.toHaveBeenCalled();
	});

	it("surfaces a missing topic as NOT_FOUND when the effective-contributor read finds no topic, without calling the write helper", async () => {
		dbMocks.getPublishingTopicEffectiveContributorIds.mockResolvedValue(
			null,
		);

		await expect(
			handler({
				input: { ...BASE_INPUT, contributorUserIds: ["member-1"] },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(updatePublishingTopicContributors).not.toHaveBeenCalled();
	});

	it("accepts [] as an explicit 'remove everyone', distinct from a reset", async () => {
		await handler({
			input: { ...BASE_INPUT, contributorUserIds: [] },
		});

		// [] does not skip the membership check the way null does — there is
		// simply nothing in it to fail the check — but it MUST still reach the
		// DB helper as an explicit empty array, not be coerced into null.
		expect(updatePublishingTopicContributors).toHaveBeenCalledWith({
			id: "topic-1",
			projectId: "project-1",
			contributorUserIds: [],
		});
	});

	it("surfaces a missing topic as NOT_FOUND", async () => {
		dbMocks.updatePublishingTopicContributors.mockResolvedValue(null);

		await expect(
			handler({
				input: { ...BASE_INPUT, contributorUserIds: ["member-1"] },
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("returns the topic the DB helper produces", async () => {
		const topic = { id: "topic-1", contributors: ["member-1"] };
		dbMocks.updatePublishingTopicContributors.mockResolvedValue({ topic });

		await expect(
			handler({
				input: { ...BASE_INPUT, contributorUserIds: ["member-1"] },
			}),
		).resolves.toEqual({ topic });
	});
});
