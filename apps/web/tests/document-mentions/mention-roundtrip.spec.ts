import { expect, test } from "@playwright/test";
import {
	TEST_USER_A,
	setupTwoUsers,
	teardown,
} from "../helpers/mentions-setup";

test("mention survives save+reload and dispatches notification", async ({
	browser,
}) => {
	const setup = await setupTwoUsers(browser);
	const { pageA, pageB, contextB, orgSlug, doc } = setup;

	// -----------------------------------------------------------------------
	// Resolve User B's ID from their authenticated session so we can assert
	// the chip's data-id attribute without hardcoding a DB row ID.
	// -----------------------------------------------------------------------
	const sessionResp = await pageB.request.get("/api/auth/get-session");
	expect(sessionResp.ok()).toBeTruthy();
	const sessionBody = await sessionResp.json();
	const userBId: string = sessionBody?.user?.id;
	expect(userBId).toBeTruthy();

	const userBName: string =
		sessionBody?.user?.name ?? sessionBody?.user?.email ?? "";

	// -----------------------------------------------------------------------
	// 1. User A opens the freshly-created document and inserts a @mention of B.
	// -----------------------------------------------------------------------
	await pageA.goto(doc.documentUrl);

	// Wait for TipTap to mount and be editable.
	await pageA.locator(".ProseMirror").waitFor({ state: "visible" });
	await pageA.locator(".ProseMirror").click();

	// Type trigger text and activate the mention suggestion popover.
	await pageA.keyboard.type("Hello @");

	// Wait for the mention suggestion popover to appear and click User B's entry.
	await pageA
		.getByRole("option", { name: new RegExp(userBName, "i") })
		.first()
		.waitFor({ state: "visible", timeout: 10_000 });
	await pageA
		.getByRole("option", { name: new RegExp(userBName, "i") })
		.first()
		.click();

	await pageA.keyboard.type(" please review.");

	// Wait for the document save. The editor auto-saves or we trigger it.
	// DocumentEditor debounce-saves on content change (watch for the PATCH).
	await pageA.waitForResponse(
		(r) =>
			r.url().includes("/projects/") &&
			r.url().includes("/documents/") &&
			r.request().method() === "PATCH" &&
			r.status() === 200,
		{ timeout: 30_000 },
	);

	// -----------------------------------------------------------------------
	// 2. Reload — the mention chip must survive the Markdown round-trip.
	//    Pre-fix: Turndown strips the span → chip lost on reload.
	//    Post-fix: Turndown serializes + MarkdownIt deserializes the span.
	// -----------------------------------------------------------------------
	await pageA.reload();

	// Wait for ProseMirror to become visible again (editor rehydrated).
	await pageA.locator(".ProseMirror").waitFor({ state: "visible" });

	const chip = pageA
		.locator('.ProseMirror span[data-type="mention"]')
		.first();
	await expect(chip).toBeVisible({ timeout: 10_000 });
	await expect(chip).toHaveAttribute("data-id", userBId);

	const anchorId = await chip.getAttribute("data-mention-id");
	expect(anchorId).toMatch(/^m_/);

	// -----------------------------------------------------------------------
	// 3. User B sees a notification, clicks it, and lands on the anchor.
	// -----------------------------------------------------------------------
	// Navigate User B to the org dashboard where the notification bell lives.
	await pageB.goto(`/app/${orgSlug}`);

	// Click the notification bell.
	await pageB
		.getByRole("button", { name: /notification/i })
		.first()
		.click();

	// Locate the mention notification.
	// Title format: "${actorName} mentioned you in ${documentTitle}"
	const notification = pageB.getByRole("link", {
		name: new RegExp(`${TEST_USER_A.name}.*mentioned you`, "i"),
	});
	await expect(notification).toBeVisible({ timeout: 15_000 });
	await notification.click();

	// After clicking, the page should navigate to the document URL with
	// an anchor fragment (#m-<rand>).
	await expect(pageB).toHaveURL(/#m-/, { timeout: 20_000 });

	// The mentioned chip must be scrolled into view.
	await expect(
		pageB.locator(
			`.ProseMirror span[data-type="mention"][data-id="${userBId}"]`,
		),
	).toBeInViewport({ timeout: 10_000 });

	await teardown(setup);
});
