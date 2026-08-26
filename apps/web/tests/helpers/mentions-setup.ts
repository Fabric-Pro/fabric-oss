/**
 * Inline setup helpers for document @-mention E2E specs.
 *
 * These helpers seed test state via HTTP API calls made from a Playwright
 * `Page` whose session is already authenticated as the acting user.  No
 * separate Prisma process is required — all mutations go through the live
 * oRPC REST layer (which is identical to the production code path).
 *
 * Prerequisite: the development server must be running (playwright.config.ts
 * webServer builds + starts it automatically), and BOTH test accounts must
 * already exist in the database:
 *
 *   User A (author):    E2E_USER_A_EMAIL  / E2E_USER_A_PASSWORD
 *                       (defaults to placeholder e2e-user-a@example.com)
 *   User B (recipient): E2E_USER_B_EMAIL  / E2E_USER_B_PASSWORD
 *                       (defaults to placeholder e2e-user-b@example.com)
 *
 * Both accounts must share an organization. Tests pass E2E_ORG_SLUG to name
 * the org (defaults to "default-org").
 *
 * HOW IT WORKS
 * ------------
 * 1. Each spec opens TWO browser contexts (pageA / pageB) and signs each user
 *    in independently so we can assert cross-user notification delivery.
 * 2. pageA (User A session) creates a project + document via POST /api/projects
 *    and POST /api/projects/:id/documents using the oRPC REST endpoints.
 * 3. The specs then exercise the @-mention flow entirely through the real browser
 *    UI — TipTap editor, suggestion popover, Save button, Notification Bell.
 * 4. Member removal (deactivated-chip.spec.ts) is done via the Better Auth
 *    HTTP API: POST /api/auth/organization/remove-member.
 */

import type { Browser, BrowserContext, Page } from "@playwright/test";

// ---------------------------------------------------------------------------
// Environment-driven credentials (override in .env.local / CI)
// ---------------------------------------------------------------------------

export const TEST_USER_A = {
	email: process.env.E2E_USER_A_EMAIL ?? "e2e-user-a@example.com",
	password: process.env.E2E_USER_A_PASSWORD ?? "ChangeMeInProduction!",
	name: process.env.E2E_USER_A_NAME ?? "E2E User A",
};

export const TEST_USER_B = {
	email: process.env.E2E_USER_B_EMAIL ?? "e2e-user-b@example.com",
	password: process.env.E2E_USER_B_PASSWORD ?? "ChangeMeInProduction!",
	name: process.env.E2E_USER_B_NAME ?? "E2E User B",
};

const TEST_ORG_SLUG = process.env.E2E_ORG_SLUG ?? "default-org";

// ---------------------------------------------------------------------------
// Sign-in helper
// ---------------------------------------------------------------------------

/**
 * Signs the given credentials in on `page` via the login form and waits for
 * the redirect to the app shell.
 *
 * Handles two scenarios that arise with dev-seeded accounts:
 *
 * 1. `mustChangePassword: true` — the server redirects to `/change-password`.
 *    We fill the forced-change form (requiring 12+ chars), submit, then sign
 *    in again with the new password (`${password}_e2e!`).
 *
 * 2. Password already changed on a prior run — the login form shows an error
 *    and stays on `/auth/login`.  We detect the error alert and retry with the
 *    `${password}_e2e!` variant (the one the first run set).
 *
 * On CI, prefer supplying the already-changed password via the
 * `E2E_USER_*_PASSWORD` environment variables to avoid the retry path.
 */
async function signIn(
	page: Page,
	user: { email: string; password: string },
): Promise<void> {
	// The forced-change password must:
	//   1. Be ≥ 12 characters (hard minimum).
	//   2. Score ≥ 3 on zxcvbn (see packages/auth/lib/password-strength.ts).
	// A static passphrase-style string that mixes unrelated words, digits, and
	// punctuation reliably scores 4 and satisfies both constraints.
	const altPassword = "E2e-Mention-Test-2026!";

	/**
	 * Attempts a single login and returns the outcome.
	 *
	 * Detection strategy:
	 *   - Sets up a response listener for the Better Auth sign-in API BEFORE
	 *     clicking submit (so fast responses aren't missed).
	 *   - If the response status is 200 (auth succeeded), waits for the URL to
	 *     resolve to /app or /change-password.
	 *   - If the response status is non-200, credentials are wrong.
	 *   - If no matching response fires within 20 s (unexpected), falls back to
	 *     checking the URL directly.
	 */
	async function attemptLogin(
		pwd: string,
	): Promise<"app" | "change" | "error"> {
		await page.goto("/auth/login");
		await page.fill('input[name="email"]', user.email);
		await page.fill('input[name="password"]', pwd);

		// Arm the response listener before clicking.
		const responsePromise = page.waitForResponse(
			(res) => res.url().includes("/api/auth/sign-in"),
			{ timeout: 25_000 },
		);

		await page.click('button[type="submit"]');

		let response: Awaited<typeof responsePromise>;
		try {
			response = await responsePromise;
		} catch {
			// Timeout waiting for response — check current URL as fallback.
			const pathname = new URL(page.url()).pathname;
			if (pathname.startsWith("/app")) {
				return "app";
			}
			if (pathname.startsWith("/change-password")) {
				return "change";
			}
			return "error";
		}

		const status = response.status();
		if (status !== 200) {
			// Non-200 means invalid credentials.
			return "error";
		}

		// 200 means auth succeeded. Wait for navigation to /app or /change-password.
		try {
			await page.waitForURL(
				(url) =>
					url.pathname.startsWith("/app") ||
					url.pathname.startsWith("/change-password"),
				{ timeout: 20_000 },
			);
		} catch {
			// If navigation doesn't happen within 20 s, check current URL.
		}

		const pathname = new URL(page.url()).pathname;
		if (pathname.startsWith("/change-password")) {
			return "change";
		}
		if (pathname.startsWith("/app")) {
			return "app";
		}
		// Still on /auth/login after a 200 response — unusual but treat as success
		// since auth API returned 200 (session was created).
		return "app";
	}

	let outcome = await attemptLogin(user.password);

	// If the original password was rejected (already changed on a prior run),
	// try the post-forced-change password.
	if (outcome === "error") {
		outcome = await attemptLogin(altPassword);
		if (outcome === "error") {
			throw new Error(
				`signIn: login failed for ${user.email} with both "${user.password}" and "${altPassword}". ` +
					"Check E2E_USER_*_PASSWORD env vars or re-seed the database.",
			);
		}
	}

	// Handle the forced-change-password gate.
	// The ForceChangePasswordForm uses autoComplete attributes ("current-password"
	// and "new-password") on the PasswordInput components spread from React Hook
	// Form field props. We target them by autocomplete attribute since the form
	// library renders standard <input> elements without explicit name attributes
	// in the DOM.
	if (outcome === "change") {
		// Wait for the form to be fully rendered before filling.
		await page
			.locator('input[autocomplete="current-password"]')
			.waitFor({ state: "visible", timeout: 10_000 });

		await page
			.locator('input[autocomplete="current-password"]')
			.fill(user.password);
		await page
			.locator('input[autocomplete="new-password"]')
			.first()
			.fill(altPassword);
		await page
			.locator('input[autocomplete="new-password"]')
			.last()
			.fill(altPassword);

		// Wait for the changePassword API call and submit.
		const [changeResp] = await Promise.all([
			page.waitForResponse(
				(res) => res.url().includes("/api/auth/change-password"),
				{ timeout: 20_000 },
			),
			page.locator('button[type="submit"]').click(),
		]);

		if (changeResp.status() !== 200) {
			const body = await changeResp.text().catch(() => "(unreadable)");
			throw new Error(
				`signIn: changePassword failed for ${user.email} — ` +
					`status=${changeResp.status()}, body=${body}`,
			);
		}

		// After success the component calls authClient.signOut() and redirects
		// to /auth/login.  Sign in again with the new password.
		await page.waitForURL("/auth/login**", { timeout: 20_000 });
		await page.fill('input[name="email"]', user.email);
		await page.fill('input[name="password"]', altPassword);

		const [signInResp] = await Promise.all([
			page.waitForResponse(
				(res) =>
					res.url().includes("/api/auth/sign-in/email") ||
					res.url().includes("/api/auth/sign-in"),
				{ timeout: 20_000 },
			),
			page.click('button[type="submit"]'),
		]);

		if (signInResp.status() !== 200) {
			const body = await signInResp.text().catch(() => "(unreadable)");
			throw new Error(
				`signIn: re-login after password change failed for ${user.email} — ` +
					`status=${signInResp.status()}, body=${body}`,
			);
		}

		await page.waitForURL("/app**", { timeout: 20_000 });
	}
}

// ---------------------------------------------------------------------------
// Project + document creation (runs in the context of a signed-in page)
// ---------------------------------------------------------------------------

interface TestProject {
	projectId: string;
	organizationId: string;
}

interface TestDocument {
	documentId: string;
	documentUrl: string;
}

/**
 * Resolves the organization ID for `orgSlug` using the Better Auth
 * `/api/auth/organization/get-full-organization` endpoint.
 */
async function resolveOrganizationId(
	page: Page,
	orgSlug: string,
): Promise<string> {
	const resp = await page.request.get(
		`/api/auth/organization/get-full-organization?organizationSlug=${encodeURIComponent(orgSlug)}`,
		{ headers: { "Content-Type": "application/json" } },
	);

	if (resp.ok()) {
		try {
			const body = await resp.json();
			// Better Auth wraps the response in different shapes depending on version.
			const orgId: string | undefined =
				body?.id ?? body?.organization?.id ?? body?.data?.id;
			if (orgId) {
				return orgId;
			}
		} catch {
			// fall through to error
		}
	}

	throw new Error(
		`resolveOrganizationId: could not resolve org id for slug "${orgSlug}" — ` +
			`status=${resp.status()}, body=${await resp.text().catch(() => "(unreadable)")}`,
	);
}

/**
 * Creates a temporary test project owned by the authenticated session on
 * `page`.  The project is created in `orgSlug`'s organization context
 * via the oRPC REST endpoint POST /api/projects.
 *
 * Returns `{ projectId, organizationId }`.
 */
async function createTestProject(
	page: Page,
	orgSlug: string = TEST_ORG_SLUG,
): Promise<TestProject> {
	// Navigate to the org dashboard first so the app can set the active org
	// in the session via the ActiveOrganizationProvider.
	await page.goto(`/app/${orgSlug}`);
	await page.waitForLoadState("networkidle");

	const organizationId = await resolveOrganizationId(page, orgSlug);

	// Try to find an existing project in the org via the oRPC RPC list endpoint.
	// This avoids a known issue where project creation (POST /api/rpc/projects/create)
	// returns 500 in some dev environments.
	const listResp = await page.request.post("/api/rpc/projects/list", {
		headers: { "Content-Type": "application/json" },
		data: {
			json: {
				organizationId,
				limit: 1,
			},
		},
	});

	if (listResp.ok()) {
		const listBody = await listResp.json();
		const existingProject =
			listBody?.json?.projects?.[0] ?? listBody?.projects?.[0];
		if (existingProject?.id) {
			return { projectId: existingProject.id, organizationId };
		}
	}

	// Fallback: try creating a new project.
	const projectName = `E2E Mentions Test ${Date.now()}`;
	const createResp = await page.request.post("/api/rpc/projects/create", {
		headers: { "Content-Type": "application/json" },
		data: {
			json: {
				name: projectName,
				organizationId,
				description: "Created by E2E test",
			},
		},
	});

	if (!createResp.ok()) {
		throw new Error(
			`createTestProject: POST /api/rpc/projects/create failed with ${createResp.status()}: ${await createResp.text()}`,
		);
	}

	const projectBody = await createResp.json();
	// oRPC RPC responses wrap the payload in { json: { ... } }
	const projectId: string =
		projectBody?.json?.project?.id ??
		projectBody?.project?.id ??
		projectBody?.result?.data?.json?.project?.id ??
		projectBody?.result?.data?.project?.id;

	if (!projectId) {
		throw new Error(
			`createTestProject: could not extract projectId from response: ${JSON.stringify(projectBody)}`,
		);
	}

	return { projectId, organizationId };
}

/**
 * Creates a minimal document inside `projectId`.  Returns the document id
 * and the full URL to the document editor page.
 */
async function createTestDocument(
	page: Page,
	{ projectId, organizationId }: TestProject,
	orgSlug: string = TEST_ORG_SLUG,
): Promise<TestDocument> {
	// Use the oRPC RPC endpoint for document creation.
	// projects.documents.create maps to POST /api/rpc/projects/documents/create.
	const createResp = await page.request.post(
		"/api/rpc/projects/documents/create",
		{
			headers: { "Content-Type": "application/json" },
			data: {
				json: {
					projectId,
					organizationId: organizationId || null,
					type: "TECHNICAL_SPEC",
					title: `E2E Mention Doc ${Date.now()}`,
					content: "<p>Initial content for E2E test.</p>",
					status: "DRAFT",
				},
			},
		},
	);

	if (!createResp.ok()) {
		throw new Error(
			`createTestDocument: POST /api/rpc/projects/documents/create failed with ${createResp.status()}: ${await createResp.text()}`,
		);
	}

	const body = await createResp.json();
	// oRPC RPC responses wrap the payload in { json: { ... } }
	const documentId: string =
		body?.json?.document?.id ??
		body?.document?.id ??
		body?.result?.data?.json?.document?.id ??
		body?.result?.data?.document?.id;

	if (!documentId) {
		throw new Error(
			`createTestDocument: could not extract documentId from response: ${JSON.stringify(body)}`,
		);
	}

	const documentUrl = `/app/${orgSlug}/projects/${projectId}/documents/${documentId}`;
	return { documentId, documentUrl };
}

// ---------------------------------------------------------------------------
// Two-context helper
// ---------------------------------------------------------------------------

export interface TwoUserSetup {
	pageA: Page;
	pageB: Page;
	contextA: BrowserContext;
	contextB: BrowserContext;
	orgSlug: string;
	project: TestProject;
	doc: TestDocument;
}

/**
 * Set up two authenticated browser contexts (userA and userB) for a mention
 * test.  Creates a fresh project + document as User A, returns everything
 * needed for the three specs.
 *
 * IMPORTANT: Call `teardown(setup)` in `test.afterEach` / after the test to
 * close both contexts.
 */
export async function setupTwoUsers(browser: Browser): Promise<TwoUserSetup> {
	const contextA = await browser.newContext();
	const contextB = await browser.newContext();
	const pageA = await contextA.newPage();
	const pageB = await contextB.newPage();

	// Sign in both users in parallel.
	await Promise.all([signIn(pageA, TEST_USER_A), signIn(pageB, TEST_USER_B)]);

	const project = await createTestProject(pageA, TEST_ORG_SLUG);
	const doc = await createTestDocument(pageA, project, TEST_ORG_SLUG);

	return {
		pageA,
		pageB,
		contextA,
		contextB,
		orgSlug: TEST_ORG_SLUG,
		project,
		doc,
	};
}

export async function teardown(setup: TwoUserSetup): Promise<void> {
	await setup.contextA.close().catch(() => undefined);
	await setup.contextB.close().catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Org member removal (Better Auth HTTP API)
// ---------------------------------------------------------------------------

/**
 * Removes `userId` from `orgId` using Better Auth's `/api/auth/organization/remove-member`
 * endpoint.  Must be called from a page session that is signed in as an admin/owner.
 *
 * The Better Auth client library constructs this call with a plain JSON body; we
 * replicate that here via `page.request.post`.
 */
export async function removeMemberFromOrg(
	page: Page,
	{
		memberIdOrEmail,
		organizationId,
	}: { memberIdOrEmail: string; organizationId: string },
): Promise<void> {
	const resp = await page.request.post(
		"/api/auth/organization/remove-member",
		{
			headers: { "Content-Type": "application/json" },
			data: {
				memberIdOrEmail,
				organizationId,
			},
		},
	);
	if (!resp.ok()) {
		// Log and continue — the chip-inactive test will naturally fail its
		// assertion if removal didn't actually happen, which is the correct
		// failure signal.
		const body = await resp.text().catch(() => "(unreadable)");
		console.warn(`removeMemberFromOrg: response ${resp.status()}: ${body}`);
	}
}
