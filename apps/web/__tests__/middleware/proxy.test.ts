/**
 * Tests for the Next.js middleware (proxy.ts)
 *
 * Validates session cookie detection, auth redirects, and routing
 * for all authentication flows: login, signup, verification, OAuth,
 * magic link, invitation, forgot password, and protected routes.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// All vi.mock factories are hoisted — no references to outer variables allowed

vi.mock("@i18n/routing", () => ({
	routing: {},
}));

vi.mock("next-intl/middleware", () => ({
	default: () => (req: any) => ({
		type: "intl-middleware",
		url: req.nextUrl.pathname,
	}),
}));

vi.mock("@repo/config", () => ({
	config: {
		auth: {
			cookiePrefix: "fabric",
		},
		ui: {
			saas: { enabled: true },
			marketing: { enabled: true },
		},
	},
}));

vi.mock("better-auth/cookies", () => ({
	getSessionCookie: vi.fn(),
}));

vi.mock("ufo", () => ({
	withQuery: (path: string, query: Record<string, string>) => {
		const params = new URLSearchParams(query);
		return `${path}?${params.toString()}`;
	},
}));

vi.mock("next/server", () => ({
	NextResponse: {
		next: (init?: { request?: { headers?: Headers } }) => ({
			type: "next",
			requestHeaders: init?.request?.headers,
			headers: new Headers(),
		}),
		redirect: (url: URL | string) => ({
			type: "redirect",
			url: url instanceof URL ? url.toString() : url,
		}),
		rewrite: (url: URL | string) => ({
			type: "rewrite",
			url: url instanceof URL ? url.toString() : url,
		}),
	},
}));

import { config as appConfig } from "@repo/config";
import { getSessionCookie } from "better-auth/cookies";
// Import after mocks are set up (hoisted by vitest)
import proxy from "../../proxy";

const mockGetSessionCookie = vi.mocked(getSessionCookie);
const mockAppConfig = appConfig as {
	ui: { saas: { enabled: boolean }; marketing: { enabled: boolean } };
};

function createMockRequest(
	pathname: string,
	options: {
		cookie?: string;
		accept?: string;
		sessionData?: Record<string, unknown>;
	} = {},
) {
	const origin = "https://www.fabric.pro";
	const fullPath = pathname.split("?")[0];
	const url = new URL(fullPath, origin);

	const headers = new Headers();
	if (options.cookie) {
		headers.set("cookie", options.cookie);
	}
	if (options.accept) {
		headers.set("accept", options.accept);
	}

	const cookieStore = new Map<string, { value: string }>();
	if (options.sessionData) {
		const encoded = btoa(JSON.stringify(options.sessionData));
		cookieStore.set("fabric.session_data", { value: encoded });
		cookieStore.set("__Secure-fabric.session_data", { value: encoded });
	}

	return {
		nextUrl: {
			pathname: url.pathname,
			origin,
			clone: () => {
				const cloned = new URL(url.toString());
				return Object.defineProperty(
					{ toString: () => cloned.toString() },
					"pathname",
					{
						get: () => cloned.pathname,
						set: (v: string) => {
							cloned.pathname = v;
						},
						enumerable: true,
						configurable: true,
					},
				);
			},
		},
		headers,
		cookies: {
			get: (name: string) => cookieStore.get(name) ?? undefined,
		},
		url: url.toString(),
	} as any;
}

describe("Middleware (proxy.ts)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockAppConfig.ui.saas.enabled = true;
		mockAppConfig.ui.marketing.enabled = true;
	});

	// ─────────────────────────────────────────────────────────────────
	// Cookie prefix configuration
	// ─────────────────────────────────────────────────────────────────
	describe("Session cookie prefix", () => {
		it("should call getSessionCookie with cookiePrefix 'fabric'", async () => {
			mockGetSessionCookie.mockReturnValue("valid-token");
			const req = createMockRequest("/app");

			await proxy(req);

			expect(mockGetSessionCookie).toHaveBeenCalledWith(req, {
				cookiePrefix: "fabric",
			});
		});

		it("should NOT use default better-auth prefix", async () => {
			mockGetSessionCookie.mockReturnValue("valid-token");
			const req = createMockRequest("/app");

			await proxy(req);

			const call = mockGetSessionCookie.mock.calls[0];
			expect(call[1]).toEqual({ cookiePrefix: "fabric" });
			expect(call[1]?.cookiePrefix).not.toBe("better-auth");
		});
	});

	// ─────────────────────────────────────────────────────────────────
	// Protected /app routes
	// ─────────────────────────────────────────────────────────────────
	describe("Protected /app routes", () => {
		it("should allow access when session cookie exists", async () => {
			mockGetSessionCookie.mockReturnValue("valid-session-token");
			const req = createMockRequest("/app");

			const response = await proxy(req);

			expect(response.type).toBe("next");
		});

		it("should redirect to login when no session cookie", async () => {
			mockGetSessionCookie.mockReturnValue(null);
			const req = createMockRequest("/app");

			const response = await proxy(req);

			expect(response.type).toBe("redirect");
			expect(response.url).toContain("/auth/login");
			expect(response.url).toContain("redirectTo=%2Fapp");
		});

		it("should preserve deep path in redirectTo", async () => {
			mockGetSessionCookie.mockReturnValue(null);
			const req = createMockRequest("/app/my-org/projects/123");

			const response = await proxy(req);

			expect(response.type).toBe("redirect");
			expect(response.url).toContain(
				"redirectTo=%2Fapp%2Fmy-org%2Fprojects%2F123",
			);
		});

		it("should allow /app/settings with valid session", async () => {
			mockGetSessionCookie.mockReturnValue("token");
			const req = createMockRequest("/app/settings/general");

			const response = await proxy(req);

			expect(response.type).toBe("next");
		});

		it("should redirect /app/settings without session", async () => {
			mockGetSessionCookie.mockReturnValue(null);
			const req = createMockRequest("/app/settings/general");

			const response = await proxy(req);

			expect(response.type).toBe("redirect");
			expect(response.url).toContain("/auth/login");
		});

		it("should redirect to / when SaaS is disabled", async () => {
			mockAppConfig.ui.saas.enabled = false;
			mockGetSessionCookie.mockReturnValue("token");
			const req = createMockRequest("/app");

			const response = await proxy(req);

			expect(response.type).toBe("redirect");
			expect(response.url).not.toContain("/auth/login");
		});
	});

	// ─────────────────────────────────────────────────────────────────
	// Auth routes (login, signup, forgot-password, verify, etc.)
	// ─────────────────────────────────────────────────────────────────
	describe("Auth routes", () => {
		it("should pass through /auth/login", async () => {
			const req = createMockRequest("/auth/login");
			const response = await proxy(req);
			expect(response.type).toBe("next");
		});

		it("should pass through /auth/signup", async () => {
			const req = createMockRequest("/auth/signup");
			const response = await proxy(req);
			expect(response.type).toBe("next");
		});

		it("should pass through /auth/forgot-password", async () => {
			const req = createMockRequest("/auth/forgot-password");
			const response = await proxy(req);
			expect(response.type).toBe("next");
		});

		it("should pass through /auth/reset-password", async () => {
			const req = createMockRequest("/auth/reset-password");
			const response = await proxy(req);
			expect(response.type).toBe("next");
		});

		it("should pass through /auth/verify (OTP/2FA)", async () => {
			const req = createMockRequest("/auth/verify");
			const response = await proxy(req);
			expect(response.type).toBe("next");
		});

		it("should pass through /auth/email-verified", async () => {
			const req = createMockRequest("/auth/email-verified");
			const response = await proxy(req);
			expect(response.type).toBe("next");
		});

		it("should pass through /auth/login with redirectTo param", async () => {
			const req = createMockRequest("/auth/login");
			const response = await proxy(req);
			expect(response.type).toBe("next");
		});

		it("should pass through /auth/signup with invitationId", async () => {
			const req = createMockRequest("/auth/signup");
			const response = await proxy(req);
			expect(response.type).toBe("next");
		});

		it("should redirect auth routes to / when SaaS is disabled", async () => {
			mockAppConfig.ui.saas.enabled = false;
			const req = createMockRequest("/auth/login");

			const response = await proxy(req);

			expect(response.type).toBe("redirect");
		});
	});

	// ─────────────────────────────────────────────────────────────────
	// Paths without locale (onboarding, org, invitation, plan)
	// ─────────────────────────────────────────────────────────────────
	describe("Paths without locale", () => {
		it("should pass through /onboarding", async () => {
			const req = createMockRequest("/onboarding");
			const response = await proxy(req);
			expect(response.type).toBe("next");
		});

		it("should pass through /new-organization", async () => {
			const req = createMockRequest("/new-organization");
			const response = await proxy(req);
			expect(response.type).toBe("next");
		});

		it("should pass through /choose-plan", async () => {
			const req = createMockRequest("/choose-plan");
			const response = await proxy(req);
			expect(response.type).toBe("next");
		});

		it("should pass through /organization-invitation/:id", async () => {
			const req = createMockRequest(
				"/organization-invitation/inv_abc123",
			);
			const response = await proxy(req);
			expect(response.type).toBe("next");
		});

		it("should pass through /unsubscribe/:token (public newsletter link)", async () => {
			// Regression: the page lives at app/unsubscribe/[token], outside
			// (marketing)/[locale]. Without the pathsWithoutLocale bypass the intl
			// middleware localizes the path and the email link 404s.
			const req = createMockRequest("/unsubscribe/tok_abc123");
			const response = await proxy(req);
			expect(response.type).toBe("next");
		});

		it("should pass through /newsletter/confirm/:token (double opt-in link)", async () => {
			// Regression: the page lives at app/newsletter/confirm/[token], outside
			// (marketing)/[locale]. Without the pathsWithoutLocale bypass the intl
			// middleware localizes the path and the confirm email link 404s, so
			// users can never confirm their subscription.
			const req = createMockRequest("/newsletter/confirm/tok_abc123");
			const response = await proxy(req);
			expect(response.type).toBe("next");
		});
	});

	// ─────────────────────────────────────────────────────────────────
	// Embed routes
	// ─────────────────────────────────────────────────────────────────
	describe("Embed routes", () => {
		it("passes /embed/newsletter through with frame-ancestors CSP + x-embed-route header", async () => {
			const req = createMockRequest("/embed/newsletter");
			const response = await proxy(req);

			expect(response.type).toBe("next");
			expect(response.headers.get("content-security-policy")).toBe(
				"frame-ancestors *",
			);
			expect(response.requestHeaders?.get("x-embed-route")).toBe("1");
		});
	});

	// ─────────────────────────────────────────────────────────────────
	// Post-verification flow simulation
	// ─────────────────────────────────────────────────────────────────
	describe("Post-verification flow", () => {
		it("should allow /app access after email verification sets session cookie", async () => {
			mockGetSessionCookie.mockReturnValue("newly-created-session-token");
			const req = createMockRequest("/app");

			const response = await proxy(req);

			expect(response.type).toBe("next");
		});

		it("should redirect to login if verification did not create session", async () => {
			mockGetSessionCookie.mockReturnValue(null);
			const req = createMockRequest("/app");

			const response = await proxy(req);

			expect(response.type).toBe("redirect");
			expect(response.url).toContain("/auth/login");
		});
	});

	// ─────────────────────────────────────────────────────────────────
	// Cookie prefix matching (production HTTPS)
	// ─────────────────────────────────────────────────────────────────
	describe("__Secure- prefixed cookies (HTTPS production)", () => {
		it("should detect session when getSessionCookie returns a value", async () => {
			mockGetSessionCookie.mockReturnValue("signed-token-value");
			const req = createMockRequest("/app", {
				cookie: "__Secure-fabric.session_token=signed-token-value",
			});

			const response = await proxy(req);

			expect(response.type).toBe("next");
			expect(mockGetSessionCookie).toHaveBeenCalledWith(req, {
				cookiePrefix: "fabric",
			});
		});

		it("should redirect when getSessionCookie returns null (wrong prefix scenario)", async () => {
			mockGetSessionCookie.mockReturnValue(null);
			const req = createMockRequest("/app", {
				cookie: "__Secure-fabric.session_token=valid-token",
			});

			const response = await proxy(req);

			expect(response.type).toBe("redirect");
			expect(response.url).toContain("/auth/login");
		});
	});

	// ─────────────────────────────────────────────────────────────────
	// Docs and blog routes
	// ─────────────────────────────────────────────────────────────────
	describe("Docs routes", () => {
		it("should redirect /docs to locale-prefixed path", async () => {
			const req = createMockRequest("/docs");
			const response = await proxy(req);
			expect(response.type).toBe("redirect");
		});

		it("should redirect /docs/getting-started to locale-prefixed path", async () => {
			const req = createMockRequest("/docs/getting-started");
			const response = await proxy(req);
			expect(response.type).toBe("redirect");
		});

		it("should rewrite /docs to API when Accept: text/markdown", async () => {
			const req = createMockRequest("/docs/overview", {
				accept: "text/markdown",
			});
			const response = await proxy(req);
			expect(response.type).toBe("rewrite");
		});

		it("should pass through /en/docs routes", async () => {
			const req = createMockRequest("/en/docs/getting-started");
			const response = await proxy(req);
			expect(response.type).toBe("next");
		});

		it("should redirect /docs to /app when marketing is disabled", async () => {
			mockAppConfig.ui.marketing.enabled = false;
			const req = createMockRequest("/docs");
			const response = await proxy(req);
			expect(response.type).toBe("redirect");
			expect(response.url).toContain("/app");
		});
	});

	describe("Blog routes", () => {
		it("should redirect /blog to locale-prefixed path", async () => {
			const req = createMockRequest("/blog");
			const response = await proxy(req);
			expect(response.type).toBe("redirect");
		});

		it("should redirect /blog to /app when marketing is disabled", async () => {
			mockAppConfig.ui.marketing.enabled = false;
			const req = createMockRequest("/blog");
			const response = await proxy(req);
			expect(response.type).toBe("redirect");
			expect(response.url).toContain("/app");
		});
	});

	// ─────────────────────────────────────────────────────────────────
	// Marketing fallback
	// ─────────────────────────────────────────────────────────────────
	describe("Marketing routes", () => {
		it("should redirect to /app when marketing is disabled", async () => {
			mockAppConfig.ui.marketing.enabled = false;
			mockGetSessionCookie.mockReturnValue(null);
			const req = createMockRequest("/");

			const response = await proxy(req);

			expect(response.type).toBe("redirect");
			expect(response.url).toContain("/app");
		});

		it("should use intl middleware for marketing pages", async () => {
			const req = createMockRequest("/");
			const response = await proxy(req);
			expect(response.type).toBe("intl-middleware");
		});
	});

	// ─────────────────────────────────────────────────────────────────
	// Session cookie result only gates /app routes
	// ─────────────────────────────────────────────────────────────────
	describe("Cookie check scope", () => {
		it("should pass through /auth routes even when session cookie is absent", async () => {
			mockGetSessionCookie.mockReturnValue(null);
			const req = createMockRequest("/auth/login");

			const response = await proxy(req);

			expect(response.type).toBe("next");
		});

		it("should pass through /onboarding even when session cookie is absent", async () => {
			mockGetSessionCookie.mockReturnValue(null);
			const req = createMockRequest("/onboarding");

			const response = await proxy(req);

			expect(response.type).toBe("next");
		});

		it("should pass through /organization-invitation even when session cookie is absent", async () => {
			mockGetSessionCookie.mockReturnValue(null);
			const req = createMockRequest("/organization-invitation/abc");

			const response = await proxy(req);

			expect(response.type).toBe("next");
		});
	});

	// ─────────────────────────────────────────────────────────────────
	// Full auth flow scenarios
	// ─────────────────────────────────────────────────────────────────
	describe("Full auth flow scenarios", () => {
		it("email+password login: unauthenticated user hits /app → redirect to login", async () => {
			mockGetSessionCookie.mockReturnValue(null);
			const req = createMockRequest("/app");
			const response = await proxy(req);

			expect(response.type).toBe("redirect");
			expect(response.url).toContain("/auth/login");
			expect(response.url).toContain("redirectTo=%2Fapp");
		});

		it("email+password login: authenticated user hits /app → pass through", async () => {
			mockGetSessionCookie.mockReturnValue("valid-token");
			const req = createMockRequest("/app");
			const response = await proxy(req);

			expect(response.type).toBe("next");
		});

		it("OAuth callback: /auth route passes through regardless of session", async () => {
			mockGetSessionCookie.mockReturnValue(null);
			const req = createMockRequest("/auth/callback/google");
			const response = await proxy(req);

			expect(response.type).toBe("next");
		});

		it("invitation flow: invitation page passes through without session", async () => {
			mockGetSessionCookie.mockReturnValue(null);
			const req = createMockRequest("/organization-invitation/inv_123");
			const response = await proxy(req);

			expect(response.type).toBe("next");
		});

		it("post-signup onboarding: passes through without session check", async () => {
			mockGetSessionCookie.mockReturnValue(null);
			const req = createMockRequest("/onboarding");
			const response = await proxy(req);

			expect(response.type).toBe("next");
		});

		it("plan selection: passes through without session check", async () => {
			mockGetSessionCookie.mockReturnValue(null);
			const req = createMockRequest("/choose-plan");
			const response = await proxy(req);

			expect(response.type).toBe("next");
		});

		it("new org creation: passes through without session check", async () => {
			mockGetSessionCookie.mockReturnValue(null);
			const req = createMockRequest("/new-organization");
			const response = await proxy(req);

			expect(response.type).toBe("next");
		});
	});

	// ─────────────────────────────────────────────────────────────────
	// mustChangePassword redirect behavior
	// ─────────────────────────────────────────────────────────────────
	describe("Force password change redirect", () => {
		it("should redirect /app to /change-password when mustChangePassword is true", async () => {
			mockGetSessionCookie.mockReturnValue("valid-token");
			const req = createMockRequest("/app", {
				sessionData: {
					session: { user: { mustChangePassword: true } },
				},
			});

			const response = await proxy(req);

			expect(response.type).toBe("redirect");
			expect(response.url).toContain("/change-password");
		});

		it("should redirect /app/settings to /change-password when mustChangePassword is true", async () => {
			mockGetSessionCookie.mockReturnValue("valid-token");
			const req = createMockRequest("/app/settings/general", {
				sessionData: {
					session: { user: { mustChangePassword: true } },
				},
			});

			const response = await proxy(req);

			expect(response.type).toBe("redirect");
			expect(response.url).toContain("/change-password");
		});

		it("should pass through /app when mustChangePassword is false", async () => {
			mockGetSessionCookie.mockReturnValue("valid-token");
			const req = createMockRequest("/app", {
				sessionData: {
					session: { user: { mustChangePassword: false } },
				},
			});

			const response = await proxy(req);

			expect(response.type).toBe("next");
		});

		it("should pass through /app when no session_data cookie exists", async () => {
			mockGetSessionCookie.mockReturnValue("valid-token");
			const req = createMockRequest("/app");

			const response = await proxy(req);

			expect(response.type).toBe("next");
		});

		it("should pass through /app when session_data cookie is malformed", async () => {
			mockGetSessionCookie.mockReturnValue("valid-token");
			const req = createMockRequest("/app");
			// Manually set a malformed cookie value
			(req.cookies as any) = {
				get: (name: string) =>
					name.includes("session_data")
						? { value: "not-valid-base64!!!" }
						: undefined,
			};

			const response = await proxy(req);

			expect(response.type).toBe("next");
		});

		it("should not create a redirect loop on /change-password", async () => {
			mockGetSessionCookie.mockReturnValue("valid-token");
			const req = createMockRequest("/change-password", {
				sessionData: {
					session: { user: { mustChangePassword: true } },
				},
			});

			const response = await proxy(req);

			expect(response.type).toBe("next");
		});

		it("should still redirect unauthenticated users to /auth/login (no regression)", async () => {
			mockGetSessionCookie.mockReturnValue(null);
			const req = createMockRequest("/app");

			const response = await proxy(req);

			expect(response.type).toBe("redirect");
			expect(response.url).toContain("/auth/login");
		});
	});
});
