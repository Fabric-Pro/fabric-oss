/**
 * Unit tests for `emitAuthAuditEvent`.
 *
 * Exercises every branch in the Better Auth hook -> audit-action mapping
 * the audit taxonomy declares:
 *   /sign-in/email (success)        -> auth.login.success
 *   /sign-in/email (failure)        -> auth.login.failure (known + unknown user)
 *   /sign-out                       -> auth.logout
 *   /change-password                -> auth.password.changed
 *   /reset-password                 -> auth.password.changed
 *   /two-factor/verify-totp         -> auth.mfa.enabled (enrollment only)
 *   /two-factor/disable             -> auth.mfa.disabled (successful calls only)
 *   /admin/impersonate-user         -> auth.impersonation.started
 *   /admin/stop-impersonating       -> auth.impersonation.ended
 *
 * Run with: pnpm --filter @repo/auth test lib/__tests__/audit-events.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	recordAuditMock: vi.fn(),
	loggerWarnMock: vi.fn(),
	getTrustedClientIpFromRequestMock: vi.fn((_request: Request) => "unknown"),
}));

vi.mock("@repo/database", () => ({
	recordAudit: mocks.recordAuditMock,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: mocks.loggerWarnMock,
		error: vi.fn(),
		log: vi.fn(),
	},
}));

vi.mock("../client-ip", () => ({
	getTrustedClientIpFromRequest: (request: Request) =>
		mocks.getTrustedClientIpFromRequestMock(request),
}));

import { APIError } from "better-auth/api";
import { emitAuthAuditEvent, extractAuthRequestContext } from "../audit-events";
import { enforceStepUpLockout } from "../two-factor-step-up-lockout";

beforeEach(() => {
	mocks.recordAuditMock.mockReset();
	mocks.loggerWarnMock.mockReset();
	mocks.getTrustedClientIpFromRequestMock.mockReset();
	mocks.getTrustedClientIpFromRequestMock.mockReturnValue("unknown");
});

const getUserByEmail = vi.fn();

describe("extractAuthRequestContext", () => {
	it("returns nulls when ctx has no request", () => {
		expect(extractAuthRequestContext({})).toEqual({
			ipAddress: null,
			userAgent: null,
			requestId: null,
		});
	});

	it("pulls IP / UA / requestId from the request when available", () => {
		mocks.getTrustedClientIpFromRequestMock.mockReturnValue("203.0.113.42");
		const headers = new Headers({
			"user-agent": "vitest/test",
			"x-request-id": "req-abc",
		});
		const ctx = { request: new Request("https://x/y", { headers }) };
		expect(extractAuthRequestContext(ctx)).toEqual({
			ipAddress: "203.0.113.42",
			userAgent: "vitest/test",
			requestId: "req-abc",
		});
	});

	it("falls back to x-correlation-id when x-request-id is absent", () => {
		mocks.getTrustedClientIpFromRequestMock.mockReturnValue("");
		const headers = new Headers({ "x-correlation-id": "corr-xyz" });
		const ctx = { request: new Request("https://x/y", { headers }) };
		const result = extractAuthRequestContext(ctx);
		expect(result.requestId).toBe("corr-xyz");
		// Empty string returned from getTrustedClientIpFromRequest
		// degenerates to null (no `unknown` either).
		expect(result.ipAddress).toBe(null);
	});

	it("treats 'unknown' as null for ipAddress", () => {
		mocks.getTrustedClientIpFromRequestMock.mockReturnValue("unknown");
		const ctx = { request: new Request("https://x/y") };
		expect(extractAuthRequestContext(ctx).ipAddress).toBe(null);
	});
});

describe("emitAuthAuditEvent — /sign-in/email", () => {
	it("emits auth.login.success when a new session was issued", async () => {
		const ctx = {
			path: "/sign-in/email",
			body: { email: "alice@example.com" },
			context: {
				newSession: {
					session: { id: "sess-1" },
					user: {
						id: "user-1",
						email: "alice@example.com",
						name: "Alice",
					},
				},
			},
		};

		await emitAuthAuditEvent(ctx, { getUserByEmail });

		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		const payload = mocks.recordAuditMock.mock.calls[0][0];
		expect(payload).toMatchObject({
			action: "auth.login.success",
			category: "auth",
			outcome: "success",
			actor: {
				type: "user",
				userId: "user-1",
				emailSnapshot: "alice@example.com",
				nameSnapshot: "Alice",
			},
			resource: {
				type: "user",
				id: "user-1",
				name: "alice@example.com",
			},
			sessionId: "sess-1",
		});
	});

	it("emits auth.login.failure with userId from the known-user lookup", async () => {
		getUserByEmail.mockResolvedValue({
			id: "user-2",
			email: "bob@example.com",
			name: "Bob",
		});

		const ctx = {
			path: "/sign-in/email",
			body: { email: "bob@example.com" },
			context: { newSession: null },
		};

		await emitAuthAuditEvent(ctx, { getUserByEmail });

		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		const payload = mocks.recordAuditMock.mock.calls[0][0];
		expect(payload.action).toBe("auth.login.failure");
		expect(payload.outcome).toBe("failure");
		expect(payload.severity).toBe("warning");
		expect(payload.actor.userId).toBe("user-2");
		expect(payload.metadata.attemptedEmail).toBe("bob@example.com");
	});

	it("emits auth.login.failure with system actor when the email is not a known user", async () => {
		getUserByEmail.mockResolvedValue(null);

		const ctx = {
			path: "/sign-in/email",
			body: { email: "ghost@example.com" },
			context: { newSession: null },
		};

		await emitAuthAuditEvent(ctx, { getUserByEmail });

		const payload = mocks.recordAuditMock.mock.calls[0][0];
		expect(payload.actor.type).toBe("system");
		// resource.id is null when no user matched; resource.name carries the
		// attempted email so the failure is still traceable.
		expect(payload.resource).toMatchObject({
			type: "user",
			id: null,
			name: "ghost@example.com",
		});
	});

	it("captures authMethod on auth.login.success metadata (item 7)", async () => {
		const ctx = {
			path: "/sign-in/email",
			context: {
				newSession: {
					session: { id: "sess-am" },
					user: {
						id: "user-am",
						email: "alice@example.com",
						name: "Alice",
					},
				},
			},
		};
		await emitAuthAuditEvent(ctx, { getUserByEmail });
		const payload = mocks.recordAuditMock.mock.calls[0][0];
		expect(payload.metadata).toMatchObject({
			method: "password",
			authMethod: "password",
		});
	});
});

describe("emitAuthAuditEvent — /sign-out", () => {
	it("emits auth.logout with the session user", async () => {
		const ctx = {
			path: "/sign-out",
			context: {
				session: {
					session: { id: "sess-1" },
					user: {
						id: "user-1",
						email: "alice@example.com",
						name: "Alice",
					},
				},
			},
		};

		await emitAuthAuditEvent(ctx, { getUserByEmail });

		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "auth.logout",
			actor: { type: "user", userId: "user-1" },
			sessionId: "sess-1",
		});
	});

	it("skips emission when there is no session user", async () => {
		await emitAuthAuditEvent(
			{ path: "/sign-out", context: { session: null } },
			{ getUserByEmail },
		);
		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});
});

describe("emitAuthAuditEvent — password change paths", () => {
	it.each([
		["/change-password", "in-app"],
		["/reset-password", "reset"],
	])("emits auth.password.changed for %s with via=%s", async (path, via) => {
		const ctx = {
			path,
			context: {
				session: {
					session: { id: "sess-1" },
					user: { id: "user-1", email: "a@b.c", name: "A" },
				},
			},
		};

		await emitAuthAuditEvent(ctx, { getUserByEmail });

		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "auth.password.changed",
			metadata: { via },
		});
	});
});

describe("emitAuthAuditEvent — MFA toggle paths", () => {
	const SUCCESS_RESPONSE = { token: "tok", user: { id: "user-1" } };

	/**
	 * Stage the `two_factor` pre-state the emitter reads, by driving the REAL
	 * hook that writes it (`enforceStepUpLockout`) rather than reaching into its
	 * private carrier. The mark lives in a WeakMap keyed on `ctx.context`, so the
	 * SAME object has to be handed to both calls — spreading it into a fresh
	 * object silently loses the mark and would make these tests pass for the
	 * wrong reason.
	 *
	 * `context.session` is pre-seeded, which is what `resolveSessionOrThrow`
	 * memoizes onto, so no session lookup is attempted.
	 */
	async function stagePreState(
		context: Record<string, unknown>,
		verified: boolean,
	) {
		const row = {
			id: "two-factor-row",
			stepUpFailedCount: 0,
			stepUpLockedUntil: null,
			stepUpEpoch: 0,
			verified,
		};
		await enforceStepUpLockout(
			{ path: "/two-factor/verify-totp", context } as never,
			{
				store: {
					findRowByUserId: async () => row,
					incrementFailure: async () => ({ count: 1, epoch: 0 }),
					clearExpiredLock: async () => {},
					restoreReservation: async () => {},
					lockConditionally: async () => false,
					resetOnSuccess: async () => {},
				},
			},
		);
	}

	it("emits auth.mfa.enabled on the verify-totp that COMPLETES enrollment (row was unverified before the call)", async () => {
		const context: Record<string, unknown> = {
			session: {
				session: { id: "sess-1" },
				user: { id: "user-1", email: "a@b.c", name: "A" },
			},
			// Enrollment rotates the session, so a genuine enrollment carries a
			// newSession too — which is why the pre-state, not this, is what
			// separates it from a 2FA-gated login.
			newSession: {
				session: { id: "sess-2" },
				user: { id: "user-1", email: "a@b.c", name: "A" },
			},
			returned: SUCCESS_RESPONSE,
		};
		await stagePreState(context, false);

		await emitAuthAuditEvent(
			{ path: "/two-factor/verify-totp", context } as never,
			{ getUserByEmail },
		);

		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "auth.mfa.enabled",
			metadata: { method: "totp" },
		});
	});

	it("emits NOTHING for a STEP-UP verify-totp against an already-active factor", async () => {
		// The regression this guards: before #2827 this branch emitted
		// `auth.mfa.enabled`, so every disable, secret rotation and backup-code
		// regeneration would have been preceded by a phantom "MFA enabled" row.
		const context: Record<string, unknown> = {
			session: {
				session: { id: "sess-1" },
				user: { id: "user-1", email: "a@b.c", name: "A" },
			},
			returned: SUCCESS_RESPONSE,
		};
		await stagePreState(context, true);

		await emitAuthAuditEvent(
			{ path: "/two-factor/verify-totp", context } as never,
			{ getUserByEmail },
		);

		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("emits NOTHING when an enrollment-shaped verify-totp actually FAILED", async () => {
		const context: Record<string, unknown> = {
			session: {
				session: { id: "sess-1" },
				user: { id: "user-1", email: "a@b.c", name: "A" },
			},
			returned: new APIError("UNAUTHORIZED", {
				message: "Invalid code",
				code: "INVALID_CODE",
			}),
		};
		await stagePreState(context, false);

		await emitAuthAuditEvent(
			{ path: "/two-factor/verify-totp", context } as never,
			{ getUserByEmail },
		);

		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("emits auth.login.success (NOT mfa.enabled) on verify-totp that COMPLETES a 2FA login (new session)", async () => {
		const ctx = {
			path: "/two-factor/verify-totp",
			context: {
				newSession: {
					session: { id: "sess-2" },
					user: { id: "user-1", email: "a@b.c", name: "A" },
				},
			},
		};

		await emitAuthAuditEvent(ctx, { getUserByEmail });

		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "auth.login.success",
			outcome: "success",
			metadata: { method: "2fa_totp", authMethod: "2fa_totp" },
			sessionId: "sess-2",
		});
	});

	it("emits auth.mfa.disabled when disabling 2FA", async () => {
		const ctx = {
			path: "/two-factor/disable",
			context: {
				session: {
					session: { id: "sess-1" },
					user: { id: "user-1", email: "a@b.c", name: "A" },
				},
			},
		};

		await emitAuthAuditEvent(ctx, { getUserByEmail });

		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "auth.mfa.disabled",
			metadata: { method: "totp" },
		});
	});

	it.each([
		[
			"a wrong password",
			new APIError("BAD_REQUEST", {
				message: "Invalid password",
				code: "INVALID_PASSWORD",
			}),
		],
		[
			"a missing step-up grant",
			new APIError("FORBIDDEN", {
				message: "Verify again",
				code: "STEP_UP_REQUIRED",
			}),
		],
	])(
		"emits NOTHING when the disable call was rejected for %s",
		async (_label, returned) => {
			// Better Auth runs hooks.after even when the endpoint threw, so
			// without the outcome check this recorded a removal of the second
			// factor that never happened.
			const ctx = {
				path: "/two-factor/disable",
				context: {
					session: {
						session: { id: "sess-1" },
						user: { id: "user-1", email: "a@b.c", name: "A" },
					},
					returned,
				},
			};

			await emitAuthAuditEvent(ctx, { getUserByEmail });

			expect(mocks.recordAuditMock).not.toHaveBeenCalled();
		},
	);
});

describe("emitAuthAuditEvent — non-password login methods (H6)", () => {
	it.each([
		["/sign-in/passkey", "passkey"],
		["/magic-link/verify", "magic_link"],
		["/callback/google", "oauth"],
		["/oauth2/callback/github", "oauth"],
		["/two-factor/verify-backup-code", "2fa_backup"],
	])("emits auth.login.success for %s (method %s)", async (path, method) => {
		const ctx = {
			path,
			context: {
				newSession: {
					session: { id: "sess-x" },
					user: { id: "user-1", email: "a@b.c", name: "A" },
				},
			},
		};
		await emitAuthAuditEvent(ctx, { getUserByEmail });
		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "auth.login.success",
			outcome: "success",
			metadata: { method, authMethod: method },
			sessionId: "sess-x",
		});
	});

	it("does not emit for a non-password sign-in path with no new session", async () => {
		await emitAuthAuditEvent(
			{ path: "/sign-in/passkey", context: { newSession: null } },
			{ getUserByEmail },
		);
		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});
});

describe("emitAuthAuditEvent — suppresses premature auth.login.success on 2FA challenge paths", () => {
	// auth.ts's own 2FA-enforcement hook runs later in the same `hooks.after`
	// callback. These three paths have no trust-device exception (unlike
	// Better Auth's own /sign-in/email gate), so a `twoFactorEnabled`
	// session never survives them as an authenticated one: the hook either
	// completes revoke-and-challenge, or fails closed by stripping the
	// browser credential and nulling `newSession`. Either way, emitting
	// here would record a login that never actually completes.
	it.each([
		["/magic-link/verify"],
		["/callback/google"],
		["/oauth2/callback/github"],
	])(
		"emits no auth.login.success for a twoFactorEnabled user on %s",
		async (path) => {
			const ctx = {
				path,
				context: {
					newSession: {
						session: { id: "sess-2fa" },
						user: {
							id: "user-1",
							email: "a@b.c",
							name: "A",
							twoFactorEnabled: true,
						},
					},
				},
			};
			await emitAuthAuditEvent(ctx, { getUserByEmail });
			expect(mocks.recordAuditMock).not.toHaveBeenCalled();
		},
	);

	it.each([["/magic-link/verify"], ["/callback/google"]])(
		"still emits auth.login.success for a non-2FA user on %s",
		async (path) => {
			const ctx = {
				path,
				context: {
					newSession: {
						session: { id: "sess-no-2fa" },
						user: {
							id: "user-1",
							email: "a@b.c",
							name: "A",
							twoFactorEnabled: false,
						},
					},
				},
			};
			await emitAuthAuditEvent(ctx, { getUserByEmail });
			expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
			expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
				action: "auth.login.success",
			});
		},
	);

	it("suppresses for a twoFactorEnabled user on /sign-in/passkey, which the gate would challenge", async () => {
		// This branch is dead in production — `@better-auth/passkey`
		// registers `/passkey/verify-authentication`, and THAT path is
		// exempt (policy #2802: a user-verified passkey is the second
		// factor). `/sign-in/passkey` is not exempt, so under the
		// deny-by-default gate (issue #2825) a mint on it would be
		// revoked and challenged — and an `auth.login.success` row for a
		// login that never completes is exactly what this suppression
		// exists to prevent. The prediction follows the gate rather than a
		// second, hand-maintained path list.
		const ctx = {
			path: "/sign-in/passkey",
			context: {
				newSession: {
					session: { id: "sess-passkey" },
					user: {
						id: "user-1",
						email: "a@b.c",
						name: "A",
						twoFactorEnabled: true,
					},
				},
			},
		};
		await emitAuthAuditEvent(ctx, { getUserByEmail });
		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("still emits when the session was refreshed rather than minted, since the gate leaves those alone", async () => {
		// The path is only half the prediction — the discriminator is the
		// other half. An equal token means the caller already held this
		// session, so nothing is challenged and the row is real.
		const ctx = {
			path: "/magic-link/verify",
			context: {
				session: { session: { token: "prior" } },
				newSession: {
					session: { id: "sess-refresh", token: "prior" },
					user: {
						id: "user-1",
						email: "a@b.c",
						name: "A",
						twoFactorEnabled: true,
					},
				},
			},
		};
		await emitAuthAuditEvent(ctx, { getUserByEmail });
		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "auth.login.success",
		});
	});

	it("still emits for a twoFactorEnabled user on /two-factor/verify-backup-code (the challenge completion itself)", async () => {
		const ctx = {
			path: "/two-factor/verify-backup-code",
			context: {
				newSession: {
					session: { id: "sess-backup" },
					user: {
						id: "user-1",
						email: "a@b.c",
						name: "A",
						twoFactorEnabled: true,
					},
				},
			},
		};
		await emitAuthAuditEvent(ctx, { getUserByEmail });
		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "auth.login.success",
		});
	});

	it("still emits for a twoFactorEnabled user on /sign-in/email (documented known gap — see audit-events.ts)", async () => {
		const ctx = {
			path: "/sign-in/email",
			context: {
				newSession: {
					session: { id: "sess-email-2fa" },
					user: {
						id: "user-1",
						email: "a@b.c",
						name: "A",
						twoFactorEnabled: true,
					},
				},
			},
		};
		await emitAuthAuditEvent(ctx, { getUserByEmail });
		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "auth.login.success",
		});
	});
});

describe("emitAuthAuditEvent — impersonation paths", () => {
	it("emits auth.impersonation.started with severity=warning and impersonatedById", async () => {
		const ctx = {
			path: "/admin/impersonate-user",
			body: { userId: "target-user" },
			context: {
				session: {
					session: { id: "sess-1" },
					user: { id: "admin-1", email: "admin@x.y", name: "Admin" },
				},
			},
		};

		await emitAuthAuditEvent(ctx, { getUserByEmail });

		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "auth.impersonation.started",
			severity: "warning",
			actor: {
				type: "user",
				userId: "admin-1",
				impersonatedById: "admin-1",
			},
			resource: { type: "user", id: "target-user" },
			metadata: { targetUserId: "target-user" },
		});
	});

	it("emits auth.impersonation.ended", async () => {
		const ctx = {
			path: "/admin/stop-impersonating",
			context: {
				session: {
					session: { id: "sess-1" },
					user: { id: "admin-1", email: "admin@x.y", name: "Admin" },
				},
			},
		};

		await emitAuthAuditEvent(ctx, { getUserByEmail });

		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "auth.impersonation.ended",
			actor: { type: "user", userId: "admin-1" },
		});
	});
});

describe("emitAuthAuditEvent — unrelated paths", () => {
	it("does not emit anything for a non-audit path", async () => {
		await emitAuthAuditEvent(
			{ path: "/get-session", context: { session: null } },
			{ getUserByEmail },
		);
		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("does not emit anything for /verify-email when no session was minted", async () => {
		await emitAuthAuditEvent(
			{ path: "/verify-email", context: { session: null } },
			{ getUserByEmail },
		);
		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	// `/verify-email` session-mint semantics (issue #2826): a fresh mint for
	// a non-2FA user (autoSignInAfterVerification) is a real, durable login
	// and must produce an auth.login.success row. Two suppressions remain
	// pinned here: a `twoFactorEnabled` user's mint is revoked moments later
	// by the 2FA gate in the same hook (the completing event is the later
	// /two-factor/verify-* row), and a cookie refresh for an already-signed-in
	// user completing an email change (same session token in and out) is not
	// a login at all.
	it("emits nothing for a /verify-email session mint when the user has 2FA enabled", async () => {
		await emitAuthAuditEvent(
			{
				path: "/verify-email",
				context: {
					session: null,
					newSession: {
						session: {
							id: "sess-verify-email",
							token: "tok-fresh",
						},
						user: {
							id: "user-verify-email",
							email: "user@example.com",
							name: "User",
							twoFactorEnabled: true,
						},
					},
				},
			},
			{ getUserByEmail },
		);
		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("emits auth.login.success for a /verify-email fresh session mint for a non-2FA user", async () => {
		await emitAuthAuditEvent(
			{
				path: "/verify-email",
				context: {
					session: null,
					newSession: {
						session: {
							id: "sess-verify-email",
							token: "tok-fresh",
						},
						user: {
							id: "user-verify-email",
							email: "user@example.com",
							name: "User",
							twoFactorEnabled: false,
						},
					},
				},
			},
			{ getUserByEmail },
		);
		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "auth.login.success",
			outcome: "success",
			actor: {
				type: "user",
				userId: "user-verify-email",
				emailSnapshot: "user@example.com",
			},
			resource: { type: "user", id: "user-verify-email" },
			metadata: {
				method: "email_verification",
				authMethod: "email_verification",
			},
			sessionId: "sess-verify-email",
		});
	});

	it("emits auth.login.success for a /verify-email mint that replaces an existing session", async () => {
		// Signed in as one account, verifying another: an incoming session is
		// present but the endpoint mints a *different* session (token differs),
		// so this is a real login, not a cookie refresh.
		await emitAuthAuditEvent(
			{
				path: "/verify-email",
				context: {
					session: {
						session: { id: "sess-old", token: "tok-old" },
						user: {
							id: "user-other",
							email: "other@example.com",
							name: "Other",
							twoFactorEnabled: false,
						},
					},
					newSession: {
						session: {
							id: "sess-verify-email",
							token: "tok-fresh",
						},
						user: {
							id: "user-verify-email",
							email: "user@example.com",
							name: "User",
							twoFactorEnabled: false,
						},
					},
				},
			},
			{ getUserByEmail },
		);
		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditMock.mock.calls[0][0]).toMatchObject({
			action: "auth.login.success",
			actor: { type: "user", userId: "user-verify-email" },
			sessionId: "sess-verify-email",
		});
	});

	it("emits nothing for a /verify-email cookie refresh of an existing session", async () => {
		// An already-signed-in user completing an email change: Better Auth's
		// setSessionCookie repopulates `newSession` with the incoming session,
		// so the tokens match — this is not a login.
		await emitAuthAuditEvent(
			{
				path: "/verify-email",
				context: {
					session: {
						session: { id: "sess-existing", token: "tok-same" },
						user: {
							id: "user-verify-email",
							email: "user@example.com",
							name: "User",
							twoFactorEnabled: false,
						},
					},
					newSession: {
						session: { id: "sess-existing", token: "tok-same" },
						user: {
							id: "user-verify-email",
							email: "user@example.com",
							name: "User",
							twoFactorEnabled: false,
						},
					},
				},
			},
			{ getUserByEmail },
		);
		expect(mocks.recordAuditMock).not.toHaveBeenCalled();
	});

	it("never throws, even when the lookup helper rejects", async () => {
		getUserByEmail.mockRejectedValue(new Error("DB down"));
		// failure branch with a known-email path triggers the user lookup
		await expect(
			emitAuthAuditEvent(
				{
					path: "/sign-in/email",
					body: { email: "x@y.z" },
					context: { newSession: null },
				},
				{ getUserByEmail },
			),
		).resolves.toBeUndefined();
		// And a failure row still gets written (with system actor).
		expect(mocks.recordAuditMock).toHaveBeenCalledTimes(1);
		expect(mocks.recordAuditMock.mock.calls[0][0].actor.type).toBe(
			"system",
		);
	});
});
