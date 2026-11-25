import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { APIError } from "better-auth/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authOptions } from "../../auth";
import { invitationOnlyPlugin } from "../../plugins/invitation-only";

const mocks = vi.hoisted(() => ({
	db: { user: { update: vi.fn() }, session: { updateMany: vi.fn() } },
	getUserByEmail: vi.fn(),
	getPendingInvitationByEmail: vi.fn(),
	getPendingProjectInvitationByEmail: vi.fn(),
	getInvitationById: vi.fn(),
	resolveUserOrganization: vi.fn(),
	reconcile: vi.fn(),
	ensureOrganization: vi.fn(),
	verifyCaptcha: vi.fn(),
	checkLogin: vi.fn(),
	notifySignupAttempt: vi.fn(),
	seats: vi.fn(),
	deleteSessionCookie: vi.fn(),
	lockout: vi.fn(),
	requireGrant: vi.fn(),
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/database", async () => ({
	...(await import("../../../database/prisma/queries/oauth-token-format")),
	db: mocks.db,
	getUserByEmail: mocks.getUserByEmail,
	getOperatorOrganizationId: () => null,
	getPendingInvitationByEmail: mocks.getPendingInvitationByEmail,
	getPendingProjectInvitationByEmail:
		mocks.getPendingProjectInvitationByEmail,
	getInvitationById: mocks.getInvitationById,
	resolveUserOrganization: mocks.resolveUserOrganization,
	recordAudit: vi.fn(),
}));
vi.mock("@repo/mail", () => ({ sendEmail: vi.fn() }));
vi.mock("@repo/payments", () => ({ cancelSubscription: vi.fn() }));
vi.mock("@repo/config", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/config")>();
	return {
		...actual,
		config: {
			...actual.config,
			auth: { ...actual.config.auth, enableSignup: false },
		},
	};
});
vi.mock("@repo/logs", async (importOriginal) => ({
	...(await importOriginal<typeof import("@repo/logs")>()),
	logger: mocks.logger,
}));
vi.mock("../invite-reconciliation", () => ({
	runInviteReconciliationForUser: mocks.reconcile,
}));
vi.mock("../ensure-user-organization", () => ({
	ensureUserHasOrganization: mocks.ensureOrganization,
}));
vi.mock("../turnstile", () => ({ verifyTurnstileToken: mocks.verifyCaptcha }));
vi.mock("../brute-force", () => ({ checkLoginAllowed: mocks.checkLogin }));
vi.mock("../notify-signup-attempt", () => ({
	notifySignupAttempt: mocks.notifySignupAttempt,
}));
vi.mock("../organization", () => ({
	updateSeatsInOrganizationSubscription: mocks.seats,
}));
vi.mock("../audit-events", () => ({ emitAuthAuditEvent: vi.fn() }));
vi.mock("../two-factor-step-up-lockout", () => ({
	createPrismaStepUpLockoutStore: vi.fn(),
	enforceStepUpLockout: mocks.lockout,
	recordStepUpVerificationOutcome: vi.fn(),
}));
vi.mock("../two-factor-management-step-up", () => ({
	createPrismaStepUpGrantStore: vi.fn(),
	requireStepUpGrant: mocks.requireGrant,
	recordStepUpGrantOutcome: vi.fn(),
}));
vi.mock("better-auth/cookies", async (importOriginal) => ({
	...(await importOriginal<typeof import("better-auth/cookies")>()),
	deleteSessionCookie: mocks.deleteSessionCookie,
}));

const user = {
	id: "example-user",
	email: "dev@example.com",
	name: "Example User",
};
const organizationId = "example-org";
const origin = new URL(authOptions.baseURL).origin;

function runHook<Result>(
	hook: (input: never) => Promise<Result>,
	input: { path: string; body?: unknown; query?: unknown; context: object },
) {
	return hook(input as never);
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.getUserByEmail.mockResolvedValue(null);
	mocks.verifyCaptcha.mockResolvedValue({ success: true });
	mocks.checkLogin.mockResolvedValue({ allowed: true });
});

describe("signup and invitation gates", () => {
	it("lets the endpoint handle a duplicate signup and notifies the existing account", async () => {
		mocks.getUserByEmail.mockResolvedValue(user);
		await runHook(authOptions.hooks.before, {
			path: "/sign-up/email",
			body: { email: user.email, captchaToken: "example-captcha" },
			context: {},
		});
		expect(mocks.notifySignupAttempt).toHaveBeenCalledExactlyOnceWith(
			user.email,
		);
		expect(mocks.verifyCaptcha).toHaveBeenCalledExactlyOnceWith(
			"example-captcha",
			"unknown",
		);
	});

	it("refuses email sign-in when CAPTCHA fails before consulting the login budget", async () => {
		mocks.verifyCaptcha.mockResolvedValue({ success: false });
		await expect(
			runHook(authOptions.hooks.before, {
				path: "/sign-in/email",
				body: { email: user.email },
				context: {},
			}),
		).rejects.toMatchObject({
			status: "BAD_REQUEST",
			body: { body: { code: "CAPTCHA_FAILED" } },
		});
		expect(mocks.checkLogin).not.toHaveBeenCalled();
	});

	it("refuses email sign-in for a locked account even after CAPTCHA passes", async () => {
		mocks.checkLogin.mockResolvedValue({
			allowed: false,
			lockedUntil: new Date("2026-01-01T00:00:00Z"),
			retryAfterSeconds: 60,
		});
		await expect(
			runHook(authOptions.hooks.before, {
				path: "/sign-in/email",
				body: { email: user.email },
				context: {},
			}),
		).rejects.toMatchObject({
			status: "FORBIDDEN",
			body: { body: { code: "ACCOUNT_LOCKED", retryAfterSeconds: 60 } },
		});
	});

	it("refuses a non-text email before CAPTCHA", async () => {
		await expect(
			runHook(authOptions.hooks.before, {
				path: "/sign-in/email",
				body: { email: 42 },
				context: {},
			}),
		).rejects.toMatchObject({ status: "BAD_REQUEST" });
		expect(mocks.verifyCaptcha).not.toHaveBeenCalled();
		expect(mocks.checkLogin).not.toHaveBeenCalled();
	});

	it("refuses a weak new password before the password change endpoint", async () => {
		await expect(
			runHook(authOptions.hooks.before, {
				path: "/change-password",
				body: { newPassword: "short" },
				context: {},
			}),
		).rejects.toMatchObject({
			status: "BAD_REQUEST",
			body: { body: { code: "PASSWORD_TOO_WEAK" } },
		});
	});

	it("leaves absent email validation to the endpoint after CAPTCHA", async () => {
		await expect(
			runHook(authOptions.hooks.before, {
				path: "/sign-in/email",
				body: {},
				context: {},
			}),
		).resolves.toBeUndefined();
		expect(mocks.verifyCaptcha).toHaveBeenCalledOnce();
	});

	it("ignores an unrelated email field outside the protected paths", async () => {
		await expect(
			runHook(authOptions.hooks.before, {
				path: "/update-user",
				body: { email: 42 },
				context: {},
			}),
		).resolves.toBeUndefined();
		expect(mocks.verifyCaptcha).not.toHaveBeenCalled();
	});

	it.each([
		{ email: "DEV@example.com", captcha: false },
		{ email: "other@example.com", captcha: true },
	])(
		"checks CAPTCHA for a logged-in reset to $email only when required",
		async ({ email, captcha }) => {
			await runHook(authOptions.hooks.before, {
				path: "/request-password-reset",
				body: { email },
				context: { session: { user } },
			});
			expect(mocks.verifyCaptcha).toHaveBeenCalledTimes(Number(captcha));
		},
	);

	it("refuses new invite-only signup and admits a pending project invite", async () => {
		const [hook] = invitationOnlyPlugin().hooks.before;
		if (!hook) {
			throw new Error("Missing invitation middleware");
		}
		const request = {
			path: "/sign-up/email",
			body: { email: " DEV@example.com " },
			context: {},
		};
		expect(
			hook.matcher(request as Parameters<typeof hook.matcher>[0]),
		).toBe(true);
		await expect(runHook(hook.handler, request)).rejects.toMatchObject({
			body: { code: "INVALID_INVITATION" },
		});
		mocks.getPendingProjectInvitationByEmail.mockResolvedValue({
			id: "example-invite",
		});
		await expect(runHook(hook.handler, request)).resolves.toBeUndefined();
		expect(
			mocks.getPendingProjectInvitationByEmail,
		).toHaveBeenLastCalledWith(user.email);
	});

	it("refuses raw organization deletion before billing or membership can be changed", async () => {
		await expect(
			runHook(authOptions.hooks.before, {
				path: "/organization/delete",
				body: { organizationId },
				context: {},
			}),
		).rejects.toMatchObject({ status: "FORBIDDEN" });
	});

	it("skips seat synchronization when invitation acceptance was refused", async () => {
		mocks.getInvitationById.mockResolvedValue({ organizationId });
		await runHook(authOptions.hooks.after, {
			path: "/organization/accept-invitation",
			body: { invitationId: "example-invite" },
			context: { returned: new APIError("FORBIDDEN") },
		});
		expect(mocks.seats).not.toHaveBeenCalled();
	});

	it("synchronizes seats after accepting an invitation", async () => {
		mocks.getInvitationById.mockResolvedValue({ organizationId });
		await runHook(authOptions.hooks.after, {
			path: "/organization/accept-invitation",
			body: { invitationId: "example-invite" },
			context: {
				returned: {
					invitation: { organizationId },
					member: { userId: user.id, organizationId },
				},
			},
		});
		expect(mocks.seats).toHaveBeenCalledExactlyOnceWith(organizationId);
	});
});

describe("session and password hooks", () => {
	const session = {
		id: "example-session",
		userId: user.id,
		token: "example-token",
		createdAt: new Date(),
		updatedAt: new Date(),
		expiresAt: new Date(),
	};
	const lifetime = authOptions.databaseHooks.session.create;

	it("sets an unambiguous organization on the session before it is written", async () => {
		mocks.resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId,
		});
		await expect(lifetime.before(session)).resolves.toEqual({
			data: { activeOrganizationId: organizationId },
		});
	});

	it("leaves ambiguous organization choice unset", async () => {
		mocks.resolveUserOrganization.mockResolvedValue({ kind: "ambiguous" });
		await expect(lifetime.before(session)).resolves.toBeUndefined();
	});

	it("reconciles invitations before provisioning or resolving the organization", async () => {
		mocks.resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId,
		});
		await lifetime.after(session);
		expect(mocks.reconcile).toHaveBeenCalledExactlyOnceWith({
			userId: user.id,
			trigger: "session_create",
		});
		expect(mocks.reconcile).toHaveBeenCalledBefore(
			mocks.ensureOrganization,
		);
		expect(mocks.ensureOrganization).toHaveBeenCalledBefore(
			mocks.resolveUserOrganization,
		);
	});

	it("seeds the impersonated user's session without granting memberships", async () => {
		mocks.resolveUserOrganization.mockResolvedValue({
			kind: "resolved",
			organizationId,
		});
		await lifetime.after({ ...session, impersonatedBy: "example-admin" });
		expect(mocks.resolveUserOrganization).toHaveBeenCalledExactlyOnceWith(
			user.id,
		);
		expect(mocks.reconcile).not.toHaveBeenCalled();
		expect(mocks.ensureOrganization).not.toHaveBeenCalled();
	});

	it.each([
		{
			name: "a failed password change",
			returned: new APIError("BAD_REQUEST", { code: "INVALID_PASSWORD" }),
			write: false,
		},
		{
			name: "a successful password change",
			returned: { token: null, user },
			write: true,
		},
	])(
		"clears the mandatory change flag only after success ($name)",
		async ({ returned, write }) => {
			await runHook(authOptions.hooks.after, {
				path: "/change-password",
				context: {
					returned,
					session: { user: { ...user, mustChangePassword: true } },
				},
			});
			if (write) {
				expect(mocks.db.user.update).toHaveBeenCalledExactlyOnceWith({
					where: { id: user.id },
					data: { mustChangePassword: false },
				});
			} else {
				expect(mocks.db.user.update).not.toHaveBeenCalled();
			}
		},
	);

	it("preserves the server-owned password flag during a profile update", async () => {
		const data: Record<string, Record<string, unknown>[]> = {
			user: [],
			session: [],
			account: [],
			verification: [],
		};
		const auth = betterAuth({
			baseURL: origin,
			secret: "example-memory-adapter-auth-secret-value",
			database: memoryAdapter(data),
			emailAndPassword: { enabled: true },
			user: authOptions.user,
		});
		const headers = new Headers();
		const signIn = await auth.api.signUpEmail({
			body: {
				name: "Example Profile",
				email: "profile@example.com",
				password: "Example-password-123!",
			},
			returnHeaders: true,
		});
		const profile = data.user?.find(
			(row) => row.id === signIn.response.user.id,
		);
		if (!profile) {
			throw new Error("Missing signed-in profile");
		}
		profile.mustChangePassword = true;
		headers.set(
			"cookie",
			signIn.headers
				.getSetCookie()
				.map((cookie) => cookie.split(";")[0])
				.join("; "),
		);
		const profileUpdate = {
			name: "Updated Example",
			mustChangePassword: false,
		};
		await auth.api.updateUser({ headers, body: profileUpdate });
		expect(data.user?.find((row) => row.id === profile.id)).toMatchObject({
			name: "Updated Example",
			mustChangePassword: true,
		});
	});
});

describe("account linking", () => {
	it.each([false, true])(
		"links a provider account to an existing verified user only if provider email verification is %s",
		async (emailVerified) => {
			const existing = {
				...user,
				emailVerified: true,
				createdAt: new Date(),
				updatedAt: new Date(),
			};
			const data: Record<string, Record<string, unknown>[]> = {
				user: [existing],
				session: [],
				account: [],
				verification: [],
			};
			const auth = betterAuth({
				baseURL: origin,
				secret: "example-memory-adapter-auth-secret-value",
				database: memoryAdapter(data),
				account: authOptions.account,
				socialProviders: {
					google: {
						clientId: "example-client",
						clientSecret: "example-secret",
						verifyIdToken: async () => true,
						getUserInfo: async () => ({
							user: {
								name: user.name,
								email: user.email,
								emailVerified,
							},
							data: {
								aud: "example-client",
								azp: "example-client",
								email: user.email,
								email_verified: emailVerified,
								exp: 2,
								family_name: "User",
								given_name: "Example",
								iat: 1,
								iss: "https://example.com",
								name: user.name,
								picture: "https://example.com/avatar.png",
								sub: "example-provider-account",
							},
						}),
					},
				},
			});
			const result = auth.api.signInSocial({
				body: {
					provider: "google",
					idToken: { token: "example-provider-token" },
				},
			});
			if (emailVerified) {
				await expect(result).resolves.toMatchObject({
					user: { id: existing.id },
				});
				expect(data.account).toEqual([
					expect.objectContaining({
						providerId: "google",
						userId: existing.id,
					}),
				]);
			} else {
				await expect(result).rejects.toMatchObject({
					body: { message: "account not linked" },
				});
				expect(data.account).toEqual([]);
				expect(data.session).toEqual([]);
			}
		},
	);
});

describe("step-up and fresh-session 2FA", () => {
	it.each([
		{
			name: "lockout",
			check: mocks.lockout,
			path: "/two-factor/verify-totp",
		},
		{
			name: "management grant",
			check: mocks.requireGrant,
			path: "/two-factor/disable",
		},
	])("propagates a refusal from the $name check", async ({ check, path }) => {
		const refusal = new APIError("FORBIDDEN");
		check.mockRejectedValue(refusal);
		await expect(
			runHook(authOptions.hooks.before, { path, context: {} }),
		).rejects.toBe(refusal);
	});

	function mint() {
		const newSession = {
			user: { ...user, twoFactorEnabled: true },
			session: { token: "example-session-token" },
		};
		const context = {
			newSession,
			setNewSession: vi.fn(),
			internalAdapter: {
				deleteSession: vi.fn(),
				createVerificationValue: vi.fn(),
			},
			createAuthCookie: vi.fn(() => ({
				name: "example-two-factor",
				attributes: {},
			})),
			secret: "example-cookie-secret",
		};
		return { context, newSession };
	}

	it("revokes a fresh 2FA session before persisting the challenge and requesting a code", async () => {
		const { context } = mint();
		const result = await runHook(authOptions.hooks.after, {
			path: "/example-sign-in",
			context,
		});
		expect(result).toEqual({ twoFactorRedirect: true });
		expect(mocks.deleteSessionCookie).toHaveBeenCalledBefore(
			context.internalAdapter.deleteSession,
		);
		expect(context.setNewSession).toHaveBeenCalledExactlyOnceWith(null);
		expect(
			context.internalAdapter.deleteSession,
		).toHaveBeenCalledExactlyOnceWith("example-session-token");
		expect(context.internalAdapter.deleteSession).toHaveBeenCalledBefore(
			context.internalAdapter.createVerificationValue,
		);
		expect(
			context.internalAdapter.createVerificationValue,
		).toHaveBeenCalledTimes(2);
	});

	it("leaves a cookie refresh for the same 2FA session untouched", async () => {
		const { context, newSession } = mint();
		await runHook(authOptions.hooks.after, {
			path: "/example-refresh",
			context: { ...context, session: newSession },
		});
		expect(mocks.deleteSessionCookie).not.toHaveBeenCalled();
		expect(context.internalAdapter.deleteSession).not.toHaveBeenCalled();
	});

	it.each([
		{
			callbackURL: "/app/example?tab=history",
			target: "/app/example?tab=history",
		},
		{ callbackURL: "https://other.example.com/path", target: null },
	])(
		"allows only a local post-challenge target for $callbackURL",
		async ({ callbackURL, target }) => {
			const { context } = mint();
			const verifyUrl = new URL("/auth/verify", origin);
			if (target) {
				verifyUrl.searchParams.set("redirectTo", target);
			}
			const response = runHook(authOptions.hooks.after, {
				path: "/callback/example",
				query: { callbackURL },
				context,
			});
			await expect(response).rejects.toMatchObject({
				status: "FOUND",
				headers: expect.anything(),
			});
			expect(context.internalAdapter.deleteSession).toHaveBeenCalledTimes(
				1,
			);
			// Better Call exposes the redirect through the thrown API error's headers.
			const error = await response.catch((error: APIError) => error);
			expect(
				new Headers((error as APIError).headers).get("location"),
			).toBe(verifyUrl.href);
		},
	);

	it("keeps a fresh session cleared when challenge storage fails", async () => {
		const { context } = mint();
		context.internalAdapter.createVerificationValue.mockRejectedValue(
			new Error("example storage failure"),
		);
		await expect(
			runHook(authOptions.hooks.after, {
				path: "/example-sign-in",
				context,
			}),
		).rejects.toMatchObject({
			body: { code: "TWO_FACTOR_CHALLENGE_FAILED" },
		});
		expect(context.setNewSession).toHaveBeenCalledBefore(
			context.internalAdapter.createVerificationValue,
		);
		expect(mocks.deleteSessionCookie).toHaveBeenCalledTimes(2);
	});
});
