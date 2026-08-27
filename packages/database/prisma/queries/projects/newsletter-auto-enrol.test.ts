import { beforeEach, describe, expect, it, vi } from "vitest";

const projectFindUnique = vi.fn();
const settingsFindUnique = vi.fn();
const subscriberCreateMany = vi.fn();
const subscriberUpdateMany = vi.fn();
const getProjectMembers = vi.fn();

vi.mock("../../client", () => ({
	db: {
		project: { findUnique: (...a: unknown[]) => projectFindUnique(...a) },
		newsletterSettings: {
			findUnique: (...a: unknown[]) => settingsFindUnique(...a),
		},
		newsletterSubscriber: {
			createMany: (...a: unknown[]) => subscriberCreateMany(...a),
			updateMany: (...a: unknown[]) => subscriberUpdateMany(...a),
		},
	},
}));
vi.mock("./members", () => ({
	getProjectMembers: (...a: unknown[]) => getProjectMembers(...a),
}));

import {
	enrollProjectMemberIfNewsletterEnabled,
	enrollProjectMembersAsSubscribers,
	removeNewsletterSubscriber,
} from "./newsletter";

const member = (email: string, userId = `u-${email}`) => ({
	userId,
	role: "MEMBER",
	user: { id: userId, name: null, email, image: null },
	isOwner: false,
	isCreator: false,
	isGuest: false,
	invitedAt: null,
	acceptedAt: new Date(),
	expiresAt: null,
});

describe("enrollProjectMembersAsSubscribers", () => {
	beforeEach(() => {
		projectFindUnique.mockReset();
		settingsFindUnique.mockReset();
		subscriberCreateMany.mockReset().mockResolvedValue({ count: 2 });
		getProjectMembers.mockReset();
	});

	it("enrols all members create-if-absent with org-context tenant fields", async () => {
		projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: "org-9",
			userId: "owner-1",
		});
		getProjectMembers.mockResolvedValue([
			member("owner@example.com", "owner-1"),
			member("a@example.com"),
		]);

		const res = await enrollProjectMembersAsSubscribers({
			projectId: "p1",
			createdByUserId: "admin-1",
		});

		expect(res).toEqual({ enrolled: 2 });
		const arg = subscriberCreateMany.mock.calls[0][0] as {
			data: Array<{
				email: string;
				organizationId: string | null;
				userId: string | null;
				status: string;
				createdByUserId: string;
				unsubscribeToken: string;
			}>;
			skipDuplicates: boolean;
		};
		expect(arg.skipDuplicates).toBe(true);
		// XOR: org context => organizationId set, userId null (tenant field, not member id)
		expect(
			arg.data.every(
				(r) => r.organizationId === "org-9" && r.userId === null,
			),
		).toBe(true);
		expect(
			arg.data.every(
				(r) => r.status === "ACTIVE" && r.createdByUserId === "admin-1",
			),
		).toBe(true);
		expect(arg.data.map((r) => r.email).sort()).toEqual([
			"a@example.com",
			"owner@example.com",
		]);
		// fresh, distinct tokens
		expect(arg.data[0].unsubscribeToken).not.toBe(
			arg.data[1].unsubscribeToken,
		);
	});

	it("uses personal-context tenant fields (userId=owner, organizationId=null)", async () => {
		projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: null,
			userId: "owner-1",
		});
		getProjectMembers.mockResolvedValue([
			member("owner@example.com", "owner-1"),
		]);
		subscriberCreateMany.mockResolvedValue({ count: 1 });

		await enrollProjectMembersAsSubscribers({
			projectId: "p1",
			createdByUserId: "owner-1",
		});
		const arg = subscriberCreateMany.mock.calls[0][0] as {
			data: Array<{
				userId: string | null;
				organizationId: string | null;
			}>;
		};
		expect(arg.data[0]).toMatchObject({
			userId: "owner-1",
			organizationId: null,
		});
	});

	it("normalizes + dedupes emails before insert", async () => {
		projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: "org-9",
			userId: "o",
		});
		getProjectMembers.mockResolvedValue([
			member(" A@Example.com "),
			member("a@example.com"),
			member("b@example.com"),
		]);
		subscriberCreateMany.mockResolvedValue({ count: 2 });

		await enrollProjectMembersAsSubscribers({
			projectId: "p1",
			createdByUserId: "admin-1",
		});
		const arg = subscriberCreateMany.mock.calls[0][0] as {
			data: Array<{ email: string }>;
		};
		expect(arg.data.map((r) => r.email).sort()).toEqual([
			"a@example.com",
			"b@example.com",
		]);
	});

	it("resolves createdByUserId from settings when omitted (reconcile path)", async () => {
		projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: "org-9",
			userId: "o",
		});
		settingsFindUnique.mockResolvedValue({
			createdByUserId: "settings-admin",
		});
		getProjectMembers.mockResolvedValue([member("a@example.com")]);
		subscriberCreateMany.mockResolvedValue({ count: 1 });

		await enrollProjectMembersAsSubscribers({ projectId: "p1" });
		const arg = subscriberCreateMany.mock.calls[0][0] as {
			data: Array<{ createdByUserId: string }>;
		};
		expect(arg.data[0].createdByUserId).toBe("settings-admin");
	});

	it("no-ops when no attributable actor (org project, null settings actor, none passed)", async () => {
		// Org context => no owner fallback (userId null); settings row has a null
		// createdByUserId and none was passed => no safe audit actor => no-op.
		projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: "org-9",
			userId: null,
		});
		settingsFindUnique.mockResolvedValue({ createdByUserId: null });

		expect(
			await enrollProjectMembersAsSubscribers({ projectId: "p1" }),
		).toEqual({ enrolled: 0 });
		expect(subscriberCreateMany).not.toHaveBeenCalled();
	});

	it("no-ops when project missing or no member emails", async () => {
		projectFindUnique.mockResolvedValue(null);
		expect(
			await enrollProjectMembersAsSubscribers({
				projectId: "x",
				createdByUserId: "a",
			}),
		).toEqual({ enrolled: 0 });

		projectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: null,
			userId: "o",
		});
		getProjectMembers.mockResolvedValue([]);
		expect(
			await enrollProjectMembersAsSubscribers({
				projectId: "p1",
				createdByUserId: "a",
			}),
		).toEqual({ enrolled: 0 });
		expect(subscriberCreateMany).not.toHaveBeenCalled();
	});
});

describe("enrollProjectMemberIfNewsletterEnabled", () => {
	beforeEach(() => {
		projectFindUnique.mockReset().mockResolvedValue({
			id: "p1",
			organizationId: "org-9",
			userId: "owner-1",
		});
		settingsFindUnique.mockReset();
		subscriberCreateMany.mockReset().mockResolvedValue({ count: 1 });
		getProjectMembers
			.mockReset()
			.mockResolvedValue([member("a@example.com")]);
	});

	it("enrols only the joining address, without reading the roster", async () => {
		settingsFindUnique.mockResolvedValue({
			enabled: true,
			createdByUserId: "settings-admin",
		});

		expect(
			await enrollProjectMemberIfNewsletterEnabled({
				projectId: "p1",
				email: " Newcomer@Example.com ",
			}),
		).toEqual({ enrolled: 1 });

		expect(subscriberCreateMany).toHaveBeenCalledTimes(1);
		const arg = subscriberCreateMany.mock.calls[0][0] as {
			data: Array<{
				email: string;
				createdByUserId: string;
				organizationId: string | null;
				userId: string | null;
				status: string;
			}>;
			skipDuplicates: boolean;
		};
		// Exactly one row, normalized. This runs on a request path, so an
		// accept must not cost a roster read plus an N-row insert payload for
		// a project of N members — that is what the roster-wide pass at
		// enable-time and send-time is for.
		expect(getProjectMembers).not.toHaveBeenCalled();
		expect(arg.data).toHaveLength(1);
		expect(arg.data[0].email).toBe("newcomer@example.com");
		// Create-if-absent: an UNSUBSCRIBED tombstone must survive a re-join.
		expect(arg.skipDuplicates).toBe(true);
		// Audit actor is the admin who configured the newsletter, never the
		// member who just joined.
		expect(arg.data[0].createdByUserId).toBe("settings-admin");
		// XOR tenant fields come from the project, not the joining member.
		expect(arg.data[0]).toMatchObject({
			organizationId: "org-9",
			userId: null,
			status: "ACTIVE",
		});
	});

	it("no-ops when the newsletter is disabled", async () => {
		settingsFindUnique.mockResolvedValue({
			enabled: false,
			createdByUserId: "settings-admin",
		});

		expect(
			await enrollProjectMemberIfNewsletterEnabled({
				projectId: "p1",
				email: "a@example.com",
			}),
		).toEqual({ enrolled: 0 });
		expect(subscriberCreateMany).not.toHaveBeenCalled();
		// The disabled path must cost one indexed read and nothing else.
		expect(projectFindUnique).not.toHaveBeenCalled();
		expect(getProjectMembers).not.toHaveBeenCalled();
	});

	it("no-ops when the project has no newsletter settings row", async () => {
		settingsFindUnique.mockResolvedValue(null);

		expect(
			await enrollProjectMemberIfNewsletterEnabled({
				projectId: "p1",
				email: "a@example.com",
			}),
		).toEqual({ enrolled: 0 });
		expect(subscriberCreateMany).not.toHaveBeenCalled();
	});

	it("no-ops on a blank address rather than inserting an empty email", async () => {
		settingsFindUnique.mockResolvedValue({
			enabled: true,
			createdByUserId: "settings-admin",
		});

		expect(
			await enrollProjectMemberIfNewsletterEnabled({
				projectId: "p1",
				email: "   ",
			}),
		).toEqual({ enrolled: 0 });
		expect(subscriberCreateMany).not.toHaveBeenCalled();
	});
});

describe("removeNewsletterSubscriber (soft opt-out)", () => {
	beforeEach(() =>
		subscriberUpdateMany.mockReset().mockResolvedValue({ count: 1 }),
	);

	it("sets UNSUBSCRIBED instead of deleting (durable against reconcile)", async () => {
		await removeNewsletterSubscriber("p1", "sub-1");
		expect(subscriberUpdateMany).toHaveBeenCalledTimes(1);
		const arg = subscriberUpdateMany.mock.calls[0][0] as {
			where: { id: string; projectId: string };
			data: { status: string; unsubscribedAt: Date };
		};
		expect(arg.where).toMatchObject({ id: "sub-1", projectId: "p1" });
		expect(arg.data.status).toBe("UNSUBSCRIBED");
		expect(arg.data.unsubscribedAt).toBeInstanceOf(Date);
	});
});
