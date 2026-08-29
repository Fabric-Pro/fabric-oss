/**
 * Unit tests for `approvalChatChannels` on `newsletter.settings.update`
 * (Fizzy #2203 Task 9).
 *
 * Fully offline — mirrors the harness in settings-update-require-approval.test.ts:
 * `@repo/database` and `../../../../orpc/procedures` are mocked, and the
 * procedure's `.handler` is invoked directly via the chainable-proxy `_handler`.
 *
 * `approvalChatChannels` is the review-alert routing list (Fizzy #2203),
 * separate from the existing `chatChannels` audience list. Both are
 * re-validated against the project's LIVE linked-channel set (F3) before
 * anything is persisted — a channel unlinked since the client last fetched the
 * settings form is silently dropped rather than persisted or rejected. The
 * two lists share ONE fetch of the linked sets.
 *
 * Coverage:
 *  - a currently-linked channel survives the re-validation.
 *  - a stale (no-longer-linked) channel is silently dropped; the call resolves.
 *  - an empty array is persisted as-is (turns alerts off) and skips the
 *    re-validation fetch entirely (the length guard).
 *  - when BOTH lists carry a stale entry, the linked-set fetch runs exactly
 *    once and each list is filtered independently against it.
 *  - the procedure is declared behind requireProjectPermission(PROJECT_SETTINGS_EDIT).
 *
 * Run with: pnpm --filter @repo/api test settings-update-approval-channels
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockProjectFindUnique,
	mockGetNewsletterSettings,
	mockUpsertNewsletterSettings,
	mockEnrollProjectMembersAsSubscribers,
	mockRecordAuditTx,
	mockSetPublicWidgetState,
	mockTransaction,
	mockGetLinkedTeamsChannels,
	mockGetLinkedSlackChannels,
	mockRequireProjectPermission,
	permissionRegistrations,
} = vi.hoisted(() => ({
	mockProjectFindUnique: vi.fn(),
	mockGetNewsletterSettings: vi.fn(),
	mockUpsertNewsletterSettings: vi.fn(),
	mockEnrollProjectMembersAsSubscribers: vi.fn(),
	mockRecordAuditTx: vi.fn(),
	mockSetPublicWidgetState: vi.fn(),
	// db.$transaction(cb) just runs the callback with a bare tx sentinel — this
	// suite never touches requireApproval's compare-before-write read.
	mockTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb({})),
	mockGetLinkedTeamsChannels: vi.fn().mockResolvedValue([]),
	mockGetLinkedSlackChannels: vi.fn().mockResolvedValue([]),
	...(() => {
		// The procedure module calls `requireProjectPermission(Permissions.X)`
		// ONCE, at import time, which is before any `beforeEach` runs. The
		// `vi.clearAllMocks()` below therefore erases that call from the spy's
		// own history — asserting `toHaveBeenCalledWith` on it reports
		// "Number of calls: 0" no matter what the procedure declares (measured).
		// So the registration is also appended to a plain array, which
		// `clearAllMocks` cannot touch, and the assertion reads that.
		const registrations: unknown[] = [];
		return {
			permissionRegistrations: registrations,
			mockRequireProjectPermission: vi.fn((permission: unknown) => {
				registrations.push(permission);
				return (c: unknown) => c;
			}),
		};
	})(),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findUnique: mockProjectFindUnique },
		$transaction: mockTransaction,
	},
	getNewsletterSettings: mockGetNewsletterSettings,
	upsertNewsletterSettings: mockUpsertNewsletterSettings,
	enrollProjectMembersAsSubscribers: mockEnrollProjectMembersAsSubscribers,
	setPublicWidgetState: mockSetPublicWidgetState,
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
		requireProjectPermission: mockRequireProjectPermission,
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
	user: { id: "admin-1", email: "dev@example.com", name: "Admin" },
	session: { activeOrganizationId: "org-9" },
};

const LINKED = {
	platform: "SLACK" as const,
	teamId: "T-example",
	channelId: "C-a",
};
const STALE = {
	platform: "SLACK" as const,
	teamId: "T-example",
	channelId: "C-b",
};

beforeEach(() => {
	vi.clearAllMocks();
	mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
		cb({}),
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
	mockSetPublicWidgetState.mockResolvedValue({
		changed: false,
		token: "",
		version: 1,
	});
	mockGetLinkedTeamsChannels.mockResolvedValue([]);
	mockGetLinkedSlackChannels.mockResolvedValue([
		{ slackTeamId: "T-example", channelId: "C-a" },
	]);
});

describe("settings.update — approvalChatChannels re-validation (Fizzy #2203 Task 9)", () => {
	it("persists channels that are currently linked", async () => {
		await updateSettings({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				approvalChatChannels: [LINKED],
			},
			context: orgContext,
		});

		expect(mockUpsertNewsletterSettings).toHaveBeenCalledTimes(1);
		const [, payload] = vi.mocked(mockUpsertNewsletterSettings).mock
			.calls[0];
		expect(payload.approvalChatChannels).toEqual([LINKED]);
	});

	it("silently drops a channel that is no longer linked", async () => {
		const result = await updateSettings({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				approvalChatChannels: [LINKED, STALE],
			},
			context: orgContext,
		});

		// The call resolved — a stale entry is dropped, never a 400.
		expect(result).toBeDefined();
		const [, payload] = vi.mocked(mockUpsertNewsletterSettings).mock
			.calls[0];
		expect(payload.approvalChatChannels).toEqual([LINKED]);
	});

	it("persists an empty array, because [] is how an admin turns alerts off", async () => {
		await updateSettings({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				approvalChatChannels: [],
			},
			context: orgContext,
		});

		// The length guard skips the re-validation fetch entirely for an empty list.
		expect(mockGetLinkedSlackChannels).not.toHaveBeenCalled();
		expect(mockGetLinkedTeamsChannels).not.toHaveBeenCalled();
		const [, payload] = vi.mocked(mockUpsertNewsletterSettings).mock
			.calls[0];
		expect(payload.approvalChatChannels).toEqual([]);
	});

	it("re-validates the audience list and the alert list from ONE linked-set fetch", async () => {
		await updateSettings({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				chatChannels: [LINKED, STALE],
				approvalChatChannels: [LINKED, STALE],
			},
			context: orgContext,
		});

		// Both lists carried a stale entry, but the linked-channel sets are fetched
		// exactly once and shared — not once per list.
		expect(mockGetLinkedSlackChannels).toHaveBeenCalledTimes(1);
		expect(mockGetLinkedTeamsChannels).toHaveBeenCalledTimes(1);

		const [, payload] = vi.mocked(mockUpsertNewsletterSettings).mock
			.calls[0];
		expect(payload.chatChannels).toEqual([LINKED]);
		expect(payload.approvalChatChannels).toEqual([LINKED]);
	});

	// A real assertion about `settings-update.ts`, not about this file's mocks.
	// The `Permissions` proxy yields its own key as the string, so what lands
	// here is the permission the procedure actually names. Deleting the
	// `.use(requireProjectPermission(...))` line makes the array empty; naming a
	// different permission makes it hold the wrong string. Both go red.
	it("is declared with requireProjectPermission(PROJECT_SETTINGS_EDIT)", () => {
		expect(permissionRegistrations).toContain("PROJECT_SETTINGS_EDIT");
	});
});
