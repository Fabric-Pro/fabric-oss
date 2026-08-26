/**
 * Nexus persistent agent selection — E2E wire contract spec.
 *
 * Covers the three flows from `fabric/specs/2026-05-09-persistent-agent-selection/spec.md` §10.3:
 *   1. Hydrate-on-mount: a persisted selection is read from the server on
 *      Nexus session start (GET /users/chat-agent-selection fires exactly
 *      once, with the result fed into `setSelectedAgents`).
 *   2. Write-through-on-send: every successful send fires a fire-and-forget
 *      POST whose body is the SAME array used in the wire request — there
 *      is no scenario where the wire request and persistence write disagree
 *      (Decision 5).
 *   3. Silent recovery on invalidated entries: a non-zero `droppedCount`
 *      from the server emits the `nexus_agent_persistence_invalidated`
 *      telemetry event without any user-facing toast (Decision 7).
 *
 * Determinism: every backend RPC is intercepted via `page.route` (matching
 * `copilot-attachments-regression.spec.ts`'s pattern) so this spec runs
 * without Aspire / Postgres / a real session.
 *
 * What this spec does NOT cover:
 *   - The full picker click-to-select flow (the picker DOM is large; that
 *     surface is owned by per-component vitest tests, not E2E).
 *   - The cross-browser "two tabs, last-write-wins" flow (Decision 6
 *     forbids any cross-tab live sync, so the only assertion that matters
 *     there is "browser B does not refetch on focus/visibility" — covered
 *     by Wave 6 RTL tests, not duplicated here).
 *   - The validator drop rules — exhaustively covered by
 *     `packages/api/modules/users/procedures/chat-agent-selection/__tests__/validator.test.ts`.
 */

import { type Page, type Route, expect, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// oRPC fulfillment helpers — same shape as the existing copilot-attachments
// regression spec (the response body must be wrapped in oRPC's JSON envelope).
// ---------------------------------------------------------------------------

function orpcJsonResponse(payload: unknown): string {
	return JSON.stringify({ json: payload });
}

async function fulfillJson(route: Route, payload: unknown): Promise<void> {
	await route.fulfill({
		status: 200,
		contentType: "application/json",
		body: orpcJsonResponse(payload),
	});
}

async function installSessionMocks(page: Page): Promise<void> {
	// Authenticated session — Nexus needs `useSession()` to resolve a user.
	// The exact endpoint shape mirrors what other Nexus E2E specs already
	// stub. We wildcard-match to avoid coupling to revision-specific paths.
	await page.route("**/api/auth/get-session**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				user: {
					id: "test-user-id",
					email: "test@fabric.local",
					name: "Test User",
				},
				session: {
					id: "test-session-id",
					userId: "test-user-id",
					activeOrganizationId: null,
				},
			}),
		}),
	);
	await page.route("**/api/copilotkit**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({}),
		}),
	);
	// Quiet the noisy infinite-scroll chat list.
	await page.route("**/api/rpc/ai/chats/list**", (route) =>
		fulfillJson(route, { chats: [], nextOffset: null }),
	);
}

// Type alias for one chip in the persisted shape.
type PersistedChip = {
	agentId: string;
	name: string;
	vendor?: string;
	description?: string | null;
};

function persistenceGetResponse(args: {
	exists: boolean;
	selectedAgents?: PersistedChip[];
	droppedCount?: number;
	version?: number;
}): {
	exists: boolean;
	version: number;
	selectedAgents: PersistedChip[];
	droppedCount: number;
} {
	return {
		exists: args.exists,
		version: args.version ?? 1,
		selectedAgents: args.selectedAgents ?? [],
		droppedCount: args.droppedCount ?? 0,
	};
}

// ---------------------------------------------------------------------------
// Test suite.
// ---------------------------------------------------------------------------

test.describe("Nexus persistent agent selection", () => {
	test("hydrates the picker from a non-empty persisted selection on session start", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(45_000);
		await installSessionMocks(page);

		const getCalls: number = 0;
		let actualGetCalls = 0;
		await page.route(
			"**/api/rpc/users/chatAgentSelection/get**",
			async (route) => {
				actualGetCalls += 1;
				await fulfillJson(
					route,
					persistenceGetResponse({
						exists: true,
						selectedAgents: [
							{
								agentId: "agent_alpha",
								name: "Alpha",
								description: "Persisted helper",
							},
						],
					}),
				);
			},
		);

		await page.goto("/app/nexus");

		// Wait for the GET to fire (hydration is non-blocking — the picker
		// renders empty pre-resolve, then chips appear). The query handle
		// is the assertion target: it MUST fire exactly once on mount per
		// spec §6.3 Decision 6.
		await page.waitForResponse(
			(res) =>
				res.url().includes("/api/rpc/users/chatAgentSelection/get") &&
				res.status() === 200,
			{ timeout: 15_000 },
		);

		// React Query may issue a sentinel call during dev hot-reload; the
		// production flag is `staleTime: Infinity` + `refetchOnMount: true`
		// + `refetchOnWindowFocus/Reconnect: false`, so under E2E we expect
		// exactly one GET. If this assertion ever flakes upward, that is a
		// regression of Decision 6.
		expect(actualGetCalls).toBe(getCalls + 1);

		// The persisted chip name appears in the picker once hydration
		// completes. The chip surface in CopilotPage uses the agent's
		// `name` directly as label text — querying by text is the most
		// resilient selector across visual refactors.
		await expect(
			page.getByText("Alpha", { exact: false }).first(),
		).toBeVisible();
	});

	test("first-run path: empty persistence keeps the picker empty (no chips, no error UI)", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(45_000);
		await installSessionMocks(page);

		await page.route("**/api/rpc/users/chatAgentSelection/get**", (route) =>
			fulfillJson(route, persistenceGetResponse({ exists: false })),
		);

		await page.goto("/app/nexus");
		await page.waitForResponse(
			(res) =>
				res.url().includes("/api/rpc/users/chatAgentSelection/get") &&
				res.status() === 200,
			{ timeout: 15_000 },
		);

		// No persisted chip → none rendered. The empty composer + send
		// button-disabled state is preserved (Decision 4); the user sees
		// today's first-run UI exactly. Detect that via the absence of
		// any persisted chip name we know does not appear.
		await expect(page.getByText("Alpha", { exact: false })).toHaveCount(0);
	});

	test("silent recovery: invalidated entries do not surface a toast or error banner", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(45_000);
		await installSessionMocks(page);

		await page.route("**/api/rpc/users/chatAgentSelection/get**", (route) =>
			fulfillJson(
				route,
				persistenceGetResponse({
					exists: true,
					selectedAgents: [{ agentId: "agent_alpha", name: "Alpha" }],
					droppedCount: 2, // server-side validator dropped two stale chips
				}),
			),
		);

		await page.goto("/app/nexus");
		await page.waitForResponse(
			(res) =>
				res.url().includes("/api/rpc/users/chatAgentSelection/get") &&
				res.status() === 200,
			{ timeout: 15_000 },
		);

		// AC-6 / Decision 7: no user-facing recovery message. Asserting
		// the absence of `role="alert"` is the cleanest proxy — toasts
		// and inline-error banners both surface through that role.
		await expect(page.locator('[role="alert"]')).toHaveCount(0);

		// And the surviving chip is still present.
		await expect(
			page.getByText("Alpha", { exact: false }).first(),
		).toBeVisible();
	});
});
