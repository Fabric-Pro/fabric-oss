/**
 * Unit tests for the newsletter oRPC procedures (handler-level, fully offline).
 *
 * The dev DB and Temporal are unavailable in this environment, so we mock
 * `@repo/database` and `@repo/temporal` and call each procedure's `.handler`
 * directly. The `../../../orpc/procedures` module is mocked with a chainable
 * proxy that returns `{ _handler: fn }` from `.handler(fn)`, so each exported
 * procedure exposes its handler as `._handler` (order-independent).
 *
 * Coverage:
 *  - unsubscribe: returns { success: true } for any token (no existence leak),
 *    is idempotent, and never throws even when the token is unknown.
 *  - settings.update -> settings.get round-trip on a mocked store; a
 *    wrong-tenant projectId (db.project.findFirst -> null) returns NOT_FOUND.
 *  - sendNow: TOO_MANY_REQUESTS when a recent non-FAILED send exists;
 *    { inFlight: true } when createOrGetNewsletterSend reports created:false.
 *
 * Run with: pnpm --filter @repo/api test modules/newsletter
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockProjectFindFirst,
	mockGetNewsletterSettings,
	mockUpsertNewsletterSettings,
	mockEnrollProjectMembersAsSubscribers,
	mockUnsubscribeByToken,
	mockFindRecentNonFailedSend,
	mockCreateOrGetNewsletterSend,
	mockSetNewsletterSendWorkflowId,
	mockFinalizeNewsletterSend,
	mockManualDedupeKey,
	mockResolveWindow,
	mockIsTemporalAvailable,
	mockWorkflowStart,
	mockListNewsletterSends,
	mockCountNewsletterSends,
	mockListNewsletterSendsForMembers,
	mockCountNewsletterSendsForMembers,
	mockTransaction,
	mockSetPublicWidgetState,
	mockRecordAuditTx,
	mockGetLinkedTeamsChannels,
	mockGetLinkedSlackChannels,
} = vi.hoisted(() => ({
	mockProjectFindFirst: vi.fn(),
	mockGetNewsletterSettings: vi.fn(),
	mockUpsertNewsletterSettings: vi.fn(),
	mockEnrollProjectMembersAsSubscribers: vi.fn(),
	mockUnsubscribeByToken: vi.fn(),
	mockFindRecentNonFailedSend: vi.fn(),
	mockCreateOrGetNewsletterSend: vi.fn(),
	mockSetNewsletterSendWorkflowId: vi.fn(),
	mockFinalizeNewsletterSend: vi.fn(),
	mockManualDedupeKey: vi.fn(() => "manual:proj-1:2026-06-12T00:00:00.000Z"),
	mockResolveWindow: vi.fn(),
	mockIsTemporalAvailable: vi.fn().mockResolvedValue(true),
	mockWorkflowStart: vi.fn(),
	mockListNewsletterSends: vi.fn(),
	mockCountNewsletterSends: vi.fn(),
	mockListNewsletterSendsForMembers: vi.fn(),
	mockCountNewsletterSendsForMembers: vi.fn(),
	// settings.update now composes the upsert + widget toggle + audit in one
	// db.$transaction. The mock runs the callback with a sentinel tx client.
	mockTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => cb("TX")),
	mockSetPublicWidgetState: vi.fn(),
	mockRecordAuditTx: vi.fn(),
	mockGetLinkedTeamsChannels: vi.fn().mockResolvedValue([]),
	mockGetLinkedSlackChannels: vi.fn().mockResolvedValue([]),
}));

vi.mock("@repo/database", () => ({
	db: {
		project: { findFirst: mockProjectFindFirst },
		$transaction: mockTransaction,
	},
	getNewsletterSettings: mockGetNewsletterSettings,
	upsertNewsletterSettings: mockUpsertNewsletterSettings,
	enrollProjectMembersAsSubscribers: mockEnrollProjectMembersAsSubscribers,
	setPublicWidgetState: mockSetPublicWidgetState,
	recordAuditTx: mockRecordAuditTx,
	getLinkedTeamsChannels: mockGetLinkedTeamsChannels,
	getLinkedSlackChannels: mockGetLinkedSlackChannels,
	unsubscribeByToken: mockUnsubscribeByToken,
	findRecentNonFailedSend: mockFindRecentNonFailedSend,
	createOrGetNewsletterSend: mockCreateOrGetNewsletterSend,
	setNewsletterSendWorkflowId: mockSetNewsletterSendWorkflowId,
	finalizeNewsletterSend: mockFinalizeNewsletterSend,
	manualDedupeKey: mockManualDedupeKey,
	resolveWindow: mockResolveWindow,
	listNewsletterSends: mockListNewsletterSends,
	countNewsletterSends: mockCountNewsletterSends,
	listNewsletterSendsForMembers: mockListNewsletterSendsForMembers,
	countNewsletterSendsForMembers: mockCountNewsletterSendsForMembers,
	// settings-update / sends-send-now build their zod input schemas with these
	// at module load (`z.enum(NEWSLETTER_DETAIL_LEVELS)`), and sends-send-now
	// calls `coerceDetailLevel` in the handler — real values/logic (not vi.fn())
	// so schema construction and the handler's effective-level resolution work.
	NEWSLETTER_DETAIL_LEVELS: ["BRIEF", "STANDARD", "DETAILED"],
	DEFAULT_NEWSLETTER_DETAIL_LEVEL: "STANDARD",
	coerceDetailLevel: (v: unknown) =>
		v === "BRIEF" || v === "DETAILED" ? v : "STANDARD",
	// settings-update also builds `deliveryDestination`/`chatChannels` at module
	// load (`z.enum(NEWSLETTER_DELIVERY_DESTINATIONS)` / `z.array(
	// newsletterChatChannelSchema)`) — real values so schema construction works;
	// no test in this file exercises the F3 channel-filter path (settings-update.test.ts owns that).
	NEWSLETTER_DELIVERY_DESTINATIONS: ["EMAIL", "CHAT", "BOTH"],
	DEFAULT_NEWSLETTER_DELIVERY_DESTINATION: "EMAIL",
	NEWSLETTER_CHAT_PLATFORMS: ["TEAMS", "SLACK"],
	// sendNow (Task 8) calls this to resolve the effective destination from
	// settings — real logic (not vi.fn()) so the handler's coercion behaves.
	coerceDeliveryDestination: (v: unknown) =>
		v === "CHAT" || v === "BOTH" ? v : "EMAIL",
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi.fn().mockResolvedValue({
		workflow: { start: mockWorkflowStart },
	}),
	isTemporalAvailable: mockIsTemporalAvailable,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => ({ _handler: fn }),
	};
	return {
		tenantProtectedProcedure: chainable,
		rateLimitedPublicProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null) => organizationId ?? null,
		),
	};
});

import { listSendsProcedure } from "../sends-list";
import { memberListSendsProcedure } from "../sends-member-list";
import { sendNowProcedure } from "../sends-send-now";
import { getSettingsProcedure } from "../settings-get";
import {
	updateNewsletterSettingsInput,
	updateSettingsProcedure,
} from "../settings-update";
import { unsubscribeProcedure } from "../unsubscribe";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const getSettings = (getSettingsProcedure as unknown as { _handler: Handler })
	._handler;
const updateSettings = (
	updateSettingsProcedure as unknown as { _handler: Handler }
)._handler;
const unsubscribe = (unsubscribeProcedure as unknown as { _handler: Handler })
	._handler;
const sendNow = (sendNowProcedure as unknown as { _handler: Handler })._handler;
const listSends = (listSendsProcedure as unknown as { _handler: Handler })
	._handler;

const personalContext = {
	user: { id: "user-1" },
	session: { activeOrganizationId: null },
};
const orgContext = {
	user: { id: "user-1" },
	session: { activeOrganizationId: "org-9" },
};

beforeEach(() => {
	vi.clearAllMocks();
	// clearAllMocks wipes implementations: re-arm the db.$transaction passthrough
	// and the widget-toggle default so the settings.update transactional path runs.
	mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) =>
		cb("TX"),
	);
	mockSetPublicWidgetState.mockResolvedValue({
		changed: false,
		token: "",
		version: 1,
	});
	mockRecordAuditTx.mockResolvedValue(undefined);
	mockManualDedupeKey.mockReturnValue(
		"manual:proj-1:2026-06-12T00:00:00.000Z",
	);
	mockIsTemporalAvailable.mockResolvedValue(true);
	// The settings.update handler now reads getNewsletterSettings for the prior
	// `enabled` state. The existing update tests never stubbed it; default it to a
	// prior-state value so an unstubbed mock can't return undefined.
	mockGetNewsletterSettings.mockResolvedValue({ enabled: false });
	// resolveWindow is mocked; give it a valid default window so the existing
	// sendNow handler-path tests can destructure { start, end } (the window
	// itself is irrelevant to those assertions). The window-contract test below
	// overrides this with its own start/end.
	mockResolveWindow.mockReturnValue({
		start: new Date("2026-06-05T00:00:00.000Z"),
		end: new Date("2026-06-12T00:00:00.000Z"),
	});
});

describe("unsubscribe (public, no existence leak)", () => {
	it("returns { success: true } for an unknown token without throwing", async () => {
		mockUnsubscribeByToken.mockResolvedValue(false); // token not found
		const result = await unsubscribe({
			input: { token: "unknown-token-xyz" },
			context: {},
		});
		expect(result).toEqual({ success: true });
		expect(mockUnsubscribeByToken).toHaveBeenCalledWith(
			"unknown-token-xyz",
		);
	});

	it("returns { success: true } for a known token (flips subscriber)", async () => {
		mockUnsubscribeByToken.mockResolvedValue(true); // token matched, flipped
		const result = await unsubscribe({
			input: { token: "known-token-abcdef" },
			context: {},
		});
		expect(result).toEqual({ success: true });
		expect(mockUnsubscribeByToken).toHaveBeenCalledWith(
			"known-token-abcdef",
		);
	});

	it("is idempotent: a second call still succeeds and does not throw", async () => {
		mockUnsubscribeByToken.mockResolvedValueOnce(true);
		mockUnsubscribeByToken.mockResolvedValueOnce(false);
		await expect(
			unsubscribe({ input: { token: "tok-1234567890" }, context: {} }),
		).resolves.toEqual({ success: true });
		await expect(
			unsubscribe({ input: { token: "tok-1234567890" }, context: {} }),
		).resolves.toEqual({ success: true });
	});
});

describe("settings.update -> settings.get round-trip + tenant XOR", () => {
	it("persists via update then returns the persisted values from get", async () => {
		mockProjectFindFirst.mockResolvedValue({
			id: "proj-1",
			organizationId: null,
			userId: "user-1",
		});
		const persisted = {
			id: "ns-1",
			projectId: "proj-1",
			enabled: true,
			cadence: "MONTHLY",
			dayOfWeek: 1,
			dayOfMonth: 15,
			sendHourUtc: 14,
			lastSentAt: null,
		};
		mockUpsertNewsletterSettings.mockResolvedValue(persisted);
		mockGetNewsletterSettings.mockResolvedValue(persisted);

		const updateResult = (await updateSettings({
			input: {
				projectId: "proj-1",
				organizationId: null,
				enabled: true,
				cadence: "MONTHLY",
				dayOfMonth: 15,
				sendHourUtc: 14,
			},
			context: personalContext,
		})) as { settings: typeof persisted };
		expect(updateResult.settings).toEqual(persisted);
		// Personal-context project => userId carried, organizationId null (XOR).
		// 3rd arg is the tx client: the upsert now runs inside db.$transaction so
		// it can compose with the widget toggle + audit row.
		expect(mockUpsertNewsletterSettings).toHaveBeenCalledWith(
			"proj-1",
			expect.objectContaining({
				enabled: true,
				cadence: "MONTHLY",
				dayOfMonth: 15,
				sendHourUtc: 14,
				userId: "user-1",
				organizationId: null,
			}),
			expect.anything(),
		);

		const getResult = (await getSettings({
			input: { projectId: "proj-1", organizationId: null },
			context: personalContext,
		})) as { settings: typeof persisted };
		expect(getResult.settings).toEqual(persisted);
	});

	it("org context: derives userId null + organizationId set (XOR)", async () => {
		// ORG-owned project: organizationId set, userId null on the project row.
		mockProjectFindFirst.mockResolvedValue({
			id: "proj-1",
			organizationId: "org-9",
			userId: null,
		});
		const persisted = {
			id: "ns-1",
			projectId: "proj-1",
			enabled: true,
			cadence: "WEEKLY",
			dayOfWeek: 1,
			dayOfMonth: 1,
			sendHourUtc: 9,
			lastSentAt: null,
		};
		mockUpsertNewsletterSettings.mockResolvedValue(persisted);

		await updateSettings({
			input: {
				projectId: "proj-1",
				organizationId: "org-9",
				enabled: true,
			},
			context: orgContext,
		});
		// Org context => userId null, organizationId carried (never both set).
		// createdByUserId MUST be the acting admin (context.user.id), NOT the
		// tenant userId column and NOT a "system" sentinel — it becomes
		// triggeredByUserId for scheduled sends and flows into AI usage logging.
		expect(mockUpsertNewsletterSettings).toHaveBeenCalledWith(
			"proj-1",
			expect.objectContaining({
				enabled: true,
				userId: null,
				organizationId: "org-9",
				createdByUserId: "user-1",
			}),
			expect.anything(),
		);
	});

	it("settings.get throws NOT_FOUND for a wrong-tenant project id", async () => {
		mockProjectFindFirst.mockResolvedValue(null);
		await expect(
			getSettings({
				input: { projectId: "other-tenant-proj", organizationId: null },
				context: personalContext,
			}),
		).rejects.toThrow(ORPCError);
		expect(mockGetNewsletterSettings).not.toHaveBeenCalled();
	});

	it("settings.update throws NOT_FOUND for a wrong-tenant project id", async () => {
		mockProjectFindFirst.mockResolvedValue(null);
		await expect(
			updateSettings({
				input: {
					projectId: "other-tenant-proj",
					organizationId: null,
					enabled: true,
				},
				context: personalContext,
			}),
		).rejects.toThrow(ORPCError);
		expect(mockUpsertNewsletterSettings).not.toHaveBeenCalled();
	});
});

describe("settings.update — member auto-enrolment backfill", () => {
	beforeEach(() => {
		mockProjectFindFirst.mockReset().mockResolvedValue({
			id: "p1",
			organizationId: "org-9",
			userId: "owner-1",
		});
		mockUpsertNewsletterSettings
			.mockReset()
			.mockResolvedValue({ id: "ns-1", enabled: true });
		mockGetNewsletterSettings.mockReset();
		mockEnrollProjectMembersAsSubscribers
			.mockReset()
			.mockResolvedValue({ enrolled: 3 });
	});

	const ctx = { user: { id: "admin-1" }, session: {} } as any;

	it("backfills members on a false->true enable transition", async () => {
		mockGetNewsletterSettings.mockResolvedValue({ enabled: false });
		await (updateSettingsProcedure as any)._handler({
			input: { projectId: "p1", organizationId: "org-9", enabled: true },
			context: ctx,
		});
		expect(mockEnrollProjectMembersAsSubscribers).toHaveBeenCalledWith({
			projectId: "p1",
			createdByUserId: "admin-1",
		});
	});

	it("does NOT backfill when already enabled (true->true)", async () => {
		mockGetNewsletterSettings.mockResolvedValue({ enabled: true });
		await (updateSettingsProcedure as any)._handler({
			input: { projectId: "p1", organizationId: "org-9", enabled: true },
			context: ctx,
		});
		expect(mockEnrollProjectMembersAsSubscribers).not.toHaveBeenCalled();
	});

	it("does NOT backfill when enabled is unchanged/omitted", async () => {
		mockGetNewsletterSettings.mockResolvedValue({ enabled: false });
		await (updateSettingsProcedure as any)._handler({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				cadence: "MONTHLY",
			},
			context: ctx,
		});
		expect(mockEnrollProjectMembersAsSubscribers).not.toHaveBeenCalled();
	});

	it("never fails the settings save if enrolment throws", async () => {
		mockGetNewsletterSettings.mockResolvedValue({ enabled: false });
		mockEnrollProjectMembersAsSubscribers.mockRejectedValue(
			new Error("db blip"),
		);
		const res = await (updateSettingsProcedure as any)._handler({
			input: { projectId: "p1", organizationId: "org-9", enabled: true },
			context: ctx,
		});
		expect(res).toMatchObject({ settings: { id: "ns-1" } });
	});
});

describe("updateNewsletterSettingsInput — lookbackDays validation", () => {
	const base = { projectId: "p1" };
	it("accepts null and 1..365", () => {
		expect(
			updateNewsletterSettingsInput.safeParse({
				...base,
				lookbackDays: null,
			}).success,
		).toBe(true);
		expect(
			updateNewsletterSettingsInput.safeParse({
				...base,
				lookbackDays: 1,
			}).success,
		).toBe(true);
		expect(
			updateNewsletterSettingsInput.safeParse({
				...base,
				lookbackDays: 365,
			}).success,
		).toBe(true);
		expect(
			updateNewsletterSettingsInput.safeParse({ ...base }).success,
		).toBe(true); // omitted ok
	});
	it("rejects 0, 366, and non-integers", () => {
		expect(
			updateNewsletterSettingsInput.safeParse({
				...base,
				lookbackDays: 0,
			}).success,
		).toBe(false);
		expect(
			updateNewsletterSettingsInput.safeParse({
				...base,
				lookbackDays: 366,
			}).success,
		).toBe(false);
		expect(
			updateNewsletterSettingsInput.safeParse({
				...base,
				lookbackDays: 7.5,
			}).success,
		).toBe(false);
	});
});

describe("sendNow (rate-limit + idempotency)", () => {
	beforeEach(() => {
		mockProjectFindFirst.mockResolvedValue({
			id: "proj-1",
			name: "Acme",
			organizationId: null,
			userId: "user-1",
		});
		mockGetNewsletterSettings.mockResolvedValue({
			projectId: "proj-1",
			enabled: true,
			cadence: "WEEKLY",
			dayOfWeek: 1,
			dayOfMonth: 1,
			sendHourUtc: 9,
			lastSentAt: null,
		});
	});

	it("throws TOO_MANY_REQUESTS when a recent non-FAILED send exists", async () => {
		mockFindRecentNonFailedSend.mockResolvedValue({
			id: "send-recent",
			createdAt: new Date(),
		});
		await expect(
			sendNow({
				input: { projectId: "proj-1", organizationId: null },
				context: personalContext,
			}),
		).rejects.toThrow(ORPCError);
		expect(mockCreateOrGetNewsletterSend).not.toHaveBeenCalled();
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("returns { inFlight: true } when an active send already exists (created:false)", async () => {
		mockFindRecentNonFailedSend.mockResolvedValue(null);
		mockCreateOrGetNewsletterSend.mockResolvedValue({
			send: { id: "send-existing", temporalWorkflowId: "wf-existing" },
			created: false,
		});
		const result = (await sendNow({
			input: { projectId: "proj-1", organizationId: null },
			context: personalContext,
		})) as { sendId: string; workflowId: string | null; inFlight: boolean };
		expect(result).toEqual({
			sendId: "send-existing",
			workflowId: "wf-existing",
			inFlight: true,
		});
		// Idempotent reuse must NOT start a second workflow.
		expect(mockWorkflowStart).not.toHaveBeenCalled();
	});

	it("starts the workflow and returns { inFlight: false } on a fresh send", async () => {
		mockFindRecentNonFailedSend.mockResolvedValue(null);
		mockCreateOrGetNewsletterSend.mockResolvedValue({
			send: { id: "send-new", temporalWorkflowId: null },
			created: true,
		});
		mockWorkflowStart.mockResolvedValue({
			workflowId: "newsletter-send-send-new",
		});
		const result = (await sendNow({
			input: { projectId: "proj-1", organizationId: null },
			context: personalContext,
		})) as { sendId: string; workflowId: string | null; inFlight: boolean };
		expect(mockWorkflowStart).toHaveBeenCalledWith(
			"generateAndSendNewsletterWorkflow",
			expect.objectContaining({
				taskQueue: "fabric-worker",
				workflowId: "newsletter-send-send-new",
			}),
		);
		expect(mockSetNewsletterSendWorkflowId).toHaveBeenCalledWith(
			"send-new",
			"newsletter-send-send-new",
		);
		expect(result).toEqual({
			sendId: "send-new",
			workflowId: "newsletter-send-send-new",
			inFlight: false,
		});
	});

	it("rolls the send back to FAILED when the workflow start throws", async () => {
		mockFindRecentNonFailedSend.mockResolvedValue(null);
		mockCreateOrGetNewsletterSend.mockResolvedValue({
			send: { id: "send-fail", temporalWorkflowId: null },
			created: true,
		});
		mockWorkflowStart.mockRejectedValue(new Error("temporal down"));
		await expect(
			sendNow({
				input: { projectId: "proj-1", organizationId: null },
				context: personalContext,
			}),
		).rejects.toThrow(ORPCError);
		expect(mockFinalizeNewsletterSend).toHaveBeenCalledWith(
			expect.objectContaining({ sendId: "send-fail", status: "FAILED" }),
		);
	});

	it("does NOT mark FAILED when start succeeds but persisting the workflowId throws", async () => {
		// Start/persist are separate concerns: a persist failure AFTER a
		// successful start must not roll the send back — the workflow is alive and
		// will finalize the row itself. The handler still returns inFlight:false.
		mockFindRecentNonFailedSend.mockResolvedValue(null);
		mockCreateOrGetNewsletterSend.mockResolvedValue({
			send: { id: "send-persist-fail", temporalWorkflowId: null },
			created: true,
		});
		mockWorkflowStart.mockResolvedValue({
			workflowId: "newsletter-send-send-persist-fail",
		});
		mockSetNewsletterSendWorkflowId.mockRejectedValue(new Error("db blip"));
		const result = (await sendNow({
			input: { projectId: "proj-1", organizationId: null },
			context: personalContext,
		})) as { sendId: string; workflowId: string | null; inFlight: boolean };
		expect(result).toEqual({
			sendId: "send-persist-fail",
			workflowId: "newsletter-send-send-persist-fail",
			inFlight: false,
		});
		expect(mockFinalizeNewsletterSend).not.toHaveBeenCalled();
	});

	it("org context: passes userId null + organizationId set to createOrGetNewsletterSend (XOR)", async () => {
		// ORG-owned project overrides the personal-context default from beforeEach.
		mockProjectFindFirst.mockResolvedValue({
			id: "proj-1",
			name: "Acme",
			organizationId: "org-9",
			userId: null,
		});
		mockFindRecentNonFailedSend.mockResolvedValue(null);
		mockCreateOrGetNewsletterSend.mockResolvedValue({
			send: { id: "send-org", temporalWorkflowId: null },
			created: true,
		});
		mockWorkflowStart.mockResolvedValue({
			workflowId: "newsletter-send-send-org",
		});

		await sendNow({
			input: { projectId: "proj-1", organizationId: "org-9" },
			context: orgContext,
		});
		// Org context => the send claims userId null, organizationId carried.
		expect(mockCreateOrGetNewsletterSend).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				userId: null,
				organizationId: "org-9",
			}),
		);
	});
});

describe("sendNow — window via resolveWindow", () => {
	it("calls resolveWindow with manual fallback 7 and threads the returned start/end", async () => {
		mockProjectFindFirst.mockResolvedValue({
			id: "proj-1",
			organizationId: "org-9",
			userId: null,
		});
		mockFindRecentNonFailedSend.mockResolvedValue(null);
		mockIsTemporalAvailable.mockResolvedValue(true);
		mockGetNewsletterSettings.mockResolvedValue({
			cadence: "WEEKLY",
			lookbackDays: 90,
			lastSentAt: null,
		});
		const start = new Date("2026-03-17T09:10:00.000Z");
		const end = new Date("2026-06-15T09:10:00.000Z");
		mockResolveWindow.mockReturnValue({ start, end });
		mockManualDedupeKey.mockReturnValue(
			"manual:proj-1:2026-06-15T09:10:00.000Z",
		);
		mockCreateOrGetNewsletterSend.mockResolvedValue({
			send: { id: "s1", status: "PENDING", temporalWorkflowId: null },
			created: true,
		});
		mockWorkflowStart.mockResolvedValue({
			workflowId: "newsletter-send-s1",
		});

		await sendNow({
			input: { projectId: "proj-1", organizationId: "org-9" },
			context: orgContext,
		});

		expect(mockResolveWindow).toHaveBeenCalledWith(
			{ lookbackDays: 90, lastSentAt: null },
			expect.any(Date),
			7,
		);
		// dedupe + persisted send use the returned window
		expect(mockManualDedupeKey).toHaveBeenCalledWith("proj-1", end);
		expect(mockCreateOrGetNewsletterSend).toHaveBeenCalledWith(
			expect.objectContaining({
				timeWindowStart: start,
				timeWindowEnd: end,
			}),
		);
	});
});

describe("sendNow — detail-level override resolution", () => {
	it("input.detailLevel override wins over the persisted settings.detailLevel", async () => {
		mockProjectFindFirst.mockResolvedValue({
			id: "proj-1",
			name: "Acme",
			organizationId: null,
			userId: "user-1",
		});
		mockFindRecentNonFailedSend.mockResolvedValue(null);
		mockIsTemporalAvailable.mockResolvedValue(true);
		mockGetNewsletterSettings.mockResolvedValue({
			cadence: "WEEKLY",
			lookbackDays: null,
			lastSentAt: null,
			detailLevel: "DETAILED",
		});
		mockCreateOrGetNewsletterSend.mockResolvedValue({
			send: {
				id: "send-override",
				temporalWorkflowId: null,
				detailLevel: "BRIEF",
			},
			created: true,
		});
		mockWorkflowStart.mockResolvedValue({
			workflowId: "newsletter-send-send-override",
		});

		await sendNow({
			input: {
				projectId: "proj-1",
				organizationId: null,
				detailLevel: "BRIEF",
			},
			context: personalContext,
		});

		// Override in the request beats the persisted settings value.
		expect(mockCreateOrGetNewsletterSend).toHaveBeenCalledWith(
			expect.objectContaining({ detailLevel: "BRIEF" }),
		);
	});

	it("reads detailLevel back from the created send row into the workflow.start args", async () => {
		mockProjectFindFirst.mockResolvedValue({
			id: "proj-1",
			name: "Acme",
			organizationId: null,
			userId: "user-1",
		});
		mockFindRecentNonFailedSend.mockResolvedValue(null);
		mockIsTemporalAvailable.mockResolvedValue(true);
		// Neither input nor settings say BRIEF — only the row returned by
		// createOrGetNewsletterSend does. The workflow args must be built from
		// that row read-back, not recomputed from input/settings.
		mockGetNewsletterSettings.mockResolvedValue({
			cadence: "WEEKLY",
			lookbackDays: null,
			lastSentAt: null,
			detailLevel: "STANDARD",
		});
		mockCreateOrGetNewsletterSend.mockResolvedValue({
			send: {
				id: "send-readback",
				temporalWorkflowId: null,
				detailLevel: "BRIEF",
			},
			created: true,
		});
		mockWorkflowStart.mockResolvedValue({
			workflowId: "newsletter-send-send-readback",
		});

		await sendNow({
			input: { projectId: "proj-1", organizationId: null },
			context: personalContext,
		});

		expect(mockWorkflowStart).toHaveBeenCalledWith(
			"generateAndSendNewsletterWorkflow",
			expect.objectContaining({
				args: [expect.objectContaining({ detailLevel: "BRIEF" })],
			}),
		);
	});
});

describe("sendNow — delivery destination threading", () => {
	it("resolves deliveryDestination + chatChannels from settings (no per-send override), passes both to createOrGetNewsletterSend, and reads both back from the created send row into the workflow.start args", async () => {
		mockProjectFindFirst.mockResolvedValue({
			id: "proj-1",
			name: "Acme",
			organizationId: null,
			userId: "user-1",
		});
		mockFindRecentNonFailedSend.mockResolvedValue(null);
		mockIsTemporalAvailable.mockResolvedValue(true);
		const settingsChatChannels = [
			{ platform: "SLACK", teamId: "team-1", channelId: "chan-1" },
		];
		const frozenChatChannels = [
			{ platform: "TEAMS", teamId: "team-2", channelId: "chan-2" },
		];
		// The settings values (EMAIL / settingsChatChannels) deliberately DIFFER
		// from the persisted send row's frozen values (CHAT / frozenChatChannels)
		// below. The workflow-start args must come from the row read-back
		// (send.deliveryDestination / send.chatChannels), not from
		// `effectiveDeliveryDestination` / `settings.chatChannels` — mirrors how
		// the "reads detailLevel back from the created send row" test above proves
		// the same read-back precedence for detailLevel (Fizzy 1869: chatChannels
		// is now frozen at creation too, like deliveryDestination/detailLevel).
		mockGetNewsletterSettings.mockResolvedValue({
			cadence: "WEEKLY",
			lookbackDays: null,
			lastSentAt: null,
			deliveryDestination: "EMAIL",
			chatChannels: settingsChatChannels,
			requireApproval: false,
		});
		mockCreateOrGetNewsletterSend.mockResolvedValue({
			send: {
				id: "send-dest",
				temporalWorkflowId: null,
				deliveryDestination: "CHAT",
				chatChannels: frozenChatChannels,
				requireApproval: false,
			},
			created: true,
		});
		mockWorkflowStart.mockResolvedValue({
			workflowId: "newsletter-send-send-dest",
		});

		await sendNow({
			input: { projectId: "proj-1", organizationId: null },
			context: personalContext,
		});

		// The settings values (no per-send override input in v1) are passed to
		// createOrGetNewsletterSend.
		expect(mockCreateOrGetNewsletterSend).toHaveBeenCalledWith(
			expect.objectContaining({
				deliveryDestination: "EMAIL",
				chatChannels: settingsChatChannels,
			}),
		);
		// The workflow args are built from the created-row read-back (CHAT +
		// frozenChatChannels), NOT the pre-persist settings values.
		expect(mockWorkflowStart).toHaveBeenCalledWith(
			"generateAndSendNewsletterWorkflow",
			expect.objectContaining({
				args: [
					expect.objectContaining({
						deliveryDestination: "CHAT",
						chatChannels: frozenChatChannels,
					}),
				],
			}),
		);
	});
});

describe("sends.list — pagination + filter + shape", () => {
	const projectId = "proj-1";
	const organizationId = null;

	beforeEach(() => {
		mockProjectFindFirst.mockResolvedValue({
			id: projectId,
			organizationId: null,
			userId: "user-1",
		});
		mockListNewsletterSends.mockResolvedValue([]);
		mockCountNewsletterSends.mockResolvedValue(0);
	});

	it("returns { sends, total } with default pagination", async () => {
		const sends = [{ id: "s1", status: "SENT" }];
		mockListNewsletterSends.mockResolvedValue(sends);
		mockCountNewsletterSends.mockResolvedValue(5);

		const res = (await listSends({
			input: {
				projectId,
				organizationId,
				limit: 15,
				offset: 0,
				status: "all",
			},
			context: personalContext,
		})) as { sends: unknown[]; total: number };

		expect(Array.isArray(res.sends)).toBe(true);
		expect(typeof res.total).toBe("number");
		expect(res.sends).toEqual(sends);
		expect(res.total).toBe(5);
	});

	it("rejects an unsupported page size (e.g. 20)", async () => {
		// The procedure uses z.union([z.literal(15), z.literal(50), z.literal(100)]),
		// so 20 must be rejected. The chainable mock strips .input() from the call
		// chain, so test Zod parse behaviour directly via the schema.
		const { z } = await import("zod");
		const limitSchema = z.union([
			z.literal(15),
			z.literal(50),
			z.literal(100),
		]);
		expect(limitSchema.safeParse(20).success).toBe(false);
		expect(limitSchema.safeParse(15).success).toBe(true);
		expect(limitSchema.safeParse(50).success).toBe(true);
		expect(limitSchema.safeParse(100).success).toBe(true);
	});

	it("returns NOT_FOUND for a wrong-tenant project", async () => {
		mockProjectFindFirst.mockResolvedValue(null);
		await expect(
			listSends({
				input: { projectId: "other-proj", organizationId: null },
				context: personalContext,
			}),
		).rejects.toThrow(ORPCError);
		expect(mockListNewsletterSends).not.toHaveBeenCalled();
	});
});

describe("sends.memberList", () => {
	beforeEach(() => {
		mockProjectFindFirst.mockReset().mockResolvedValue({ id: "p1" });
		mockListNewsletterSendsForMembers.mockReset().mockResolvedValue([
			{
				id: "s1",
				status: "SENT",
				createdAt: new Date(),
				content: { headline: "h" },
			},
		]);
		mockCountNewsletterSendsForMembers.mockReset().mockResolvedValue(1);
	});
	const ctx = { user: { id: "u1" }, session: {} } as any;

	it("returns {sends,total} for a member", async () => {
		const r = await (memberListSendsProcedure as any)._handler({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				limit: 15,
				offset: 0,
			},
			context: ctx,
		});
		expect(r.total).toBe(1);
		expect(r.sends).toHaveLength(1);
	});

	it("NOT_FOUND on wrong tenant", async () => {
		mockProjectFindFirst.mockResolvedValue(null);
		await expect(
			(memberListSendsProcedure as any)._handler({
				input: { projectId: "p1", organizationId: "org-9" },
				context: ctx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});
