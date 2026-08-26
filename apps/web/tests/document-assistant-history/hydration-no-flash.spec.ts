/**
 * E2E: Document-assistant hydration — no greeting flash (D.5).
 *
 * Spec: 2026-05-19-ai-assistant-document-chat-history §3.2 FR-7 / FR-8,
 * §7, AC-7 (and Risk R3). The CopilotSidebar inside `<DocumentEditor>`
 * MUST never paint the default greeting copy when the SSR loader supplied
 * a hydrated conversation.
 *
 * Test strategy:
 *  1. Seed a 200-turn conversation via the live oRPC API (`_fixtures.ts`).
 *  2. Open the document editor with the seed active.
 *  3. Capture the sidebar's `innerHTML` as soon as it becomes attached to
 *     the DOM — BEFORE any user interaction.
 *  4. Assert the greeting substring is NOT in that markup AND that at
 *     least one persisted assistant turn is present (proves hydration
 *     beat the empty-state branch in `<CopilotSidebar>`).
 *
 * Tear-down deletes the seeded conversation so the next run starts clean.
 */

import { expect, test } from "@playwright/test";
import {
	DOCUMENT_GREETING_SUBSTRING,
	getActiveConversation,
	HYDRATION_TURN_COUNT,
	pageUrlFor,
	readSeedConfig,
	removeConversation,
	resolveScope,
	seedConversation,
} from "./_fixtures";

const cfg = readSeedConfig();
const scope = resolveScope(cfg);

test.describe("document assistant hydration — no greeting flash", () => {
	test.skip(
		!scope,
		"Set TEST_ORG_* or TEST_PERSONAL_* env vars to run this suite — see _fixtures.ts.",
	);

	let seededConversationId: string | null = null;

	test.beforeAll(async ({ request }) => {
		if (!scope) {
			return;
		}
		// Reuse any already-active row for this user/document so we are not
		// re-spending the 50/day soft cap on every test run. Only seed when
		// the live thread is short of the 200-turn target.
		const existing = await getActiveConversation(request, scope);
		if (existing && existing.messageCount >= HYDRATION_TURN_COUNT) {
			seededConversationId = existing.conversationId;
			return;
		}
		seededConversationId = await seedConversation(
			request,
			scope,
			HYDRATION_TURN_COUNT,
		);
	});

	test.afterAll(async ({ request }) => {
		if (!seededConversationId) {
			return;
		}
		await removeConversation(request, seededConversationId);
	});

	test("first paint of the sidebar does not contain the empty-greeting copy", async ({
		page,
	}) => {
		if (!scope) {
			test.skip();
			return;
		}

		await page.goto(pageUrlFor(scope));

		// `.copilotKitSidebarContentWrapper` is the real DOM div CopilotKit
		// injects as the immediate child of the editor body
		// (DocumentEditorPage.tsx:487 references this exact class). Waiting
		// on `attached` (NOT `visible`) captures the moment the markup
		// becomes available — and our layout-effect hydrator (D.1) has
		// already run because layout effects fire before commit.
		const sidebar = page.locator(".copilotKitSidebarContentWrapper");
		await sidebar.waitFor({ state: "attached", timeout: 20000 });

		const html = await sidebar.evaluate((el) => el.innerHTML);

		// AC-7: greeting MUST NEVER be painted.
		expect(html).not.toContain(DOCUMENT_GREETING_SUBSTRING);

		// AC-1 + AC-4: persisted thread MUST be visible at hydration time.
		// We assert one of the seed strings rather than counting message
		// nodes because the exact DOM class CopilotKit uses for an
		// assistant message has changed across minor versions (1.50, 1.52)
		// and pinning a class would couple the test to internals.
		expect(html).toContain("[e2e hydration seed]");
	});
});
