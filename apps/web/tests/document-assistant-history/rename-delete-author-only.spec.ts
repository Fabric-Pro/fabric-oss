/**
 * E2E: rename + delete are author-only (I.8).
 *
 * Spec: 2026-05-19-ai-assistant-document-chat-history §3.4 FR-15, §9.4.
 *
 * Verifies the per-conversation author-only contract:
 *
 *   1. User A creates a SHARED conversation and renames it via the
 *      drawer's kebab menu. The drawer list MUST reflect the new title.
 *   2. User B (project member) opens the drawer, selects user A's
 *      conversation in the viewer pane, and confirms the kebab
 *      ("Conversation actions") button is NOT rendered (FR-15 — no UI
 *      affordance for non-authors).
 *   3. Direct API attack: user B's session calls
 *      `renameForDocument` for user A's conversationId. The response
 *      MUST be `FORBIDDEN` (FR-15 — server is the authority, not the
 *      client UI).
 *
 * The same pattern transitively covers `deleteForDocument`'s author
 * check; we keep this spec focused on rename to keep the runtime
 * reasonable. The delete-author check is exercised by the unit-level
 * coverage in `archive-delete-rename-for-document.test.ts` (Group B).
 */

import { expect, test } from "@playwright/test";
import { setupTwoUsers, teardown } from "../helpers/mentions-setup";
import {
	listConversationsForDocument,
	removeConversation,
	seedConversation,
} from "./_fixtures";

test.setTimeout(180_000);

const haveCreds = process.env.E2E_USER_A_EMAIL && process.env.E2E_USER_B_EMAIL;

test.describe("document assistant — rename + delete are author-only", () => {
	test.skip(
		!haveCreds,
		"Set E2E_USER_A_EMAIL / E2E_USER_B_EMAIL (+ matching passwords) to run this suite — see helpers/mentions-setup.ts.",
	);

	test("author can rename; non-author has no UI affordance AND server returns FORBIDDEN (FR-15)", async ({
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

			// ----------------------------------------------------
			// 1. User A seeds a SHARED conversation and opens
			//    the History drawer.
			// ----------------------------------------------------
			seededConversationId = await seedConversation(
				pageA.request,
				scope,
				/* turns */ 1,
				{ requestedVisibility: "SHARED" },
			);

			await pageA.goto(doc.documentUrl);
			await pageA
				.locator("textarea")
				.first()
				.waitFor({ state: "visible", timeout: 30_000 });
			await pageA
				.getByRole("button", { name: /open chat history/i })
				.click();

			const drawerA = pageA.getByRole("dialog", {
				name: /document assistant chat history/i,
			});
			await drawerA.waitFor({ state: "visible", timeout: 15_000 });

			// Select the seeded conversation row. The list pane
			// is `role="listbox"` per CopilotHistoryDrawer.tsx
			// — clicking any list item moves it to the viewer.
			const sharedRow = drawerA
				.getByRole("listbox", { name: /conversations/i })
				.getByText(/new conversation|shared|\[e2e/i)
				.first();
			await sharedRow.click();

			// The viewer's kebab MUST be visible for the author.
			const kebabA = drawerA.getByRole("button", {
				name: /conversation actions/i,
			});
			await expect(kebabA).toBeVisible({ timeout: 10_000 });

			// ----------------------------------------------------
			// 2. Rename via the kebab → Rename menu item. The
			//    RenameChatDialog renders an <input> we can
			//    fill, then a Save / Confirm button.
			// ----------------------------------------------------
			const newTitle = `Renamed by author ${Date.now()}`;
			await kebabA.click();
			await pageA.getByRole("menuitem", { name: /rename/i }).click();

			// The rename dialog uses the shared `RenameChatDialog`
			// shape (see spec §3.4 FR-15). The form's input is
			// the only textbox inside the dialog; the confirm
			// button is the primary action.
			const renameDialog = pageA.getByRole("dialog").last();
			const titleInput = renameDialog.getByRole("textbox");
			await titleInput.waitFor({ state: "visible", timeout: 10_000 });
			await titleInput.fill(newTitle);
			await renameDialog
				.getByRole("button", { name: /save|rename|confirm/i })
				.first()
				.click();

			// Drawer list MUST refresh and show the new title.
			await expect(drawerA.getByText(newTitle).first()).toBeVisible({
				timeout: 15_000,
			});

			// Close the drawer so the next assertion isn't
			// fighting focus traps.
			await pageA.keyboard.press("Escape");

			// Cross-check via the API list: title field is the
			// canonical source.
			const listAfterRename = await listConversationsForDocument(
				contextA.request,
				scope,
			);
			expect(
				listAfterRename.find(
					(c) =>
						c.conversationId === seededConversationId &&
						c.title === newTitle,
				),
				"After rename the list payload MUST carry the new title (FR-15).",
			).toBeTruthy();

			// ----------------------------------------------------
			// 3. User B: opens the drawer, selects the
			//    conversation, asserts NO kebab is rendered.
			// ----------------------------------------------------
			await pageB.goto(doc.documentUrl);
			await pageB
				.locator("textarea")
				.first()
				.waitFor({ state: "visible", timeout: 30_000 });
			await pageB
				.getByRole("button", { name: /open chat history/i })
				.click();

			const drawerB = pageB.getByRole("dialog", {
				name: /document assistant chat history/i,
			});
			await drawerB.waitFor({ state: "visible", timeout: 15_000 });
			await drawerB.getByText(newTitle).first().click();

			// AC-15-adjacent: kebab MUST be absent for non-authors.
			// We use `toHaveCount(0)` rather than `toBeHidden()`
			// so a "rendered but display:none" regression also
			// fails — the affordance must not exist at all.
			await expect(
				drawerB.getByRole("button", {
					name: /conversation actions/i,
				}),
			).toHaveCount(0);

			// ----------------------------------------------------
			// 4. Direct API attack: user B calls
			//    renameForDocument for user A's conversationId.
			//    MUST return FORBIDDEN.
			// ----------------------------------------------------
			const attackResp = await pageB.request.post(
				"/api/rpc/agents/conversations/renameForDocument",
				{
					headers: { "Content-Type": "application/json" },
					data: {
						json: {
							conversationId: seededConversationId,
							title: "Hijacked by user B",
						},
					},
				},
			);
			expect(
				attackResp.status(),
				`user B's renameForDocument call MUST return FORBIDDEN (FR-15). Got ${attackResp.status()}.`,
			).toBe(403);

			// And the actual stored title MUST be unchanged.
			const finalList = await listConversationsForDocument(
				contextA.request,
				scope,
			);
			const stored = finalList.find(
				(c) => c.conversationId === seededConversationId,
			);
			expect(stored?.title).toBe(newTitle);
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
