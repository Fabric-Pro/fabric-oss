/**
 * E2E: 50/day soft cap on new conversations (I.7).
 *
 * Spec: 2026-05-19-ai-assistant-document-chat-history §3.3 FR-11, §9.4,
 * AC-14; Risk R8.
 *
 * Verifies the rolling-24h soft cap end-to-end:
 *
 *   1. Seed 50 separate conversations for the active (user, document)
 *      pair via the live API. Each one is archived immediately after
 *      the seed turn lands so the next seed call goes through the
 *      lazy-create path (and therefore counts against the 50/day cap
 *      enforced inside `appendTurnForDocument`).
 *   2. Attempt one more — either by clicking "Start a new conversation"
 *      + sending a real prompt, or by calling the API directly. The
 *      response MUST be oRPC `CONFLICT` with the friendly user-facing
 *      message from FR-11.
 *
 * Why the SLOW gate? Step 1 issues ~100 HTTP round-trips against the
 * dev server (50 seed turns + 50 archives). On a local box that's
 * ~30-60 seconds; on CI it's worse and contributes negligibly to the
 * shared-runner budget if it runs every PR. The spec lists this as a
 * smoke check that runs on demand, not on every push.
 *
 * Run it with `TEST_RUN_SLOW_SPECS=true pnpm --filter web e2e
 * tests/document-assistant-history/fifty-per-day-cap.spec.ts`.
 *
 * NOTE on UI vs. API: we assert the cap at the API level (the
 * authoritative source for FR-11) AND drive a `sonner` toast assertion
 * for the UI affordance described in FR-11. The toast component is
 * registered by the global toaster mount in the editor shell, so the
 * driver assertion just needs to find the role="status" toast with the
 * exact friendly copy.
 */

import { expect, test } from "@playwright/test";
import {
	archiveActiveConversation,
	pageUrlFor,
	readSeedConfig,
	removeConversation,
	resolveScope,
	seedConversation,
} from "./_fixtures";

// Friendly copy is asserted verbatim because spec FR-11 quotes it
// literally and AC-14 is explicit about the exact string.
const FRIENDLY_CAP_MESSAGE =
	"You've started 50 conversations on this document today — try again tomorrow or continue the most recent thread.";

const cfg = readSeedConfig();
const scope = resolveScope(cfg);

const slowAllowed = process.env.TEST_RUN_SLOW_SPECS === "true";

// The 50-seed loop dominates the wall clock; give it ample headroom.
test.setTimeout(15 * 60_000);

test.describe("document assistant — 50/day soft cap", () => {
	test.skip(
		!scope,
		"Set TEST_ORG_* or TEST_PERSONAL_* env vars to run this suite — see _fixtures.ts.",
	);
	test.skip(
		!slowAllowed,
		"Set TEST_RUN_SLOW_SPECS=true to opt in to this slow spec (~50 seed round-trips). Spec §9.4 / AC-14.",
	);

	const createdIds: string[] = [];

	test.afterAll(async ({ request }) => {
		// Best-effort cleanup. The 51st row never lands so it's not in
		// the list; the first 50 are explicitly tracked here.
		for (const id of createdIds) {
			await removeConversation(request, id);
		}
	});

	test("51st new-conversation attempt returns CONFLICT with the FR-11 copy", async ({
		page,
		request,
	}) => {
		if (!scope || !slowAllowed) {
			test.skip();
			return;
		}

		// ----------------------------------------------------------
		// 1. Drive the cap to 50 by seeding-then-archiving 50
		//    separate conversations. Each archive frees the
		//    "active" slot so the next seed must lazy-create a
		//    fresh row (which is what FR-11 counts).
		// ----------------------------------------------------------
		for (let i = 0; i < 50; i++) {
			const id = await seedConversation(request, scope, 1, {
				requestedVisibility: "SHARED",
			});
			createdIds.push(id);
			await archiveActiveConversation(request, id);
		}

		// ----------------------------------------------------------
		// 2a. Attempt #51 via the live API (the canonical contract
		//     surface). MUST be oRPC CONFLICT with the friendly
		//     copy. We assert the API response BEFORE the UI
		//     because the API IS the contract under test; the UI
		//     toast is a downstream affordance.
		// ----------------------------------------------------------
		const conflictAttempt = await request.post(
			"/api/rpc/agents/conversations/appendTurnForDocument",
			{
				headers: { "Content-Type": "application/json" },
				data: {
					json: {
						documentRefKind: scope.documentRefKind,
						documentRefId: scope.documentId,
						projectId: scope.projectId,
						organizationId:
							scope.kind === "org" ? scope.organizationId : null,
						conversationId: null,
						message: {
							id: `e2e-cap-attempt-${Date.now()}`,
							role: "user",
							content: "Should be capped.",
							timestamp: new Date().toISOString(),
						},
						agentId: "project_document_generator",
						requestedVisibility: "SHARED",
					},
				},
			},
		);
		expect(
			conflictAttempt.status(),
			`51st new-conversation create must return CONFLICT (spec FR-11). Got ${conflictAttempt.status()}.`,
		).toBe(409);

		const conflictBody = await conflictAttempt.text();
		expect(
			conflictBody,
			`51st new-conversation create response body must include the FR-11 friendly copy. Got: ${conflictBody.slice(0, 400)}`,
		).toContain(FRIENDLY_CAP_MESSAGE);

		// ----------------------------------------------------------
		// 2b. UI assertion. Open the editor, click "Start a new
		//     conversation" + send a prompt, and assert the
		//     friendly toast appears.
		//
		// We use the literal FRIENDLY_CAP_MESSAGE so a copy drift
		// fails this assertion immediately (AC-14 is verbatim).
		// ----------------------------------------------------------
		await page.goto(pageUrlFor(scope));
		const textarea = page.locator("textarea").first();
		await textarea.waitFor({ state: "visible", timeout: 30_000 });

		await page
			.getByRole("button", { name: /start a new conversation/i })
			.click();
		await textarea.fill("Capped attempt via UI");
		await textarea.press("Enter");

		await expect(page.getByText(FRIENDLY_CAP_MESSAGE)).toBeVisible({
			timeout: 15_000,
		});
	});
});
