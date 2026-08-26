/**
 * E2E: two-user shared visibility (I.3).
 *
 * Spec: 2026-05-19-ai-assistant-document-chat-history §9.4, AC-3.
 *
 * Verifies that when User A sends a turn in a `SHARED` conversation,
 * User B (another project member) sees that conversation in their History
 * drawer with the correct author chip + SHARED visibility chip — confirming
 * the visibility predicate from spec §3.5 FR-19 works at the UI layer for
 * both authoring and consuming users.
 *
 * Reuses the document-mentions two-user fixture (`setupTwoUsers`) so we
 * inherit the established multi-context login + project-creation pattern
 * (see `apps/web/tests/helpers/mentions-setup.ts`). Both users must be
 * members of the same org (default: `default-org`) and pre-seeded admins.
 *
 * Strategy:
 *   - User A seeds one turn directly through the live oRPC API (the
 *     fastest path to a known-persisted SHARED conversation). We do NOT
 *     drive a model round-trip here — that's I.2's job — because the
 *     property under test is the cross-user visibility predicate, not
 *     the LLM proxy.
 *   - User B navigates to the same document and opens the History drawer.
 *   - Assert User B's drawer lists the conversation, attributes it to
 *     User A, and renders the "Shared" visibility chip.
 */

import { expect, test } from "@playwright/test";
import {
	setupTwoUsers,
	TEST_USER_A,
	teardown,
} from "../helpers/mentions-setup";
import {
	listConversationsForDocument,
	removeConversation,
	resolveCurrentUserId,
	seedConversation,
} from "./_fixtures";

// Two sign-ins + project bootstrap can run long on a cold dev runner.
test.setTimeout(180_000);

const haveCreds = process.env.E2E_USER_A_EMAIL && process.env.E2E_USER_B_EMAIL;

test.describe("document assistant — two-user shared visibility", () => {
	test.skip(
		!haveCreds,
		"Set E2E_USER_A_EMAIL / E2E_USER_B_EMAIL (+ matching passwords) to run this suite — see helpers/mentions-setup.ts.",
	);

	test("user B sees user A's SHARED conversation in their History drawer (AC-3)", async ({
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
			// ------------------------------------------------------
			// User A: seed a SHARED conversation with one user turn.
			// `seedConversation` walks the live API path so the
			// visibility predicate, audit emission, and XOR scoping
			// are all real — not mocked.
			// ------------------------------------------------------
			const scope = {
				kind: "org" as const,
				organizationId: project.organizationId,
				organizationSlug: orgSlug,
				projectId: project.projectId,
				documentId: doc.documentId,
				documentRefKind: "PROJECT_DOCUMENT" as const,
			};

			const userAId = await resolveCurrentUserId(pageA.request);

			seededConversationId = await seedConversation(
				pageA.request,
				scope,
				/* turns */ 1,
				{ requestedVisibility: "SHARED" },
			);

			// ------------------------------------------------------
			// User B: navigate to the document, open the History
			// drawer, assert the conversation is visible.
			//
			// We sanity-check via the listForDocument API first
			// (the same procedure the drawer uses) so a UI-render
			// flake doesn't mask a real isolation regression.
			// ------------------------------------------------------
			const userBVisible = await listConversationsForDocument(
				pageB.request,
				scope,
			);
			expect(
				userBVisible.find(
					(c) =>
						c.conversationId === seededConversationId &&
						c.authorId === userAId &&
						c.visibility === "SHARED",
				),
				"User B's listForDocument response MUST include user A's SHARED conversation (spec §3.5 FR-19, AC-3).",
			).toBeTruthy();

			// Drive User B through the UI so we also catch any
			// drawer-render regression. Open the document → click
			// the history icon → assert the conversation row
			// renders with the right author + visibility chips.
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

			// The author chip identifies the conversation row by
			// the author's display name (set in mentions-setup as
			// TEST_USER_A.name, e.g. "E2E User A"). We match on a
			// case-insensitive substring so a future name override
			// in the seeded account doesn't break the assertion.
			const authorRow = drawer.getByText(
				new RegExp(TEST_USER_A.name.split(" ")[0], "i"),
			);
			await expect(authorRow.first()).toBeVisible({ timeout: 10_000 });

			// At least one "Shared" visibility chip MUST be in the
			// drawer — that's the visibility-chip render from
			// `CopilotHistoryDrawer.tsx` VisibilityBadge (FR-13).
			const sharedChips = drawer.getByText(/^shared$/i);
			await expect(sharedChips.first()).toBeVisible({ timeout: 10_000 });
		} finally {
			if (seededConversationId) {
				// Cleanup via User A's session so the row delete
				// flows through the ownership predicate.
				await removeConversation(
					contextA.request,
					seededConversationId,
				);
			}
			await teardown(fixture);
		}
	});
});
