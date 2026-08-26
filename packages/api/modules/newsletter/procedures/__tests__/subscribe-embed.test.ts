import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mirrors subscribe-to-newsletter.test.ts harness, extended with the embed path
// helpers (resolveProjectByEmbedToken + upsertEmbedPendingSubscriber). The
// `token`-bearing branch is exercised here; the token-absent branch is asserted
// to keep delegating to the existing env-locked Fabric-main helper untouched.
const {
	mockCreatePending,
	mockResolveByEmbedToken,
	mockUpsertEmbedPending,
	mockProjectFindUnique,
	mockSettingsFindUnique,
	mockSendEmail,
	mockRunInBackground,
	mockWarn,
} = vi.hoisted(() => ({
	mockCreatePending: vi.fn(),
	mockResolveByEmbedToken: vi.fn(),
	mockUpsertEmbedPending: vi.fn(),
	mockProjectFindUnique: vi.fn(),
	mockSettingsFindUnique: vi.fn(),
	mockSendEmail: vi.fn().mockResolvedValue(true),
	mockRunInBackground: vi.fn(),
	mockWarn: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	createPendingPublicSubscriber: mockCreatePending,
	resolveProjectByEmbedToken: mockResolveByEmbedToken,
	upsertEmbedPendingSubscriber: mockUpsertEmbedPending,
	db: {
		project: { findUnique: mockProjectFindUnique },
		newsletterSettings: { findUnique: mockSettingsFindUnique },
	},
}));
vi.mock("@repo/mail", () => ({ sendEmail: mockSendEmail }));
vi.mock("@repo/utils", () => ({ getBaseUrl: () => "https://fabric.pro" }));
vi.mock("@repo/logs", () => ({
	logger: { warn: mockWarn, error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../../weave/lib/run-in-background", () => ({
	runInBackground: mockRunInBackground,
}));
vi.mock("../../../../orpc/procedures", () => {
	// biome-ignore lint/suspicious/noExplicitAny: minimal chainable test double
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...a: unknown[]) => unknown) => ({ _handler: fn }),
	};
	return { rateLimitedPublicProcedure: chainable };
});

import { subscribeToNewsletter } from "../subscribe-to-newsletter";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const subscribe = (subscribeToNewsletter as unknown as { _handler: Handler })
	._handler;
const ctx = { locale: "en" };

describe("subscribe-to-newsletter (embed token path)", () => {
	const ORIGINAL_FABRIC_MAIN = process.env.FABRIC_MAIN_PROJECT_ID;

	beforeEach(() => {
		vi.clearAllMocks();
		process.env.FABRIC_MAIN_PROJECT_ID = "fabric-main";
		// Defaults for the env Fabric-main path (used only by the token-absent test).
		mockProjectFindUnique.mockResolvedValue({
			id: "fabric-main",
			organizationId: "org-9",
			userId: "owner-1",
		});
		mockSettingsFindUnique.mockResolvedValue({
			createdByUserId: "admin-1",
		});
		mockCreatePending.mockResolvedValue({
			created: true,
			token: "tok-main",
		});
		mockUpsertEmbedPending.mockResolvedValue({
			token: "tok-embed",
			sendEmail: true,
		});
	});

	afterEach(() => {
		if (ORIGINAL_FABRIC_MAIN === undefined) {
			delete process.env.FABRIC_MAIN_PROJECT_ID;
		} else {
			process.env.FABRIC_MAIN_PROJECT_ID = ORIGINAL_FABRIC_MAIN;
		}
	});

	it("token ABSENT → unchanged Fabric-main path (env helper), NOT the embed path", async () => {
		const res = await subscribe({
			input: { email: "New@X.com" },
			context: ctx,
		});
		expect(res).toEqual({ success: true });
		// Existing env helper drives the no-token branch.
		expect(mockCreatePending).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "fabric-main",
				email: "new@x.com",
			}),
		);
		// Embed helpers untouched.
		expect(mockResolveByEmbedToken).not.toHaveBeenCalled();
		expect(mockUpsertEmbedPending).not.toHaveBeenCalled();
	});

	it("token INVALID (resolve → null) → generic success, NO upsert, NO email", async () => {
		mockResolveByEmbedToken.mockResolvedValue(null);
		const res = await subscribe({
			input: { email: "a@b.com", token: "bad-token" },
			context: ctx,
		});
		expect(res).toEqual({ success: true });
		expect(mockResolveByEmbedToken).toHaveBeenCalledWith("bad-token");
		expect(mockUpsertEmbedPending).not.toHaveBeenCalled();
		expect(mockSendEmail).not.toHaveBeenCalled();
		expect(mockRunInBackground).not.toHaveBeenCalled();
		// Embed branch must NOT fall through to the env Fabric-main helper.
		expect(mockCreatePending).not.toHaveBeenCalled();
	});

	it("token valid but widget DISABLED → generic success, NO upsert, NO email", async () => {
		mockResolveByEmbedToken.mockResolvedValue({
			projectId: "proj-1",
			organizationId: "org-7",
			userId: null,
			publicWidgetEnabled: false,
			publicEmbedTokenVersion: 3,
		});
		const res = await subscribe({
			input: { email: "a@b.com", token: "disabled-token" },
			context: ctx,
		});
		expect(res).toEqual({ success: true });
		expect(mockUpsertEmbedPending).not.toHaveBeenCalled();
		expect(mockSendEmail).not.toHaveBeenCalled();
		expect(mockRunInBackground).not.toHaveBeenCalled();
		expect(mockCreatePending).not.toHaveBeenCalled();
	});

	it("token VALID + enabled (org) → upsert with resolved version + org tenant cols, sends confirm email", async () => {
		// createdByUserId is now folded into the resolve result (I-2) — no second
		// settings query in the handler.
		mockResolveByEmbedToken.mockResolvedValue({
			projectId: "proj-org",
			organizationId: "org-42",
			userId: null,
			publicWidgetEnabled: true,
			publicEmbedTokenVersion: 5,
			createdByUserId: "creator-9",
		});
		mockUpsertEmbedPending.mockResolvedValue({
			token: "embed-tok-xyz",
			sendEmail: true,
		});

		const res = await subscribe({
			input: { email: "Sub@Embed.COM ", token: "good-token" },
			context: ctx,
		});

		expect(res).toEqual({ success: true });
		// Embed path resolves the actor from the token, not a separate settings query.
		expect(mockSettingsFindUnique).not.toHaveBeenCalled();
		expect(mockUpsertEmbedPending).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-org",
				email: "sub@embed.com",
				userId: null,
				organizationId: "org-42",
				createdByUserId: "creator-9",
				version: 5,
			}),
		);
		expect(mockSendEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "sub@embed.com",
				locale: "en",
				templateId: "newsletterConfirm",
				context: {
					confirmUrl:
						"https://fabric.pro/newsletter/confirm/embed-tok-xyz",
				},
			}),
		);
		expect(mockRunInBackground).toHaveBeenCalledTimes(1);
		// Embed path must not also fire the env Fabric-main helper.
		expect(mockCreatePending).not.toHaveBeenCalled();
	});

	it("token VALID + enabled (personal) → owner-fallback actor when resolve has no createdByUserId", async () => {
		// createdByUserId null on the resolve result → handler falls back to the
		// project owner (proj.userId) as the audit actor.
		mockResolveByEmbedToken.mockResolvedValue({
			projectId: "proj-personal",
			organizationId: null,
			userId: "owner-77",
			publicWidgetEnabled: true,
			publicEmbedTokenVersion: 1,
			createdByUserId: null,
		});
		mockUpsertEmbedPending.mockResolvedValue({
			token: "p-tok",
			sendEmail: true,
		});

		await subscribe({
			input: { email: "p@x.com", token: "good" },
			context: ctx,
		});

		expect(mockUpsertEmbedPending).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-personal",
				userId: "owner-77",
				organizationId: null,
				createdByUserId: "owner-77",
				version: 1,
			}),
		);
		expect(mockRunInBackground).toHaveBeenCalledTimes(1);
	});

	it("send-once: upsert returns {token:null,sendEmail:false} → generic success, NO email", async () => {
		mockResolveByEmbedToken.mockResolvedValue({
			projectId: "proj-org",
			organizationId: "org-42",
			userId: null,
			publicWidgetEnabled: true,
			publicEmbedTokenVersion: 2,
			createdByUserId: "creator-9",
		});
		mockUpsertEmbedPending.mockResolvedValue({
			token: null,
			sendEmail: false,
		});

		const res = await subscribe({
			input: { email: "again@x.com", token: "good-token" },
			context: ctx,
		});

		expect(res).toEqual({ success: true });
		expect(mockUpsertEmbedPending).toHaveBeenCalledTimes(1);
		expect(mockSendEmail).not.toHaveBeenCalled();
		expect(mockRunInBackground).not.toHaveBeenCalled();
	});

	it("token VALID + enabled but UNRESOLVABLE actor (org, null createdByUserId & null owner) → generic success, NO upsert, NO email, warns", async () => {
		// Enabled org-context project with no settings actor AND no owner to fall back
		// to → the audit actor is unresolvable. The subscriber is dropped (generic
		// success) but the drop is logged (M-1) so an actorless project is diagnosable.
		mockResolveByEmbedToken.mockResolvedValue({
			projectId: "proj-org",
			organizationId: "org-42",
			userId: null,
			publicWidgetEnabled: true,
			publicEmbedTokenVersion: 4,
			createdByUserId: null,
		});

		const res = await subscribe({
			input: { email: "drop@x.com", token: "good-token" },
			context: ctx,
		});

		expect(res).toEqual({ success: true });
		expect(mockUpsertEmbedPending).not.toHaveBeenCalled();
		expect(mockSendEmail).not.toHaveBeenCalled();
		expect(mockRunInBackground).not.toHaveBeenCalled();
		expect(mockWarn).toHaveBeenCalledWith(
			"Public newsletter subscribe discarded",
			expect.objectContaining({
				event: "newsletter_public_subscribe_discarded",
				reason: "no audit actor (embed)",
			}),
		);
	});
});
