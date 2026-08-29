/**
 * Task 2 (1869 "Newsletter Approval Gate"): unit tests for the
 * `requireApproval` audit emission in `settings.update`. Fully offline —
 * mirrors the harness in settings-embed.test.ts, but the tx mock here is a
 * real object (not a bare string sentinel) so the handler's direct
 * `tx.newsletterSettings.findUnique(...)` compare-before-write read works.
 *
 * Coverage:
 *  - A real requireApproval transition (false -> true, or true -> false)
 *    writes exactly one `newsletter.approval.required_changed` audit row,
 *    in-tx, with the new value in metadata.
 *  - A same-value "no-op" write (input matches the current row) emits none.
 *  - `requireApproval` omitted from the input never touches the audit or the
 *    pre-write read.
 *  - The pre-write read + audit happen inside the SAME tx passed to
 *    `upsertNewsletterSettings` (atomicity: compare-and-audit is atomic with
 *    the save).
 *
 * Run with: pnpm --filter @repo/api test settings-update-require-approval
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockProjectFindUnique,
	mockGetNewsletterSettings,
	mockUpsertNewsletterSettings,
	mockEnrollProjectMembersAsSubscribers,
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
	mockTxFindUnique.mockResolvedValue({ requireApproval: false });
});

describe("settings.update — requireApproval audit (1869 Task 2)", () => {
	it("false -> true: writes exactly one newsletter.approval.required_changed row in-tx", async () => {
		mockTxFindUnique.mockResolvedValue({ requireApproval: false });
		await updateSettings({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				requireApproval: true,
			},
			context: orgContext,
		});

		expect(mockTxFindUnique).toHaveBeenCalledWith({
			where: { projectId: "p1" },
			select: { requireApproval: true },
		});
		expect(mockRecordAuditTx).toHaveBeenCalledTimes(1);
		expect(mockRecordAuditTx).toHaveBeenCalledWith(
			expect.objectContaining({ newsletterSettings: expect.anything() }),
			expect.objectContaining({
				action: "newsletter.approval.required_changed",
				actor: expect.objectContaining({
					type: "user",
					userId: "admin-1",
				}),
				organizationId: "org-9",
				projectId: "p1",
				resource: { type: "newsletter_settings", id: "p1" },
				metadata: { requireApproval: true },
			}),
		);
		// requireApproval is forwarded to the upsert.
		expect(mockUpsertNewsletterSettings).toHaveBeenCalledWith(
			"p1",
			expect.objectContaining({ requireApproval: true }),
			expect.anything(),
		);
	});

	it("true -> false: writes exactly one audit row with metadata.requireApproval=false", async () => {
		mockTxFindUnique.mockResolvedValue({ requireApproval: true });
		await updateSettings({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				requireApproval: false,
			},
			context: orgContext,
		});

		expect(mockRecordAuditTx).toHaveBeenCalledTimes(1);
		expect(mockRecordAuditTx).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				action: "newsletter.approval.required_changed",
				metadata: { requireApproval: false },
			}),
		);
	});

	it("no-op same-value write (true -> true): emits NO audit row", async () => {
		mockTxFindUnique.mockResolvedValue({ requireApproval: true });
		await updateSettings({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				requireApproval: true,
			},
			context: orgContext,
		});

		expect(mockTxFindUnique).toHaveBeenCalledTimes(1);
		expect(mockRecordAuditTx).not.toHaveBeenCalled();
	});

	it("no-op same-value write (false -> false, no existing row): emits NO audit row", async () => {
		// No settings row yet: findUnique resolves null -> before defaults to false.
		mockTxFindUnique.mockResolvedValue(null);
		await updateSettings({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				requireApproval: false,
			},
			context: orgContext,
		});

		expect(mockRecordAuditTx).not.toHaveBeenCalled();
	});

	it("requireApproval omitted: never reads the current value or audits", async () => {
		await updateSettings({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				cadence: "MONTHLY",
			},
			context: orgContext,
		});

		expect(mockTxFindUnique).not.toHaveBeenCalled();
		expect(mockRecordAuditTx).not.toHaveBeenCalled();
		expect(mockUpsertNewsletterSettings).toHaveBeenCalledWith(
			"p1",
			expect.objectContaining({ requireApproval: undefined }),
			expect.anything(),
		);
	});

	it("atomicity: a recordAuditTx failure aborts the tx (propagates, upsert never observed as committed)", async () => {
		mockTxFindUnique.mockResolvedValue({ requireApproval: false });
		mockRecordAuditTx.mockRejectedValue(new Error("audit insert failed"));
		await expect(
			updateSettings({
				input: {
					projectId: "p1",
					organizationId: "org-9",
					requireApproval: true,
				},
				context: orgContext,
			}),
		).rejects.toThrow("audit insert failed");
		// The throw escapes the $transaction callback before upsertNewsletterSettings
		// runs — the compare-and-audit happens BEFORE the write, so the whole tx
		// (including the settings write that would have followed) rolls back.
		expect(mockUpsertNewsletterSettings).not.toHaveBeenCalled();
	});
});
