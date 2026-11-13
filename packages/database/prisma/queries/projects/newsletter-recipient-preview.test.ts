import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getNewsletterSettings: vi.fn(),
	getProjectMembers: vi.fn(),
	subscriberFindMany: vi.fn(),
	projectFindUnique: vi.fn(),
	memberFindMany: vi.fn(),
}));

vi.mock("../../client", () => ({
	db: {
		newsletterSubscriber: { findMany: mocks.subscriberFindMany },
		project: { findUnique: mocks.projectFindUnique },
		member: { findMany: mocks.memberFindMany },
	},
}));
vi.mock("./members", () => ({ getProjectMembers: mocks.getProjectMembers }));
vi.mock("./newsletter", () => ({
	getNewsletterSettings: mocks.getNewsletterSettings,
	ORG_REMOVED_STATUS: "ORG_REMOVED",
	ORG_SYNC_SOURCE: "ORG_SYNC",
}));

import {
	previewNewsletterSendRecipientCount,
	previewSendRecipients,
} from "./newsletter-recipient-preview";

const row = (
	email: string,
	over: Partial<{
		status: string;
		source: string;
		excludedAt: Date | null;
	}> = {},
) => ({
	email,
	status: "ACTIVE",
	source: "MANUAL",
	excludedAt: null,
	...over,
});

describe("previewSendRecipients", () => {
	it("counts only active, non-excluded rows when nothing is reconciled", () => {
		expect(
			previewSendRecipients({
				rows: [
					row("a@example.com"),
					row("b@example.com", { status: "UNSUBSCRIBED" }),
					row("c@example.com", { excludedAt: new Date() }),
				],
				memberEmails: null,
				organizationEmails: null,
			}),
		).toEqual(["a@example.com"]);
	});

	it("adds members without a row and restores org-removed members, never unsubscribed ones", () => {
		const out = previewSendRecipients({
			rows: [
				row("left@example.com", { status: "UNSUBSCRIBED" }),
				row("back@example.com", {
					status: "ORG_REMOVED",
					source: "ORG_SYNC",
				}),
			],
			memberEmails: [
				"New@Example.com",
				"left@example.com",
				"back@example.com",
			],
			organizationEmails: null,
		});
		expect(out.sort()).toEqual(["back@example.com", "new@example.com"]);
	});

	it("syncs the organization: adds new people, drops org rows for people who left", () => {
		const out = previewSendRecipients({
			rows: [
				row("stays@example.com", { source: "ORG_SYNC" }),
				row("gone@example.com", { source: "ORG_SYNC" }),
				row("manual@example.com"),
			],
			memberEmails: [],
			organizationEmails: ["stays@example.com", "joined@example.com"],
		});
		expect(out.sort()).toEqual([
			"joined@example.com",
			"manual@example.com",
			"stays@example.com",
		]);
	});
});

describe("previewNewsletterSendRecipientCount", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.subscriberFindMany.mockResolvedValue([row("a@example.com")]);
		mocks.getProjectMembers.mockResolvedValue([
			{ user: { email: "member@example.com" } },
		]);
		mocks.projectFindUnique.mockResolvedValue({
			organizationId: "org-1",
			organization: { deletedAt: null },
		});
		mocks.memberFindMany.mockResolvedValue([
			{ user: { email: "colleague@example.com" } },
		]);
	});

	it("adds no members while the newsletter is disabled", async () => {
		mocks.getNewsletterSettings.mockResolvedValue({
			enabled: false,
			sendToOrganization: false,
		});

		await expect(
			previewNewsletterSendRecipientCount("p1"),
		).resolves.toEqual({ recipientCount: 1 });
		expect(mocks.getProjectMembers).not.toHaveBeenCalled();
		expect(mocks.memberFindMany).not.toHaveBeenCalled();
	});

	it("still syncs the organization on a disabled newsletter when that is on", async () => {
		mocks.getNewsletterSettings.mockResolvedValue({
			enabled: false,
			sendToOrganization: true,
		});

		await expect(
			previewNewsletterSendRecipientCount("p1"),
		).resolves.toEqual({ recipientCount: 2 });
		expect(mocks.getProjectMembers).not.toHaveBeenCalled();
	});

	it("includes members, and the organization when it is on, while enabled", async () => {
		mocks.getNewsletterSettings.mockResolvedValue({
			enabled: true,
			sendToOrganization: false,
		});
		await expect(
			previewNewsletterSendRecipientCount("p1"),
		).resolves.toEqual({ recipientCount: 2 });
		expect(mocks.memberFindMany).not.toHaveBeenCalled();

		mocks.getNewsletterSettings.mockResolvedValue({
			enabled: true,
			sendToOrganization: true,
		});
		await expect(
			previewNewsletterSendRecipientCount("p1"),
		).resolves.toEqual({ recipientCount: 3 });
	});
});
