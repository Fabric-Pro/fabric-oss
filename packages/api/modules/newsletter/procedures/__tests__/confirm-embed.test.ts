import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Handler-level unit tests for the token-only public confirm procedure.
 *
 * Task 7 makes `newsletter.confirmSubscription({ token })` resolve PURELY by
 * token (per-project) — no FABRIC_MAIN_PROJECT_ID env lock. The procedure
 * delegates the per-project resolution + widget/version gate entirely to the
 * `confirmPublicSubscriberByToken` DB helper (Task 3, unit-tested there) and is
 * responsible only for: returning `{ confirmed }`, sending the welcome email
 * ONLY when confirmation actually succeeds, and forwarding to GTM Brain ONLY
 * when the gated confirm resolved to the configured Fabric-main project.
 *
 * FABRIC_MAIN_PROJECT_ID is a comparison target for that last step, never a
 * second confirmation path: re-resolving the token through the ungated
 * project-scoped `confirmPublicSubscriber` would bypass the revocation gate.
 *
 * We mock `confirmPublicSubscriberByToken` at the `@repo/database` boundary so
 * the gate logic is out of scope here — these assert the procedure's delegation
 * + welcome-email + GTM-forwarding contract.
 */
const {
	mockCaptureConfirmedLead,
	mockConfirmByToken,
	mockSendEmail,
	mockRunInBackground,
} = vi.hoisted(() => ({
	mockCaptureConfirmedLead: vi.fn().mockResolvedValue(undefined),
	mockConfirmByToken: vi.fn(),
	mockSendEmail: vi.fn().mockResolvedValue(true),
	mockRunInBackground: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	confirmPublicSubscriberByToken: mockConfirmByToken,
}));
vi.mock("@repo/mail", () => ({ sendEmail: mockSendEmail }));
vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock("../../../weave/lib/run-in-background", () => ({
	runInBackground: mockRunInBackground,
}));
vi.mock("../../lib/gtm-lead", () => ({
	captureConfirmedNewsletterLead: mockCaptureConfirmedLead,
}));
vi.mock("../../../../orpc/procedures", () => {
	const chainable: any = {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...a: unknown[]) => unknown) => ({ _handler: fn }),
	};
	return { rateLimitedPublicProcedure: chainable };
});

import { confirmSubscriptionProcedure } from "../confirm-subscription";

type Handler = (args: { input: unknown; context: unknown }) => Promise<unknown>;
const confirm = (
	confirmSubscriptionProcedure as unknown as { _handler: Handler }
)._handler;
const ctx = { locale: "en" };

describe("confirm-subscription — token-only (per-project + version gate)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		delete process.env.FABRIC_MAIN_PROJECT_ID;
	});

	it("delegates by token alone and sends the welcome email once on confirm", async () => {
		mockConfirmByToken.mockResolvedValue({
			confirmed: true,
			email: "x@y.z",
			projectId: "p-embed",
		});
		const res = await confirm({
			input: { token: "tok-1234567890" },
			context: ctx,
		});
		expect(res).toEqual({ confirmed: true });
		// Resolved purely by token — no projectId / env passed.
		expect(mockConfirmByToken).toHaveBeenCalledWith("tok-1234567890");
		expect(mockConfirmByToken).toHaveBeenCalledTimes(1);
		expect(mockSendEmail).toHaveBeenCalledWith(
			expect.objectContaining({
				to: "x@y.z",
				locale: "en",
				templateId: "newsletterSignup",
				context: {},
			}),
		);
		expect(mockRunInBackground).toHaveBeenCalledTimes(1);
	});

	it("forwards a confirmed Fabric-main opt-in to GTM Brain", async () => {
		process.env.FABRIC_MAIN_PROJECT_ID = "fabric-main";
		mockConfirmByToken.mockResolvedValue({
			confirmed: true,
			email: "subscriber@example.com",
			projectId: "fabric-main",
		});

		const res = await confirm({
			input: { token: "tok-main-123456" },
			context: ctx,
		});

		expect(res).toEqual({ confirmed: true });
		// Still ONE gated resolution — GTM eligibility is decided from its result.
		expect(mockConfirmByToken).toHaveBeenCalledTimes(1);
		expect(mockConfirmByToken).toHaveBeenCalledWith("tok-main-123456");
		expect(mockCaptureConfirmedLead).toHaveBeenCalledWith({
			email: "subscriber@example.com",
		});
		expect(mockRunInBackground).toHaveBeenCalledTimes(2);
	});

	it("does NOT forward another project's opt-in to GTM Brain", async () => {
		process.env.FABRIC_MAIN_PROJECT_ID = "fabric-main";
		mockConfirmByToken.mockResolvedValue({
			confirmed: true,
			email: "tenant@example.com",
			projectId: "some-customer-project",
		});

		await confirm({ input: { token: "tok-other-1234" }, context: ctx });

		expect(mockCaptureConfirmedLead).not.toHaveBeenCalled();
		expect(mockRunInBackground).toHaveBeenCalledTimes(1);
	});

	it("does NOT forward when a Fabric-main token fails the revocation gate", async () => {
		// The gate lives in the helper; a revoked/disabled widget yields
		// confirmed:false with no projectId — GTM must never see it.
		process.env.FABRIC_MAIN_PROJECT_ID = "fabric-main";
		mockConfirmByToken.mockResolvedValue({
			confirmed: false,
			email: null,
			projectId: null,
		});

		const res = await confirm({
			input: { token: "tok-revoked-12" },
			context: ctx,
		});

		expect(res).toEqual({ confirmed: false });
		expect(mockCaptureConfirmedLead).not.toHaveBeenCalled();
		expect(mockSendEmail).not.toHaveBeenCalled();
		expect(mockRunInBackground).not.toHaveBeenCalled();
	});

	it("returns confirmed:false and sends nothing when the helper rejects (gated/bad token)", async () => {
		// Covers the gate failures the helper owns (disabled widget, stale
		// version, unknown/replayed token): the procedure must NOT mail.
		mockConfirmByToken.mockResolvedValue({
			confirmed: false,
			email: null,
			projectId: null,
		});
		const res = await confirm({
			input: { token: "bad-token-xyz" },
			context: ctx,
		});
		expect(res).toEqual({ confirmed: false });
		expect(mockConfirmByToken).toHaveBeenCalledWith("bad-token-xyz");
		expect(mockSendEmail).not.toHaveBeenCalled();
		expect(mockRunInBackground).not.toHaveBeenCalled();
	});

	it("defensive: confirmed but null email sends nothing", async () => {
		mockConfirmByToken.mockResolvedValue({
			confirmed: true,
			email: null,
			projectId: "fabric-main",
		});
		const res = await confirm({
			input: { token: "tok-no-email-0" },
			context: ctx,
		});
		expect(res).toEqual({ confirmed: true });
		expect(mockSendEmail).not.toHaveBeenCalled();
		expect(mockRunInBackground).not.toHaveBeenCalled();
	});
});
