/**
 * Task 12 — Document @-mentions E2E: Golden Path
 *
 * Spec: `docs/superpowers/specs/2026-05-11-document-mentions-hardening-design.md`
 *
 * Asserts the end-to-end happy path:
 *
 *   AC-1  User A types "@" in the document, picks User B from the suggestion
 *         popover, saves the document.
 *   AC-2  User B's Notification Bell shows a new notification.
 *   AC-3  B opens the notification and lands on the document URL with a
 *         `#m-<anchor>` fragment.
 *   AC-4  The mentioned chip is scrolled into viewport.
 *   AC-5  A polite live region announces "Jumped to mention in document."
 *
 * INFRASTRUCTURE NOTES
 * --------------------
 * - Uses two browser contexts (User A = author, User B = recipient) from the
 *   `mentions-setup.ts` helper.  Both users are pre-seeded admin accounts
 *   already members of the "example-org" dev org.
 * - A fresh project + document is created via oRPC REST before each test.
 * - No mock interceptors — all assertions exercise real API + real DB.
 *
 * RUNNING
 * -------
 *   pnpm --filter @repo/web e2e tests/document-mentions/golden-path.spec.ts
 *
 * The playwright.config.ts webServer block builds + starts the app automatically.
 * If the app is already running on port 3001, `reuseExistingServer: true` reuses it.
 */

import { expect, test } from "@playwright/test";
import {
	TEST_USER_A,
	TEST_USER_B,
	setupTwoUsers,
	teardown,
} from "../helpers/mentions-setup";

// Extend the default 30 s timeout — two sign-ins + app init can be slow.
test.setTimeout(90_000);

test("@-mention triggers notification with anchor link (golden path)", async ({
	browser,
}) => {
	const setup = await setupTwoUsers(browser);
	const { pageA, pageB, doc, orgSlug } = setup;

	try {
		// ------------------------------------------------------------------
		// Step 1 — User A opens the document and types an @-mention of User B.
		// ------------------------------------------------------------------
		await pageA.goto(doc.documentUrl);
		await pageA.waitForLoadState("networkidle");

		const editor = pageA.locator(".ProseMirror").first();
		await expect(editor).toBeVisible({ timeout: 15_000 });

		// Click into the editor and type enough so the suggestion char "@"
		// triggers the popover.
		await editor.click();
		// Wait for TipTap to be ready before typing.
		await editor.waitFor({ state: "visible" });
		await pageA.keyboard.type("Hi ");
		await pageA.keyboard.type("@");

		// The suggestion popover should appear with User B in the list.
		const suggestion = pageA.getByRole("option", {
			name: new RegExp(TEST_USER_B.name.split(" ")[0], "i"),
		});
		await expect(suggestion).toBeVisible({ timeout: 10_000 });
		await suggestion.first().click();

		// Type some text after the mention so the content is non-trivial.
		await pageA.keyboard.type(" please review this.");

		// ------------------------------------------------------------------
		// Step 2 — Save the document.
		//
		// The DocumentEditor has an explicit "Save document" button with
		// aria-label="Save document". Click it and wait for the REST call to
		// complete (PATCH /api/projects/<id>/documents/<id>).
		// ------------------------------------------------------------------
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

		// ------------------------------------------------------------------
		// Step 3 — User B opens the Notification Bell and checks for the row.
		// ------------------------------------------------------------------
		await pageB.goto(`/app/${orgSlug}`);
		await pageB.waitForLoadState("networkidle");

		// The bell button aria-label is "Notifications" when unread count is 0
		// and "{n} unread notifications" when there are unread items.
		// Use a partial match so both states match.
		const bellButton = pageB.getByRole("button", {
			name: /notifications/i,
		});
		await expect(bellButton).toBeVisible({ timeout: 10_000 });
		await bellButton.click();

		// The popover lists notifications; find the mention row.  The title is:
		//   "<UserA name> mentioned you in <document title>"
		const mentionRow = pageB.getByRole("link").filter({
			hasText: new RegExp(`${TEST_USER_A.name}.*mentioned you`, "i"),
		});
		await expect(mentionRow.first()).toBeVisible({ timeout: 15_000 });

		// ------------------------------------------------------------------
		// Step 4 — B clicks the notification and lands on the anchor URL.
		// ------------------------------------------------------------------
		await mentionRow.first().click();

		// URL should include the document path AND a #m- fragment.
		await expect(pageB).toHaveURL(new RegExp(`${doc.documentId}.*#m-`), {
			timeout: 15_000,
		});

		// ------------------------------------------------------------------
		// Step 5 — The chip is in viewport.
		// ------------------------------------------------------------------
		const chip = pageB.locator(".ProseMirror .mention").first();
		await expect(chip).toBeVisible({ timeout: 15_000 });
		await expect(chip).toBeInViewport({ timeout: 10_000 });

		// ------------------------------------------------------------------
		// Step 6 — The polite live region announces the navigation to screen
		//          readers.  The DocumentEditor renders:
		//            <div role="status" aria-live="polite" class="sr-only">
		//              Jumped to mention in document.
		//            </div>
		// ------------------------------------------------------------------
		const liveRegion = pageB.locator('[role="status"][aria-live="polite"]');
		// There may be several; the one with the scroll announcement text is our target.
		await expect(
			liveRegion.filter({ hasText: /jumped to mention/i }),
		).toBeVisible({ timeout: 10_000 });
	} finally {
		await teardown(setup);
	}
});
