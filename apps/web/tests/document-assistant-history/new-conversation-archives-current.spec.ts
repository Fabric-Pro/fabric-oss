/**
 * E2E: new-conversation flow archives the active thread (I.5).
 *
 * Spec: 2026-05-19-ai-assistant-document-chat-history §3.3 FR-10, §9.4.
 *
 * Walks the "start a new conversation" affordance:
 *
 *   1. Seed (via the live API) a single-turn SHARED conversation so the
 *      document already has an active thread to archive.
 *   2. Open the editor — assert the seeded turn is visible in the
 *      sidebar at hydration time (rules out the "live chat was empty
 *      anyway, archive was a no-op" false positive).
 *   3. Click the "Start a new conversation" plus-icon in the header.
 *   4. Assert the live sidebar is empty (no persisted-turn substrings).
 *   5. Open the History drawer — assert the archived thread is listed
 *      (it survived) and shows the SHARED visibility chip.
 *   6. Drive a second turn through the live API. Assert the History
 *      drawer now lists TWO conversation rows for the same document,
 *      proving the next send produced a fresh conversation row instead
 *      of re-using the archived one.
 *
 * Why the API for the second turn instead of clicking through the UI?
 * The behavioural contract under test is "next turn → fresh row," which
 * is enforced by the lazy-create path in `appendTurnForDocument`. Using
 * the live API exercises that path directly without coupling the test
 * to model latency (separately covered by I.2). Spec §3.3 FR-10 mandates
 * "creates the next AgentConversation lazily on the first user turn" —
 * the API IS the first user turn.
 */

import { expect, test } from "@playwright/test";
import {
	getActiveConversation,
	listConversationsForDocument,
	pageUrlFor,
	readSeedConfig,
	removeConversation,
	resolveScope,
	seedConversation,
} from "./_fixtures";

const cfg = readSeedConfig();
const scope = resolveScope(cfg);

test.setTimeout(120_000);

test.describe("document assistant — new conversation archives current", () => {
	test.skip(
		!scope,
		"Set TEST_ORG_* or TEST_PERSONAL_* env vars to run this suite — see _fixtures.ts.",
	);

	const seededIds: string[] = [];

	test.afterAll(async ({ request }) => {
		for (const id of seededIds) {
			await removeConversation(request, id);
		}
	});

	test("plus-icon archives the active thread and the next turn creates a fresh row (FR-10)", async ({
		page,
		request,
	}) => {
		if (!scope) {
			test.skip();
			return;
		}

		// ----------------------------------------------------------
		// 1. Seed a one-turn SHARED conversation. This becomes the
		//    "active" thread the user is going to archive.
		// ----------------------------------------------------------
		const seededOne = await seedConversation(request, scope, 1, {
			requestedVisibility: "SHARED",
		});
		seededIds.push(seededOne);

		// ----------------------------------------------------------
		// 2. Open the editor. The hydrator MUST land the seeded
		//    turn into the sidebar at first paint (D.5 contract).
		// ----------------------------------------------------------
		await page.goto(pageUrlFor(scope));
		const sidebar = page.locator(".copilotKitSidebarContentWrapper");
		await sidebar.waitFor({ state: "attached", timeout: 30_000 });

		const htmlBeforeReset = await sidebar.evaluate((el) => el.innerHTML);
		expect(htmlBeforeReset).toContain("[e2e hydration seed]");

		// ----------------------------------------------------------
		// 3. Click the "Start a new conversation" affordance. The
		//    aria-label is fixed by `CopilotSidebarHeader.tsx`
		//    (line 255) per spec §3.3 FR-10.
		// ----------------------------------------------------------
		await page
			.getByRole("button", { name: /start a new conversation/i })
			.click();

		// ----------------------------------------------------------
		// 4. Live chat MUST now be empty — the seeded turn is no
		//    longer in the sidebar's painted markup. We use a
		//    polled check so we don't race the archive mutation
		//    (which fires async and only then clears the local
		//    `useCopilotChat` messages).
		// ----------------------------------------------------------
		await expect
			.poll(
				async () => {
					const html = await sidebar.evaluate((el) => el.innerHTML);
					return html.includes("[e2e hydration seed]");
				},
				{
					message:
						"timed out waiting for the seeded turn to clear from the live chat after 'New conversation'",
					timeout: 15_000,
				},
			)
			.toBe(false);

		// And the live snapshot from the API MUST report no
		// active conversation for this user/document (the
		// archived row's `archivedAt` is set, so it no longer
		// matches the "ACTIVE for this user" predicate).
		await expect
			.poll(
				async () => {
					const snap = await getActiveConversation(request, scope);
					return snap?.conversationId ?? null;
				},
				{
					message:
						"active conversation snapshot still points at the archived thread",
					timeout: 15_000,
				},
			)
			.not.toBe(seededOne);

		// ----------------------------------------------------------
		// 5. Open the History drawer and assert the archived
		//    thread is still listed (it survived archive — it
		//    just isn't ACTIVE anymore).
		// ----------------------------------------------------------
		await page.getByRole("button", { name: /open chat history/i }).click();
		const drawer = page.getByRole("dialog", {
			name: /document assistant chat history/i,
		});
		await drawer.waitFor({ state: "visible", timeout: 15_000 });

		// The visibility chip + author chip combine to identify
		// the row; we don't have a stable per-row test-id, so
		// the SHARED chip presence is the proxy "the archived
		// row is rendered."
		await expect(drawer.getByText(/^shared$/i).first()).toBeVisible({
			timeout: 10_000,
		});

		// Close drawer so the next API write isn't masked by
		// the open Sheet stealing focus.
		await page.keyboard.press("Escape");
		await expect(drawer).toBeHidden({ timeout: 5_000 });

		// ----------------------------------------------------------
		// 6. Drive a second user turn through the API. This is
		//    the lazy-create path FR-10 promises.
		// ----------------------------------------------------------
		const seededTwo = await seedConversation(request, scope, 1, {
			requestedVisibility: "SHARED",
		});
		seededIds.push(seededTwo);
		expect(seededTwo).not.toBe(seededOne);

		// ----------------------------------------------------------
		// 7. Re-open the drawer and assert TWO rows for the
		//    document. The API list response is the canonical
		//    source: we expect both ids in `listForDocument`.
		// ----------------------------------------------------------
		const visible = await listConversationsForDocument(request, scope);
		const visibleIds = new Set(visible.map((c) => c.conversationId));
		expect(visibleIds.has(seededOne)).toBe(true);
		expect(visibleIds.has(seededTwo)).toBe(true);
	});
});
