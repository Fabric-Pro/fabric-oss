/**
 * Org-level release notes distribution (Fizzy #1986, FR8-FR17). These rules are
 * about consent, and a mistake here mails a whole organization, so each is
 * pinned on its own: an UNSUBSCRIBED row is a person's decision and survives
 * every sync, departure and purge.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	projectFindUnique: vi.fn(),
	settingsFindUnique: vi.fn(),
	settingsUpdate: vi.fn(),
	memberFindMany: vi.fn(),
	subscriberCreateMany: vi.fn(),
	subscriberUpdateMany: vi.fn(),
	subscriberDeleteMany: vi.fn(),
	subscriberFindMany: vi.fn(),
	subscriberUpsert: vi.fn(),
	executeRaw: vi.fn(),
	transaction: vi.fn(),
}));

vi.mock("../../client", () => {
	const client = {
		project: { findUnique: db.projectFindUnique },
		member: { findMany: db.memberFindMany },
		newsletterSettings: {
			findUnique: db.settingsFindUnique,
			update: db.settingsUpdate,
		},
		newsletterSubscriber: {
			createMany: db.subscriberCreateMany,
			updateMany: db.subscriberUpdateMany,
			deleteMany: db.subscriberDeleteMany,
			findMany: db.subscriberFindMany,
			upsert: db.subscriberUpsert,
		},
		$executeRaw: db.executeRaw,
	};
	return {
		db: {
			...client,
			$transaction: (
				fn: (tx: typeof client) => unknown,
				options?: unknown,
			) => {
				db.transaction(options);
				return fn(client);
			},
		},
	};
});
vi.mock("./members", () => ({ getProjectMembers: vi.fn() }));

import {
	addNewsletterSubscriber,
	enrollProjectMembersAsSubscribers,
	listActiveNewsletterSubscribers,
	listNewsletterSubscribers,
	purgeOrganizationSubscribers,
	recordOrganizationSyncFailure,
	setOrganizationSubscriberExcluded,
	syncOrganizationSubscribers,
	unsubscribeByToken,
} from "./newsletter";

function firstArg(mock: { mock: { calls: unknown[][] } }) {
	const [call] = mock.mock.calls;
	if (!call) {
		throw new Error("expected a call");
	}
	// biome-ignore lint/suspicious/noExplicitAny: reads mock arguments of many shapes
	return call[0] as any;
}

const members = (...emails: string[]) =>
	emails.map((email) => ({ user: { email, name: null } }));

beforeEach(() => {
	for (const mock of Object.values(db)) {
		mock.mockReset();
	}
	db.settingsFindUnique.mockResolvedValue({
		sendToOrganization: true,
		createdByUserId: "user_admin",
	});
	db.projectFindUnique.mockResolvedValue({
		organizationId: "org_example",
		organization: { deletedAt: null },
	});
	db.memberFindMany.mockResolvedValue(
		members("a@example.com", "b@example.com"),
	);
	db.subscriberCreateMany.mockResolvedValue({ count: 2 });
	db.subscriberUpdateMany.mockResolvedValue({ count: 0 });
	db.executeRaw.mockResolvedValue(1);
});

describe("syncOrganizationSubscribers", () => {
	it("does nothing while the toggle is off", async () => {
		db.settingsFindUnique.mockResolvedValue({
			sendToOrganization: false,
			createdByUserId: "user_admin",
		});

		await syncOrganizationSubscribers("proj_1");

		expect(db.memberFindMany).not.toHaveBeenCalled();
		expect(db.subscriberCreateMany).not.toHaveBeenCalled();
		expect(db.subscriberDeleteMany).not.toHaveBeenCalled();
	});

	it("does nothing for a project outside an organization", async () => {
		db.projectFindUnique.mockResolvedValue({
			organizationId: null,
			organization: null,
		});

		await syncOrganizationSubscribers("proj_1");

		expect(db.subscriberCreateMany).not.toHaveBeenCalled();
	});

	it("does nothing for a deleted organization", async () => {
		db.projectFindUnique.mockResolvedValue({
			organizationId: "org_example",
			organization: { deletedAt: new Date() },
		});

		await syncOrganizationSubscribers("proj_1");

		expect(db.subscriberCreateMany).not.toHaveBeenCalled();
	});

	it("adds members as ORG_SYNC rows, only where no row exists", async () => {
		await syncOrganizationSubscribers("proj_1");

		const call = firstArg(db.subscriberCreateMany);
		expect(call.skipDuplicates).toBe(true);
		expect(call.data).toHaveLength(2);
		expect(call.data[0]).toMatchObject({
			projectId: "proj_1",
			email: "a@example.com",
			status: "ACTIVE",
			source: "ORG_SYNC",
			organizationId: "org_example",
			userId: null,
			createdByUserId: "user_admin",
		});
	});

	it("takes the project lock before reading the setting", async () => {
		await syncOrganizationSubscribers("proj_1");

		expect(db.executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
			db.settingsFindUnique.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("runs in one transaction, sized for a large organization", async () => {
		await syncOrganizationSubscribers("proj_1");

		expect(db.transaction).toHaveBeenCalledTimes(1);
		expect(db.transaction.mock.calls[0]?.[0]).toMatchObject({
			timeout: 60_000,
		});
	});

	it("only ever writes rows in ACTIVE or ORG_REMOVED, which is what keeps an unsubscribe in force", async () => {
		await syncOrganizationSubscribers("proj_1");

		const statuses = db.subscriberUpdateMany.mock.calls.map(
			([call]) => call.where.status,
		);
		expect(statuses.sort()).toEqual(["ACTIVE", "ORG_REMOVED"]);
	});

	it("normalizes and removes repeated addresses", async () => {
		db.memberFindMany.mockResolvedValue(
			members(" A@Example.com", "a@example.com"),
		);

		await syncOrganizationSubscribers("proj_1");

		const { data } = firstArg(db.subscriberCreateMany);
		expect(data.map((row: { email: string }) => row.email)).toEqual([
			"a@example.com",
		]);
	});

	it("keeps the row of someone who left, so their unsubscribe link still works", async () => {
		await syncOrganizationSubscribers("proj_1");

		expect(db.subscriberDeleteMany).not.toHaveBeenCalled();
		expect(db.subscriberUpdateMany).toHaveBeenCalledWith({
			where: {
				projectId: "proj_1",
				source: "ORG_SYNC",
				status: "ACTIVE",
				email: { notIn: ["a@example.com", "b@example.com"] },
			},
			data: { status: "ORG_REMOVED", excludedAt: null },
		});
	});

	it("brings back someone who returned, with their original row", async () => {
		await syncOrganizationSubscribers("proj_1");

		expect(db.subscriberUpdateMany).toHaveBeenCalledWith({
			where: {
				projectId: "proj_1",
				status: "ORG_REMOVED",
				email: { in: ["a@example.com", "b@example.com"] },
			},
			data: { status: "ACTIVE" },
		});
	});

	it("treats an empty member read as a failure, leaving the list alone", async () => {
		db.memberFindMany.mockResolvedValue([]);

		await expect(syncOrganizationSubscribers("proj_1")).rejects.toThrow();

		expect(db.subscriberCreateMany).not.toHaveBeenCalled();
		expect(db.subscriberUpdateMany).not.toHaveBeenCalled();
		expect(db.settingsUpdate).not.toHaveBeenCalled();
	});

	it("does not record success when a write fails", async () => {
		db.subscriberUpdateMany.mockRejectedValue(new Error("db down"));

		await expect(syncOrganizationSubscribers("proj_1")).rejects.toThrow(
			"db down",
		);

		expect(db.settingsUpdate).not.toHaveBeenCalled();
	});

	it("records the success and clears an earlier failure", async () => {
		await syncOrganizationSubscribers("proj_1");

		const { where, data } = firstArg(db.settingsUpdate);
		expect(where).toEqual({ projectId: "proj_1" });
		expect(data.orgSyncedAt).toBeInstanceOf(Date);
		expect(data.orgSyncError).toBeNull();
	});
});

describe("listActiveNewsletterSubscribers", () => {
	it("leaves out a subscriber an admin excluded", async () => {
		db.subscriberFindMany.mockResolvedValue([]);

		await listActiveNewsletterSubscribers("proj_1");

		expect(db.subscriberFindMany.mock.calls[0]?.[0]?.where).toEqual({
			projectId: "proj_1",
			status: "ACTIVE",
			excludedAt: null,
		});
	});
});

describe("setOrganizationSubscriberExcluded", () => {
	it("excludes only an org-synced row of this project", async () => {
		db.subscriberUpdateMany.mockResolvedValue({ count: 1 });

		await setOrganizationSubscriberExcluded("proj_1", "sub_1", true);

		const { where, data } = firstArg(db.subscriberUpdateMany);
		expect(where).toEqual({
			id: "sub_1",
			projectId: "proj_1",
			source: "ORG_SYNC",
		});
		expect(data.excludedAt).toBeInstanceOf(Date);
		expect(data).not.toHaveProperty("status");
	});

	it("re-enables without touching the person's own status", async () => {
		db.subscriberUpdateMany.mockResolvedValue({ count: 1 });

		await setOrganizationSubscriberExcluded("proj_1", "sub_1", false);

		expect(db.subscriberUpdateMany.mock.calls[0]?.[0]?.data).toEqual({
			excludedAt: null,
		});
	});
});

describe("purgeOrganizationSubscribers", () => {
	it("takes active org-synced rows off the list and keeps their tokens", async () => {
		await purgeOrganizationSubscribers("proj_1");

		expect(db.subscriberDeleteMany).not.toHaveBeenCalled();
		expect(db.subscriberUpdateMany).toHaveBeenCalledWith({
			where: {
				projectId: "proj_1",
				source: "ORG_SYNC",
				status: "ACTIVE",
			},
			data: { status: "ORG_REMOVED", excludedAt: null },
		});
	});
});

describe("unsubscribeByToken", () => {
	it("works on a row taken off the list, for a link in an email already sent", async () => {
		db.subscriberUpdateMany.mockResolvedValue({ count: 1 });

		await expect(unsubscribeByToken("token_1")).resolves.toBe(true);

		const { where, data } = firstArg(db.subscriberUpdateMany);
		expect(where).toEqual({
			unsubscribeToken: "token_1",
			status: { in: ["ACTIVE", "ORG_REMOVED"] },
		});
		expect(data.status).toBe("UNSUBSCRIBED");
	});
});

describe("listNewsletterSubscribers", () => {
	it("hides rows taken off the list from admins", async () => {
		db.subscriberFindMany.mockResolvedValue([]);

		await listNewsletterSubscribers("proj_1");

		expect(firstArg(db.subscriberFindMany).where).toEqual({
			projectId: "proj_1",
			status: { notIn: ["PENDING_CONFIRMATION", "ORG_REMOVED"] },
		});
	});

	it("breaks ties so a row keeps its place, because one sync gives every row the same time", async () => {
		db.subscriberFindMany.mockResolvedValue([]);

		await listNewsletterSubscribers("proj_1");

		expect(firstArg(db.subscriberFindMany).orderBy).toEqual([
			{ createdAt: "desc" },
			{ email: "asc" },
		]);
	});
});

describe("adding someone by hand", () => {
	it("makes a removed row a manual subscriber, so the next purge leaves it", async () => {
		await addNewsletterSubscriber({
			projectId: "proj_1",
			email: "a@example.com",
			userId: null,
			organizationId: "org_example",
			createdByUserId: "user_admin",
		});

		expect(firstArg(db.subscriberUpsert).update).toMatchObject({
			status: "ACTIVE",
			source: "MANUAL",
			excludedAt: null,
		});
	});
});

describe("enrollProjectMembersAsSubscribers", () => {
	it("restores a project member whose row was taken off the list, and only that", async () => {
		db.projectFindUnique.mockResolvedValue({
			id: "proj_1",
			organizationId: "org_example",
			userId: "user_admin",
		});

		await enrollProjectMembersAsSubscribers({
			projectId: "proj_1",
			createdByUserId: "user_admin",
			emails: ["a@example.com"],
		});

		expect(db.subscriberUpdateMany).toHaveBeenCalledWith({
			where: {
				projectId: "proj_1",
				status: "ORG_REMOVED",
				email: { in: ["a@example.com"] },
			},
			data: { status: "ACTIVE", source: "MANUAL" },
		});
	});
});

describe("recordOrganizationSyncFailure", () => {
	it("keeps a bounded message for the admin", async () => {
		await recordOrganizationSyncFailure("proj_1", "x".repeat(5000));

		const { data } = firstArg(db.settingsUpdate);
		expect(data.orgSyncError.length).toBeLessThanOrEqual(500);
	});
});
