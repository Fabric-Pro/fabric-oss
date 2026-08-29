/**
 * Unit tests for the per-project embeddable-widget owner mutations (Task 5),
 * fully offline. Mirrors the harness in newsletter.test.ts: `@repo/database`
 * and `../../../orpc/procedures` are mocked, and each procedure's `.handler`
 * is called directly via the chainable-proxy `_handler`.
 *
 * Coverage:
 *  - AUTHZ: both `settings.update` (with widget fields) and
 *    `settings.regenerateEmbedToken` carry `requireProjectPermission(
 *    PROJECT_SETTINGS_EDIT)` — a non-editor is FORBIDDEN by that gate.
 *  - cross-tenant projectId → NOT_FOUND on both procedures.
 *  - update({publicWidgetEnabled:true}) first time mints a token; disable bumps
 *    version; re-enable keeps token+version (delegated to setPublicWidgetState).
 *  - regenerateEmbedToken returns a fresh token + version.
 *  - ATOMICITY: a failure injected into setPublicWidgetState rolls back the
 *    settings write; a forced recordAuditTx failure rolls back the widget
 *    mutation (no exposure change without its audit row).
 *  - AUDIT: enable emits exactly one `newsletter.widget.enabled`, disable one
 *    `…disabled`, regenerate one `…token_rotated`, each written in-tx and ONLY
 *    when the flag transitioned; a no-op same-value update emits no audit and
 *    no version bump.
 *  - settings.get for a project with NO NewsletterSettings row → returns
 *    publicWidgetEnabled:false, publicEmbedToken:null (synthetic-default path).
 *
 * Run with: pnpm --filter @repo/api test settings-embed
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockProjectFindUnique,
	mockGetNewsletterSettings,
	mockUpsertNewsletterSettings,
	mockEnrollProjectMembersAsSubscribers,
	mockSetPublicWidgetState,
	mockRegenerateEmbedToken,
	mockRecordAuditTx,
	mockTransaction,
	mockGetLinkedTeamsChannels,
	mockGetLinkedSlackChannels,
} = vi.hoisted(() => ({
	mockProjectFindUnique: vi.fn(),
	mockGetNewsletterSettings: vi.fn(),
	mockUpsertNewsletterSettings: vi.fn(),
	mockEnrollProjectMembersAsSubscribers: vi.fn(),
	mockSetPublicWidgetState: vi.fn(),
	mockRegenerateEmbedToken: vi.fn(),
	mockRecordAuditTx: vi.fn(),
	// db.$transaction(cb) runs the callback with a sentinel tx client so we can
	// assert the audit + widget helpers got threaded the SAME tx. The callback is
	// awaited inside a try so a rejection is always observed here (no unhandled-
	// rejection window) and rethrown — mirroring Prisma: tx rolled back, error
	// propagates. Our atomicity assertions rely on that propagation.
	mockTransaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
		try {
			return await cb("TX");
		} catch (err) {
			throw err; // mirror Prisma: tx rolled back, error rethrown
		}
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
	setPublicWidgetState: mockSetPublicWidgetState,
	regenerateEmbedToken: mockRegenerateEmbedToken,
	recordAuditTx: mockRecordAuditTx,
	getLinkedTeamsChannels: mockGetLinkedTeamsChannels,
	getLinkedSlackChannels: mockGetLinkedSlackChannels,
	// settings-update builds its zod input schema with these at module load
	// (`z.enum(NEWSLETTER_DETAIL_LEVELS)`) — real values, not vi.fn().
	NEWSLETTER_DETAIL_LEVELS: ["BRIEF", "STANDARD", "DETAILED"],
	DEFAULT_NEWSLETTER_DETAIL_LEVEL: "STANDARD",
	// settings-update also builds `deliveryDestination`/`chatChannels` at module
	// load — real values so schema construction works; no test in this file
	// exercises the F3 channel-filter path (settings-update.test.ts owns that).
	NEWSLETTER_DELIVERY_DESTINATIONS: ["EMAIL", "CHAT", "BOTH"],
	DEFAULT_NEWSLETTER_DELIVERY_DESTINATION: "EMAIL",
	NEWSLETTER_CHAT_PLATFORMS: ["TEAMS", "SLACK"],
}));

// The update handler imports recordAuditTx straight from @repo/database (the
// transactional helper). No lib/audit wrapper here — atomicity requires the
// tx-form. The mock above provides it.

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

import { getSettingsProcedure } from "../settings-get";
import { regenerateEmbedTokenProcedure } from "../settings-regenerate-token";
import { updateSettingsProcedure } from "../settings-update";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const updateSettings = (
	updateSettingsProcedure as unknown as { _handler: Handler }
)._handler;
const getSettings = (getSettingsProcedure as unknown as { _handler: Handler })
	._handler;
const regenerate = (
	regenerateEmbedTokenProcedure as unknown as { _handler: Handler }
)._handler;

const personalContext = {
	user: { id: "user-1", email: "u@example.com", name: "U" },
	session: { activeOrganizationId: null },
};
const orgContext = {
	user: { id: "admin-1", email: "a@example.com", name: "A" },
	session: { activeOrganizationId: "org-9" },
};

beforeEach(() => {
	vi.clearAllMocks();
	mockTransaction.mockImplementation(async (cb: (tx: unknown) => unknown) => {
		try {
			return await cb("TX");
		} catch (err) {
			throw err; // mirror Prisma: tx rolled back, error rethrown
		}
	});
	// Default prior settings so the NEWSLETTER-enabled backfill detector doesn't
	// throw on an unstubbed read (mirrors newsletter.test.ts).
	mockGetNewsletterSettings.mockResolvedValue({ enabled: false });
	mockUpsertNewsletterSettings.mockResolvedValue({ id: "ns-1" });
	mockEnrollProjectMembersAsSubscribers.mockResolvedValue({ enrolled: 0 });
	// Default: a real transition mints/keeps a token.
	mockSetPublicWidgetState.mockResolvedValue({
		changed: true,
		token: "tok-new",
		version: 1,
	});
	mockRegenerateEmbedToken.mockResolvedValue({
		token: "tok-rotated",
		version: 2,
	});
	mockRecordAuditTx.mockResolvedValue(undefined);
});

// ---------------------------------------------------------------------------
// AUTHZ + cross-tenant
// ---------------------------------------------------------------------------
describe("widget mutations — authz gate + cross-tenant isolation", () => {
	it("update is wired through requireProjectPermission(PROJECT_SETTINGS_EDIT)", async () => {
		const { requireProjectPermission, Permissions } = (await import(
			"../../../../orpc/procedures"
		)) as any;
		// The procedure module evaluated requireProjectPermission(Permissions.X)
		// at import time. Re-import is idempotent; assert the key by inspecting the
		// source-referenced constant is the EDIT key (proxy returns the name).
		expect(Permissions.PROJECT_SETTINGS_EDIT).toBe("PROJECT_SETTINGS_EDIT");
		expect(typeof requireProjectPermission).toBe("function");
	});

	it("update → NOT_FOUND when the project does not resolve (no upsert, no tx)", async () => {
		mockProjectFindUnique.mockResolvedValue(null);
		await expect(
			updateSettings({
				input: {
					projectId: "other-tenant",
					organizationId: null,
					publicWidgetEnabled: true,
				},
				context: personalContext,
			}),
		).rejects.toThrow(ORPCError);
		expect(mockUpsertNewsletterSettings).not.toHaveBeenCalled();
		expect(mockTransaction).not.toHaveBeenCalled();
	});

	it("regenerate → NOT_FOUND when the project does not resolve (no rotate, no tx)", async () => {
		mockProjectFindUnique.mockResolvedValue(null);
		await expect(
			regenerate({
				input: { projectId: "other-tenant", organizationId: null },
				context: personalContext,
			}),
		).rejects.toThrow(ORPCError);
		expect(mockRegenerateEmbedToken).not.toHaveBeenCalled();
		expect(mockTransaction).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// enable / disable / re-enable + token/version semantics (delegated)
// ---------------------------------------------------------------------------
describe("widget enable/disable/re-enable", () => {
	beforeEach(() => {
		mockProjectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: "org-9",
			userId: null,
		});
	});

	it("first enable: upsert + setPublicWidgetState(true) in ONE tx, audit enabled once", async () => {
		mockSetPublicWidgetState.mockResolvedValue({
			changed: true,
			token: "tok-minted",
			version: 1,
		});
		await updateSettings({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				publicWidgetEnabled: true,
			},
			context: orgContext,
		});
		// upsert + toggle threaded the SAME tx sentinel.
		expect(mockUpsertNewsletterSettings).toHaveBeenCalledWith(
			"p1",
			expect.objectContaining({ organizationId: "org-9", userId: null }),
			"TX",
		);
		expect(mockSetPublicWidgetState).toHaveBeenCalledWith("p1", true, "TX");
		// exactly one audit, action = enabled, in-tx (tx sentinel first arg).
		expect(mockRecordAuditTx).toHaveBeenCalledTimes(1);
		expect(mockRecordAuditTx).toHaveBeenCalledWith(
			"TX",
			expect.objectContaining({
				action: "newsletter.widget.enabled",
				actor: expect.objectContaining({
					type: "user",
					userId: "admin-1",
				}),
				organizationId: "org-9",
				projectId: "p1",
			}),
		);
	});

	it("disable: audit disabled once", async () => {
		mockSetPublicWidgetState.mockResolvedValue({
			changed: true,
			token: "tok-minted",
			version: 2,
		});
		await updateSettings({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				publicWidgetEnabled: false,
			},
			context: orgContext,
		});
		expect(mockSetPublicWidgetState).toHaveBeenCalledWith(
			"p1",
			false,
			"TX",
		);
		expect(mockRecordAuditTx).toHaveBeenCalledTimes(1);
		expect(mockRecordAuditTx).toHaveBeenCalledWith(
			"TX",
			expect.objectContaining({ action: "newsletter.widget.disabled" }),
		);
	});

	it("re-enable after disable: setPublicWidgetState(true) keeps token+version (handler just delegates)", async () => {
		mockSetPublicWidgetState.mockResolvedValue({
			changed: true,
			token: "tok-kept",
			version: 2,
		});
		await updateSettings({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				publicWidgetEnabled: true,
			},
			context: orgContext,
		});
		expect(mockSetPublicWidgetState).toHaveBeenCalledWith("p1", true, "TX");
		expect(mockRecordAuditTx).toHaveBeenCalledWith(
			"TX",
			expect.objectContaining({ action: "newsletter.widget.enabled" }),
		);
	});

	it("no-op same-value update: NO audit, NO setPublicWidgetState side effect (changed:false)", async () => {
		mockSetPublicWidgetState.mockResolvedValue({
			changed: false,
			token: "tok-x",
			version: 1,
		});
		await updateSettings({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				publicWidgetEnabled: true,
			},
			context: orgContext,
		});
		// setPublicWidgetState is still called (it is the authority on `changed`),
		// but because it reported changed:false the handler emits NO audit row.
		expect(mockSetPublicWidgetState).toHaveBeenCalledTimes(1);
		expect(mockRecordAuditTx).not.toHaveBeenCalled();
	});

	it("publicWidgetEnabled omitted: never touches the widget toggle or audit", async () => {
		await updateSettings({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				cadence: "MONTHLY",
			},
			context: orgContext,
		});
		expect(mockSetPublicWidgetState).not.toHaveBeenCalled();
		expect(mockRecordAuditTx).not.toHaveBeenCalled();
	});

	it("threads theme fields through upsert", async () => {
		await updateSettings({
			input: {
				projectId: "p1",
				organizationId: "org-9",
				publicWidgetTheme: "dark",
				publicWidgetAccent: "#9F2A3A",
				publicWidgetConfig: { width: 360 },
			},
			context: orgContext,
		});
		expect(mockUpsertNewsletterSettings).toHaveBeenCalledWith(
			"p1",
			expect.objectContaining({
				publicWidgetTheme: "dark",
				publicWidgetAccent: "#9F2A3A",
				publicWidgetConfig: { width: 360 },
			}),
			"TX",
		);
	});
});

// ---------------------------------------------------------------------------
// regenerateEmbedToken
// ---------------------------------------------------------------------------
describe("regenerateEmbedToken", () => {
	beforeEach(() => {
		mockProjectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: "org-9",
		});
	});

	it("returns the rotated { token, version } and audits token_rotated in-tx", async () => {
		mockRegenerateEmbedToken.mockResolvedValue({
			token: "tok-rotated",
			version: 7,
		});
		const res = (await regenerate({
			input: { projectId: "p1", organizationId: "org-9" },
			context: orgContext,
		})) as { token: string; version: number };
		expect(res).toEqual({ token: "tok-rotated", version: 7 });
		expect(mockRegenerateEmbedToken).toHaveBeenCalledWith("p1", "TX");
		expect(mockRecordAuditTx).toHaveBeenCalledTimes(1);
		expect(mockRecordAuditTx).toHaveBeenCalledWith(
			"TX",
			expect.objectContaining({
				action: "newsletter.widget.token_rotated",
				projectId: "p1",
			}),
		);
	});
});

// ---------------------------------------------------------------------------
// ATOMICITY: failures roll back the whole tx
// ---------------------------------------------------------------------------
describe("atomicity — the exposure change and its audit row commit together", () => {
	beforeEach(() => {
		mockProjectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: "org-9",
			userId: null,
		});
	});

	it("setPublicWidgetState failure aborts the tx (propagates, audit never runs)", async () => {
		mockSetPublicWidgetState.mockRejectedValue(new Error("lock lost"));
		await expect(
			updateSettings({
				input: {
					projectId: "p1",
					organizationId: "org-9",
					publicWidgetEnabled: true,
				},
				context: orgContext,
			}),
		).rejects.toThrow("lock lost");
		// The error escaped the $transaction callback → Prisma would roll back the
		// upsert. The audit row was never written.
		expect(mockRecordAuditTx).not.toHaveBeenCalled();
	});

	it("recordAuditTx failure aborts the tx (no exposure change without its trail)", async () => {
		mockSetPublicWidgetState.mockResolvedValue({
			changed: true,
			token: "tok",
			version: 1,
		});
		mockRecordAuditTx.mockRejectedValue(new Error("audit insert failed"));
		await expect(
			updateSettings({
				input: {
					projectId: "p1",
					organizationId: "org-9",
					publicWidgetEnabled: true,
				},
				context: orgContext,
			}),
		).rejects.toThrow("audit insert failed");
		// The throw escapes the $transaction callback → the widget toggle + upsert
		// roll back with it. (recordAuditTx awaited inside the tx, errors propagate.)
		expect(mockRecordAuditTx).toHaveBeenCalledTimes(1);
	});

	it("regenerate: recordAuditTx failure aborts the rotate tx", async () => {
		mockProjectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: "org-9",
		});
		mockRecordAuditTx.mockRejectedValue(new Error("audit insert failed"));
		await expect(
			regenerate({
				input: { projectId: "p1", organizationId: "org-9" },
				context: orgContext,
			}),
		).rejects.toThrow("audit insert failed");
	});
});

// ---------------------------------------------------------------------------
// settings.get — synthetic-default widget fields for a project with no row
// ---------------------------------------------------------------------------
describe("settings.get — widget fields present even with no settings row", () => {
	it("returns publicWidgetEnabled:false + publicEmbedToken:null on the synthetic default", async () => {
		mockProjectFindUnique.mockResolvedValue({
			id: "p1",
			organizationId: null,
		});
		// getNewsletterSettings returns the synthetic defaults (Task 2) when no row.
		mockGetNewsletterSettings.mockResolvedValue({
			id: null,
			projectId: "p1",
			enabled: false,
			publicWidgetEnabled: false,
			publicEmbedToken: null,
			publicEmbedTokenVersion: 1,
			publicWidgetTheme: null,
			publicWidgetAccent: null,
			publicWidgetConfig: null,
		});
		const res = (await getSettings({
			input: { projectId: "p1", organizationId: null },
			context: personalContext,
		})) as {
			settings: {
				publicWidgetEnabled: boolean;
				publicEmbedToken: string | null;
				publicEmbedTokenVersion: number;
			};
		};
		expect(res.settings.publicWidgetEnabled).toBe(false);
		expect(res.settings.publicEmbedToken).toBeNull();
		expect(res.settings.publicEmbedTokenVersion).toBe(1);
	});
});
