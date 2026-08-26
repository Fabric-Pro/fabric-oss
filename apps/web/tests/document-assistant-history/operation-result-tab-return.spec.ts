/**
 * E2E: the operation-result SYSTEM card is intentionally suppressed from the
 * UI on tab-return; the agent's own conversational confirmation covers it.
 *
 * Contract being tested:
 *   `HydratedMessagesProvider` now sources historical messages from the
 *   conversationId-keyed live query `useDocumentAssistantConversationById`
 *   (`getByIdForDocument`), with `staleTime:0 + refetchOnWindowFocus:true`.
 *   Returning to a backgrounded tab fires a REAL visibilitychange/focus event
 *   (TanStack's focusManager listens to both), which triggers a refetch that
 *   surfaces the persisted operation-result SYSTEM message — WITHOUT a reload.
 *
 * Strategy:
 *   1. Seed a conversation with ordinary user+assistant turns only (no
 *      operation-result message yet). Uses the same `seedConversation` /
 *      `resolveScope` helpers as the other specs in this directory.
 *   2. Navigate to the document page. Assert the operation-result text is NOT
 *      visible yet (it hasn't been persisted by the server).
 *   3. Install a `page.route` override on `getByIdForDocument` that will
 *      return the SAME conversation PLUS an appended system message on the
 *      next refetch. This simulates what would happen after the server
 *      persists the result while the user has the tab backgrounded.
 *   4. Background the tab FOR REAL by opening a second page in the same
 *      context and navigating it to `about:blank`, then bring the original
 *      tab back to front. Playwright fires REAL visibilitychange/focus events
 *      this way. A synthetic `dispatchEvent` does NOT work because
 *      `document.visibilityState` is read-only — the manager would not see a
 *      hidden→visible transition.
 *   5. Assert the operation-result message IS now visible WITHOUT any
 *      `page.reload()`.
 *
 * Skip gate:
 *   Same env vars as the other single-user specs (see `_fixtures.ts`). When
 *   unset, the suite skips gracefully rather than failing.
 *
 * Route mock path:
 *   The oRPC browser client uses `RPCLink` with base `/api/rpc`. ALL
 *   procedures — including `getByIdForDocument` (which declares `method:"GET"`
 *   for the OpenAPI handler only) — arrive at the server as POST requests to
 *   `/api/rpc/<router-path>`. The correct glob pattern wraps
 *   `/api/rpc/agents/conversations/getByIdForDocument` in `**` globs on both
 *   ends (see the `page.route(...)` call below for the literal pattern).
 *   This matches the same pattern used by `hydration-tti.spec.ts` for
 *   `getActiveForDocument`.
 *
 * Response shape:
 *   The RPC handler wraps all payloads in `{ json: <handler-return> }`. For
 *   `getByIdForDocument` the handler returns `{ conversation: { ... } }`, so
 *   the mock body is `{ json: { conversation: { ... } } }`.
 */

import { expect, test } from "@playwright/test";
import {
	getActiveConversation,
	pageUrlFor,
	readSeedConfig,
	removeConversation,
	resolveScope,
	seedConversation,
} from "./_fixtures";

const cfg = readSeedConfig();
const scope = resolveScope(cfg);

// Allow generous time for the live server + seeding. The test itself completes
// in seconds once seeding is done; the budget is dominated by `seedConversation`
// making API round-trips and the dev server rendering the document page.
test.setTimeout(120_000);

test.describe("document assistant — operation-result appears on tab-return (AC-2)", () => {
	test.skip(
		!scope,
		"Set TEST_ORG_* or TEST_PERSONAL_* env vars to run this suite — see _fixtures.ts.",
	);

	let seededConversationId: string | null = null;

	test.beforeAll(async ({ request }) => {
		if (!scope) {
			return;
		}
		// Seed a small conversation (2 turns: 1 user + 1 assistant). We only
		// need an active conversation with a known id so the provider mounts
		// against a real conversationId. The operation-result message is NOT
		// seeded here — it will be injected via route mock to simulate the
		// server persisting it while the tab was backgrounded.
		seededConversationId = await seedConversation(request, scope, 2);
	});

	test.afterAll(async ({ request }) => {
		if (!seededConversationId) {
			return;
		}
		await removeConversation(request, seededConversationId);
	});

	test("persisted operation-result SYSTEM message is suppressed from the UI on tab-return", async ({
		page,
		request,
	}) => {
		if (!scope) {
			test.skip();
			return;
		}

		// Ensure our seed completed and we have a conversation id.
		const active = await getActiveConversation(request, scope);
		expect(active?.conversationId).toBeTruthy();
		const conversationId = active?.conversationId ?? seededConversationId;
		expect(conversationId).toBeTruthy();

		// ----------------------------------------------------------------
		// 1. Navigate to the document page and wait for the sidebar to
		//    attach. Assert no operation-result message is visible yet.
		// ----------------------------------------------------------------
		await page.goto(pageUrlFor(scope));
		const sidebar = page.locator(".copilotKitSidebarContentWrapper");
		await sidebar.waitFor({ state: "attached", timeout: 30_000 });

		// The operation-result body text must not be in the sidebar yet.
		// We use a unique marker that we'll look for after tab-return.
		const OPERATION_RESULT_BODY = "[e2e-ac2] Feature drafted.";
		await expect(page.getByText(OPERATION_RESULT_BODY)).toHaveCount(0);

		// ----------------------------------------------------------------
		// 2. Install route override on getByIdForDocument BEFORE
		//    backgrounding. On the next refetch (triggered by focus-return)
		//    the mock returns the conversation WITH the operation-result
		//    system message appended. This simulates the server persisting
		//    the result while the user was away.
		//
		//    The message content starts with "SYSTEM\n\n" — the
		//    SystemMessage component strips that prefix and renders the
		//    remainder as the visible body text (see SystemMessage.tsx
		//    `extractBody`). So the DOM will contain OPERATION_RESULT_BODY.
		// ----------------------------------------------------------------
		let refetchHit = false;
		await page.route(
			"**/api/rpc/agents/conversations/getByIdForDocument**",
			async (route) => {
				refetchHit = true;
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({
						json: {
							conversation: {
								id: "e2e-da-ac2",
								conversationId,
								title: null,
								visibility: "SHARED",
								visibilityLockedAt: null,
								archivedAt: null,
								parentConversationId: null,
								agentId: "project_document_generator",
								createdAt: new Date().toISOString(),
								updatedAt: new Date().toISOString(),
								messages: [
									{
										id: "e2e-ac2-u1",
										role: "user",
										content:
											"[e2e hydration seed] user turn #0",
										timestamp: new Date(
											Date.now() - 60_000,
										).toISOString(),
									},
									{
										id: "e2e-ac2-a1",
										role: "assistant",
										content:
											"[e2e hydration seed] assistant reply #1",
										timestamp: new Date(
											Date.now() - 30_000,
										).toISOString(),
									},
									{
										id: "e2e-ac2-sys1",
										role: "system",
										// The SystemMessage component strips the "SYSTEM\n\n"
										// prefix and renders the remainder as the visible body.
										content: `SYSTEM\n\n${OPERATION_RESULT_BODY}`,
										metadata: {
											kind: "operation_result",
											outcome: "success",
										},
										timestamp: new Date().toISOString(),
									},
								],
							},
						},
					}),
				});
			},
		);

		// ----------------------------------------------------------------
		// 3. Background this tab FOR REAL:
		//    - Open a second page in the same browser context (shares auth
		//      cookies) and navigate it to about:blank.
		//    - The first page loses focus/visibility — Playwright fires the
		//      REAL visibilitychange event; document.visibilityState becomes
		//      "hidden" from the browser's perspective.
		//    - Brief wait so TanStack's focusManager registers the hidden
		//      state before we bring the tab forward again.
		//    - Bring the original page to front → REAL focus event fires →
		//      TanStack refetchOnWindowFocus logic runs → getByIdForDocument
		//      is called → our mock returns the conversation WITH the system
		//      message → HydratedMessagesProvider re-renders with the new
		//      data → CustomMessages renders the SystemMessage component.
		// ----------------------------------------------------------------
		const secondPage = await page.context().newPage();
		await secondPage.goto("about:blank");
		// Short dwell so the browser registers the first tab as hidden.
		await page.waitForTimeout(350);
		await page.bringToFront();

		// ----------------------------------------------------------------
		// 4. The focus-return refetch DID fire (route hit) — but the
		//    operation-result SYSTEM card is intentionally suppressed from
		//    the UI (CustomMessages renders null for it, #1412 follow-up).
		//    Prove the refetch happened, let React process it, then assert
		//    the card and its body never render.
		// ----------------------------------------------------------------
		await expect.poll(() => refetchHit, { timeout: 10_000 }).toBe(true);
		await page.waitForTimeout(800);

		await expect(page.getByText(OPERATION_RESULT_BODY)).toHaveCount(0);
		await expect(
			page.locator('[data-message-kind="operation_result"]'),
		).toHaveCount(0);

		await secondPage.close();
	});
});
