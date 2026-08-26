/**
 * Task 14 — Document @-mentions E2E: Deactivated-chip rendering
 *
 * Spec: `docs/superpowers/specs/2026-05-11-document-mentions-hardening-design.md`
 *
 * Asserts that after an org member is removed, their @-mention chip renders
 * with the inactive treatment:
 *
 *   AC-1  After removal, chip has the `.mention--inactive` CSS class.
 *   AC-2  Chip aria-label includes "no longer active".
 *   AC-3  Clicking the chip does NOT navigate (URL unchanged).
 *
 * HOW IT WORKS
 * ------------
 * 1. User A creates a document, inserts a @B mention, and saves.
 * 2. User B is removed from the org via the Better Auth HTTP API.
 * 3. The page is reloaded.  The DocumentEditor re-runs the
 *    `resolveActiveMentions` query on load, which now excludes User B.
 * 4. `MentionNodeView` receives an empty (not null) activeIds Set from the
 *    context and renders `mention--inactive` for B's chip.
 *
 * RUNNING
 * -------
 *   pnpm --filter @repo/web e2e tests/document-mentions/deactivated-chip.spec.ts
 *
 * NOTE: Because member removal is irreversible (on the dev org), this test
 * uses the TEST_USER_B account as the removable member.  Re-running the test
 * requires re-adding User B to the org (e.g., via the UI settings page or the
 * seed script).  On CI, use ephemeral orgs seeded per test run.
 */

import { expect, test } from "@playwright/test";
import {
	TEST_USER_B,
	setupTwoUsers,
	removeMemberFromOrg,
	teardown,
} from "../helpers/mentions-setup";

test.setTimeout(90_000);

test("chip for removed org member renders greyed and is not clickable", async ({
	browser,
}) => {
	const setup = await setupTwoUsers(browser);
	const { pageA, doc, project } = setup;

	try {
		// ------------------------------------------------------------------
		// Step 1 — User A opens the document and inserts a @B mention.
		// ------------------------------------------------------------------
		await pageA.goto(doc.documentUrl);
		await pageA.waitForLoadState("networkidle");

		const editor = pageA.locator(".ProseMirror").first();
		await expect(editor).toBeVisible({ timeout: 15_000 });

		await editor.click();
		await pageA.keyboard.type("Hi @");

		const suggestion = pageA.getByRole("option", {
			name: new RegExp(TEST_USER_B.name.split(" ")[0], "i"),
		});
		await expect(suggestion).toBeVisible({ timeout: 10_000 });
		await suggestion.first().click();

		await pageA.keyboard.type(" please review.");

		// Save the document and wait for the PATCH to complete.
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
		// Step 2 — Remove User B from the org via the Better Auth HTTP API.
		//
		// `removeMemberFromOrg` calls POST /api/auth/organization/remove-member
		// using the User A session (which is an org owner/admin).  User B's
		// member row is deleted from the `member` table.
		// ------------------------------------------------------------------
		await removeMemberFromOrg(pageA, {
			memberIdOrEmail: TEST_USER_B.email,
			organizationId: project.organizationId,
		});

		// ------------------------------------------------------------------
		// Step 3 — Reload the document page so the editor re-runs its
		//          `resolveActiveMentions` query with the updated membership.
		// ------------------------------------------------------------------
		const [resolveResponse] = await Promise.all([
			pageA.waitForResponse(
				(res) =>
					// The resolveActiveMentions procedure goes through the oRPC
					// RPC link at /api/rpc with a path segment containing the
					// procedure name, OR via the REST route if one is declared.
					// The procedure uses .query() with no .route() so it travels
					// through the RPCLink: POST /api/rpc/projects/documents/resolveActiveMentions
					(res.url().includes("resolveActiveMentions") ||
						res.url().includes("/api/rpc")) &&
					res.status() === 200,
				{ timeout: 15_000 },
			),
			pageA.reload({ waitUntil: "domcontentloaded" }),
		]);
		expect(resolveResponse.status()).toBe(200);

		// Wait for the editor to fully hydrate so TipTap re-renders chips.
		const editorReady = pageA.locator(".ProseMirror").first();
		await expect(editorReady).toBeVisible({ timeout: 15_000 });

		// ------------------------------------------------------------------
		// Step 4 — Assert the chip has the `.mention--inactive` class.
		// ------------------------------------------------------------------

		// The mention chip is rendered by MentionNodeView as:
		//   <span class="mention mention--inactive" aria-label="mention: <name> (no longer active)">
		//     @Name
		//   </span>
		// The NodeViewWrapper adds a wrapper; we locate by the css class.
		const chip = pageA
			.locator(".ProseMirror .mention")
			.filter({
				hasText: new RegExp(`@${TEST_USER_B.name.split(" ")[0]}`),
			})
			.first();

		await expect(chip).toBeVisible({ timeout: 10_000 });

		// AC-1 — inactive CSS class.
		await expect(chip).toHaveClass(/mention--inactive/, { timeout: 8_000 });

		// AC-2 — aria-label includes "no longer active".
		await expect(chip).toHaveAttribute("aria-label", /no longer active/i);

		// ------------------------------------------------------------------
		// Step 5 — AC-3: clicking the chip must NOT navigate.
		// ------------------------------------------------------------------
		const urlBefore = pageA.url();

		// Click the chip. MentionNodeView is a non-interactive span — it
		// should not trigger navigation. The active chip counterpart also
		// doesn't navigate (it's just text), so this asserts no navigation
		// hook fires on click regardless.
		await chip.click({ force: true });

		// Wait a brief settle time for any unintended navigation to begin.
		// We use waitForURL with a timeout that purposely short-circuits to
		// detect fast navigations, then assert the URL is unchanged.
		await pageA
			.waitForURL((url) => url.toString() !== urlBefore, {
				timeout: 500,
			})
			.catch(() => {
				/* expected: no navigation fires */
			});

		expect(pageA.url()).toBe(urlBefore);
	} finally {
		await teardown(setup);
	}
});
