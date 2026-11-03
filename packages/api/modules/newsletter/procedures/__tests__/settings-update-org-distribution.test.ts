/**
 * "Send to entire organization" (Fizzy #1986, FR8, FR14). Turning it off has to
 * remove org-synced rows in the same transaction as the setting, because a
 * setting that saved without its purge would keep mailing those people.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockProjectFindUnique,
	mockGetNewsletterSettings,
	mockUpsertNewsletterSettings,
	mockEnrollProjectMembersAsSubscribers,
	mockSync,
	mockRecordFailure,
	mockPurge,
	mockLock,
	mockRecordAuditTx,
	mockTxFindUnique,
	mockTransaction,
	mockGetLinkedTeamsChannels,
	mockGetLinkedSlackChannels,
} = vi.hoisted(() => ({
	mockProjectFindUnique: vi.fn(),
	mockGetNewsletterSettings: vi.fn(),
	mockUpsertNewsletterSettings: vi.fn(),
	mockEnrollProjectMembersAsSubscribers: vi.fn(),
	mockSync: vi.fn(),
	mockRecordFailure: vi.fn(),
	mockPurge: vi.fn(),
	mockLock: vi.fn(),
	mockRecordAuditTx: vi.fn(),
	mockTxFindUnique: vi.fn(),
	// db.$transaction(cb) runs the callback with a fake tx object exposing
	// newsletterSettings.findUnique — the handler calls this directly (not via
	// a mocked query helper) to read the pre-write requireApproval value.
	mockTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
		return cb({ newsletterSettings: { findUnique: mockTxFindUnique } });
	}),
	mockGetLinkedTeamsChannels: vi.fn().mockResolvedValue([]),
	mockGetLinkedSlackChannels: vi.fn().mockResolvedValue([]),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mockProjectFindUnique },
		$transaction: mockTransaction,
	},
	getNewsletterSettings: mockGetNewsletterSettings,
	upsertNewsletterSettings: mockUpsertNewsletterSettings,
	enrollProjectMembersAsSubscribers: mockEnrollProjectMembersAsSubscribers,
	syncOrganizationSubscribers: mockSync,
	recordOrganizationSyncFailure: mockRecordFailure,
	purgeOrganizationSubscribers: mockPurge,
	lockOrganizationSubscribers: mockLock,
	setPublicWidgetState: vi.fn(),
	regenerateEmbedToken: vi.fn(),
	recordAuditTx: mockRecordAuditTx,
	getLinkedTeamsChannels: mockGetLinkedTeamsChannels,
	getLinkedSlackChannels: mockGetLinkedSlackChannels,
	NEWSLETTER_DETAIL_LEVELS: ["BRIEF", "STANDARD", "DETAILED"],
	DEFAULT_NEWSLETTER_DETAIL_LEVEL: "STANDARD",
	NEWSLETTER_DELIVERY_DESTINATIONS: ["EMAIL", "CHAT", "BOTH"],
	DEFAULT_NEWSLETTER_DELIVERY_DESTINATION: "EMAIL",
	NEWSLETTER_CHAT_PLATFORMS: ["TEAMS", "SLACK"],
}));

vi.mock("../../../../orpc/procedures", () => {
	// biome-ignore lint/suspicious/noExplicitAny: minimal chainable test double
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId ?? null,
		),
	};
});

import { updateSettingsProcedure } from "../settings-update";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const updateSettings = (
	updateSettingsProcedure as unknown as { _handler: Handler }
)._handler;

const orgContext = {
	user: { id: "admin-1", email: "a@example.com", name: "A" },
	session: { activeOrganizationId: "org-9" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
		cb({ newsletterSettings: { findUnique: mockTxFindUnique } }),
	);
	mockProjectFindUnique.mockResolvedValue({
		id: "p1",
		organizationId: "org-9",
		userId: null,
	});
	mockGetNewsletterSettings.mockResolvedValue({ enabled: false });
	mockUpsertNewsletterSettings.mockResolvedValue({ id: "ns-1" });
	mockEnrollProjectMembersAsSubscribers.mockResolvedValue({ enrolled: 0 });
	mockRecordAuditTx.mockResolvedValue(undefined);
	mockTxFindUnique.mockResolvedValue({ sendToOrganization: false });
	mockSync.mockResolvedValue({ added: 0, removed: 0 });
	mockRecordFailure.mockResolvedValue({});
	mockPurge.mockResolvedValue({ count: 0 });
});

const save = (sendToOrganization?: boolean) =>
	updateSettings({
		input: { projectId: "p1", organizationId: "org-9", sendToOrganization },
		context: orgContext,
	});

describe("settings.update — sendToOrganization", () => {
	it("refuses it on a personal project, before anything is saved", async () => {
		mockProjectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: null,
			userId: "user-1",
		});

		await expect(
			updateSettings({
				input: { projectId: "p1", sendToOrganization: true },
				context: orgContext,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mockTransaction).not.toHaveBeenCalled();
	});

	it("saves the value and audits turning it on", async () => {
		await save(true);

		expect(mockUpsertNewsletterSettings.mock.calls[0]?.[1]).toMatchObject({
			sendToOrganization: true,
		});
		expect(mockRecordAuditTx).toHaveBeenCalledTimes(1);
		expect(mockRecordAuditTx.mock.calls[0]?.[1]).toMatchObject({
			action: "newsletter.organization_distribution.changed",
			organizationId: "org-9",
			projectId: "p1",
			metadata: { sendToOrganization: true },
		});
	});

	it("fills the list as soon as it is turned on, after the commit", async () => {
		await save(true);

		expect(mockSync).toHaveBeenCalledWith("p1");
		expect(mockSync.mock.invocationCallOrder[0]).toBeGreaterThan(
			mockTransaction.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mockPurge).not.toHaveBeenCalled();
	});

	it("keeps the save when the first sync fails, and records why", async () => {
		mockSync.mockRejectedValue(new Error("db down"));

		await expect(save(true)).resolves.toBeDefined();

		expect(mockRecordFailure).toHaveBeenCalledWith("p1", "db down");
	});

	it("purges inside the transaction when it is turned off", async () => {
		mockTxFindUnique.mockResolvedValue({ sendToOrganization: true });

		await save(false);

		expect(mockPurge).toHaveBeenCalledWith(
			"p1",
			expect.objectContaining({
				newsletterSettings: expect.anything(),
			}),
		);
		expect(mockRecordAuditTx.mock.calls[0]?.[1]).toMatchObject({
			metadata: { sendToOrganization: false },
		});
		expect(mockSync).not.toHaveBeenCalled();
	});

	it("takes the sync lock before reading the current value", async () => {
		await save(false);

		expect(mockLock).toHaveBeenCalledWith(expect.anything(), "p1");
		expect(mockLock.mock.invocationCallOrder[0]).toBeLessThan(
			mockTxFindUnique.mock.invocationCallOrder[0] ?? 0,
		);
	});

	it("does not save the setting when the purge fails", async () => {
		mockTxFindUnique.mockResolvedValue({ sendToOrganization: true });
		mockPurge.mockRejectedValue(new Error("db down"));

		await expect(save(false)).rejects.toThrow("db down");
		expect(mockUpsertNewsletterSettings).not.toHaveBeenCalled();
	});

	it("does nothing to subscribers when the value did not change", async () => {
		mockTxFindUnique.mockResolvedValue({ sendToOrganization: true });

		await save(true);

		expect(mockRecordAuditTx).not.toHaveBeenCalled();
		expect(mockPurge).not.toHaveBeenCalled();
		expect(mockSync).not.toHaveBeenCalled();
	});

	it("leaves everything alone when the field is omitted", async () => {
		await save(undefined);

		expect(mockTxFindUnique).not.toHaveBeenCalled();
		expect(mockPurge).not.toHaveBeenCalled();
		expect(mockSync).not.toHaveBeenCalled();
	});
});
