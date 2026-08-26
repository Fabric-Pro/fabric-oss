/**
 * Task 13 — Document @-mentions E2E: Dedup-while-unread
 *
 * Spec: `docs/superpowers/specs/2026-05-11-document-mentions-hardening-design.md`
 *
 * Asserts the "deduplicate while unread" behaviour:
 *
 *   Phase 1 (1st mention + 2nd mention, B still unread)
 *     - A inserts a @B mention → saves.  B's notification panel shows 1 row.
 *     - A inserts a SECOND @B mention in the same doc → saves.
 *     - B's notification panel still shows exactly 1 row  (dedup supresses a
 *       duplicate while the first notification is unread).
 *
 *   Phase 2 (B reads the notification, A inserts a 3rd mention)
 *     - B clicks the notification row (marks it read via `onSelect`).
 *     - A inserts a THIRD @B mention → saves.
 *     - B reopens the panel: now sees 2 rows (the read one + a fresh unread one).
 *
 * This test is the key functional gate for the `dedupePolicy: "unreadOnly"`
 * logic in `notification-service.ts`.
 *
 * RUNNING
 * -------
 *   pnpm --filter @repo/web e2e tests/document-mentions/dedup-unread.spec.ts
 */

import { expect, test } from "@playwright/test";
import {
	TEST_USER_A,
	TEST_USER_B,
	setupTwoUsers,
	teardown,
} from "../helpers/mentions-setup";

test.setTimeout(120_000);

test("re-mention while unread shows one row; mention after read shows two rows", async ({
	browser,
}) => {
	const setup = await setupTwoUsers(browser);
	const { pageA, pageB, doc, orgSlug } = setup;

	try {
		await pageA.goto(doc.documentUrl);
		await pageA.waitForLoadState("networkidle");

		const editor = pageA.locator(".ProseMirror").first();
		await expect(editor).toBeVisible({ timeout: 15_000 });

		// Helper: insert a @B mention and wait for the save PATCH to land.
		async function insertMentionAndSave(): Promise<void> {
			await editor.click();
			// Move to the end of the document before inserting.
			await pageA.keyboard.press("End");
			await pageA.keyboard.type(" @");

			const suggestion = pageA.getByRole("option", {
				name: new RegExp(TEST_USER_B.name.split(" ")[0], "i"),
			});
			await expect(suggestion).toBeVisible({ timeout: 10_000 });
			await suggestion.first().click();

			await pageA.keyboard.type(` (${Date.now()})`);

			const [saveResponse] = await Promise.all([
				pageA.waitForResponse(
					(res) =>
						res.url().includes("/api/projects/") &&
						res.url().includes("/documents/") &&
						res.request().method() === "PATCH" &&
						res.status() === 200,
					{ timeout: 15_000 },
				),
				pageA.getByRole("button", { name: /save document/i }).click(),
			]);
			expect(saveResponse.status()).toBe(200);
		}

		// -------------------------------------------------------------------
		// Phase 1: Two mentions while B's notification is still unread.
		//          Expected: only one notification row.
		// -------------------------------------------------------------------
		await insertMentionAndSave();
		await insertMentionAndSave();

		// User B opens the notification panel.
		await pageB.goto(`/app/${orgSlug}`);
		await pageB.waitForLoadState("networkidle");

		const bellButton = pageB.getByRole("button", {
			name: /notifications/i,
		});
		await expect(bellButton).toBeVisible({ timeout: 10_000 });
		await bellButton.click();

		// Filter to only the "mentioned you" rows to avoid counting unrelated notifications.
		const mentionRows = pageB.getByRole("link").filter({
			hasText: new RegExp(`${TEST_USER_A.name}.*mentioned you`, "i"),
		});

		// Give the backend a moment to process both saves before asserting.
		// waitForResponse above ensures we only assert once the saves have hit
		// the DB, but the RPC response returning does not guarantee the async
		// fan-out notification write has completed. We use a retry-based expect
		// to allow up to 5 s for the notifications to propagate.
		await expect(mentionRows).toHaveCount(1, { timeout: 8_000 });

		// -------------------------------------------------------------------
		// Phase 2: B reads the notification, then A inserts a 3rd mention.
		//          Expected: two rows.
		// -------------------------------------------------------------------

		// Click the notification to mark it as read (onSelect handler).
		await mentionRows.first().click();

		// Navigate back to the org page so we can reopen the notification panel.
		await pageB.goto(`/app/${orgSlug}`);
		await pageB.waitForLoadState("networkidle");

		// A inserts a third mention (B's previous notification is now read).
		await insertMentionAndSave();

		// B reopens the notification panel.
		const bellButton2 = pageB.getByRole("button", {
			name: /notifications/i,
		});
		await expect(bellButton2).toBeVisible({ timeout: 10_000 });
		await bellButton2.click();

		// Now we expect 2 rows: the previously-read one + the new unread one.
		// The default tab is "All" so both read and unread rows are visible.
		const mentionRows2 = pageB.getByRole("link").filter({
			hasText: new RegExp(`${TEST_USER_A.name}.*mentioned you`, "i"),
		});
		await expect(mentionRows2).toHaveCount(2, { timeout: 8_000 });
	} finally {
		await teardown(setup);
	}
});
