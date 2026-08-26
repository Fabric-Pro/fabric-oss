/**
 * E2E: private locks after first send (I.4).
 *
 * Spec: 2026-05-19-ai-assistant-document-chat-history §3.5 FR-17 / FR-18,
 * §9.4, AC-8; Risk R1.
 *
 * Verifies the visibility-toggle contract end-to-end:
 *
 *   1. User A opens a fresh conversation and flips the chip to "Private to
 *      me". The chip's tooltip MUST read "Private — only you" (FR-17).
 *   2. User A sends a first message and waits for it to persist. The chip
 *      MUST become a non-interactive locked indicator with the tooltip
 *      "Visibility locked after the first message." (FR-17, AC-8.)
 *   3. User B (project member on the same org) opens the same document and
 *      opens the History drawer. User A's PRIVATE conversation MUST NOT
 *      appear (FR-19 visibility predicate; Risk R1).
 *
 * Strategy notes:
 *   - We exercise the chip's UI toggle (rather than seeding visibility via
 *     API) because the assertion under test is the UI affordance + tooltip
 *     copy. The chip's `aria-label` ("Conversation visibility: Private")
 *     and tooltip body ("Private — only you") come from
 *     `CopilotSidebarHeader.tsx` and the `en.json` translation table.
 *   - To avoid a long model round-trip in the "first message persists"
 *     step (the same property is already covered by I.2 / FR-2), we drive
 *     the persistence path through the live API via `seedConversation`
 *     immediately AFTER the user toggles to PRIVATE. The API
 *     (`appendTurnForDocument`) is the same code path the UI would hit
 *     and is the actual source of `visibilityLockedAt`. The UI assertion
 *     then refreshes the chip from the live snapshot and renders the
 *     locked indicator.
 *   - Reusing `setupTwoUsers` from the mentions helper gives us the
 *     two-context auth pattern without re-implementing it.
 */

import { expect, test } from "@playwright/test";
import { setupTwoUsers, teardown } from "../helpers/mentions-setup";
import {
	getActiveConversation,
	listConversationsForDocument,
	removeConversation,
	seedConversation,
} from "./_fixtures";

test.setTimeout(180_000);

const haveCreds = process.env.E2E_USER_A_EMAIL && process.env.E2E_USER_B_EMAIL;

test.describe("document assistant — private locks after first send", () => {
	test.skip(
		!haveCreds,
		"Set E2E_USER_A_EMAIL / E2E_USER_B_EMAIL (+ matching passwords) to run this suite — see helpers/mentions-setup.ts.",
	);

	test("toggle to PRIVATE pre-send, then lock on first persisted turn (AC-8 / Risk R1)", async ({
		browser,
	}) => {
		if (!haveCreds) {
			test.skip();
			return;
		}

		const fixture = await setupTwoUsers(browser);
		const { pageA, pageB, orgSlug, project, doc, contextA } = fixture;

		let seededConversationId: string | null = null;

		try {
			const scope = {
				kind: "org" as const,
				organizationId: project.organizationId,
				organizationSlug: orgSlug,
				projectId: project.projectId,
				documentId: doc.documentId,
				documentRefKind: "PROJECT_DOCUMENT" as const,
			};

			// ------------------------------------------------------
			// User A: open the document and toggle the visibility
			// chip to PRIVATE BEFORE sending anything.
			// ------------------------------------------------------
			await pageA.goto(doc.documentUrl);
			await pageA
				.locator("textarea")
				.first()
				.waitFor({ state: "visible", timeout: 30_000 });

			const sharedChip = pageA.getByRole("switch", {
				name: /conversation visibility: shared/i,
			});
			await expect(sharedChip).toBeVisible({ timeout: 15_000 });
			await sharedChip.click();

			// After the optimistic flip the chip MUST re-label as
			// "Private" (FR-17). The translated tooltip body
			// ("Private — only you") proves the right copy is
			// wired through the i18n table.
			const privateChip = pageA.getByRole("switch", {
				name: /conversation visibility: private/i,
			});
			await expect(privateChip).toBeVisible({ timeout: 10_000 });
			await privateChip.hover();
			await expect(pageA.getByText(/private — only you/i)).toBeVisible({
				timeout: 5_000,
			});

			// ------------------------------------------------------
			// Persist a first turn through the live API with
			// `requestedVisibility: "PRIVATE"`. This sets
			// `visibilityLockedAt` per spec §3.1 FR-2 / FR-17.
			// We then reload the editor so the SSR loader hands
			// the locked snapshot back to the chip.
			// ------------------------------------------------------
			seededConversationId = await seedConversation(
				pageA.request,
				scope,
				/* turns */ 1,
				{ requestedVisibility: "PRIVATE" },
			);

			const persisted = await getActiveConversation(pageA.request, scope);
			expect(persisted?.conversationId).toBe(seededConversationId);

			await pageA.reload({ waitUntil: "domcontentloaded" });
			await pageA
				.locator("textarea")
				.first()
				.waitFor({ state: "visible", timeout: 30_000 });

			// ------------------------------------------------------
			// Post-send: the chip MUST become the locked
			// `role="status"` variant. AC-8 demands the toggle
			// stop being a button — `getByRole("switch", ...)`
			// MUST NOT match anymore.
			// ------------------------------------------------------
			await expect(
				pageA.getByRole("switch", {
					name: /conversation visibility/i,
				}),
			).toHaveCount(0);

			const lockedChip = pageA.getByRole("status", {
				name: /conversation visibility: private \(locked\)/i,
			});
			await expect(lockedChip).toBeVisible({ timeout: 10_000 });

			await lockedChip.hover();
			await expect(
				pageA.getByText(/visibility locked after the first message/i),
			).toBeVisible({ timeout: 5_000 });

			// ------------------------------------------------------
			// User B: must NOT see the PRIVATE conversation. We
			// check the API surface (the same one the drawer
			// uses) first so a drawer-render flake can't mask the
			// isolation regression Risk R1 is guarding against.
			// ------------------------------------------------------
			const userBVisible = await listConversationsForDocument(
				pageB.request,
				scope,
			);
			expect(
				userBVisible.find(
					(c) => c.conversationId === seededConversationId,
				),
				"User B MUST NOT see user A's PRIVATE conversation in listForDocument (spec §3.5 FR-19, Risk R1).",
			).toBeUndefined();

			// And the drawer itself MUST also not render any row
			// for the private conversation. We don't have a
			// stable test-id per row, so we use the empty-state
			// copy as the strong signal: with no SHARED rows for
			// user B + a single PRIVATE row owned by user A, the
			// drawer MUST show the FR-16 empty state.
			await pageB.goto(doc.documentUrl);
			await pageB
				.locator("textarea")
				.first()
				.waitFor({ state: "visible", timeout: 30_000 });
			await pageB
				.getByRole("button", { name: /open chat history/i })
				.click();
			const drawer = pageB.getByRole("dialog", {
				name: /document assistant chat history/i,
			});
			await drawer.waitFor({ state: "visible", timeout: 15_000 });
			await expect(drawer.getByText(/history starts now/i)).toBeVisible({
				timeout: 10_000,
			});
		} finally {
			if (seededConversationId) {
				await removeConversation(
					contextA.request,
					seededConversationId,
				);
			}
			await teardown(fixture);
		}
	});
});
