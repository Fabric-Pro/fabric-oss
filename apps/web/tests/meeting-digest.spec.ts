import { expect, test } from "@playwright/test";

/**
 * Meeting Digest — E2E happy path.
 *
 * Deferred / seed-gated, following the repo convention (see
 * project-invitation-login.spec.ts): these tests only run when a seeded,
 * authenticated project is provided via env. They require the full app +
 * Postgres running and a project that has at least one linked Teams meeting
 * with a synced transcript. Without the seed they skip (they do NOT pass
 * silently) — matching how the other project E2E specs gate on seed data.
 *
 * To enable, set:
 *   E2E_MEETING_DIGEST_PROJECT_URL — the authed project page URL for a project
 *     that has at least one included meeting in its digest, e.g.
 *     https://localhost:3001/app/<org>/projects/<projectId>
 * and provide a Playwright storageState with a logged-in session (see
 * playwright.config.ts / existing specs for the auth-state helper).
 */

const projectUrl = process.env.E2E_MEETING_DIGEST_PROJECT_URL;

test.describe("Meeting Digest", () => {
	test.skip(
		!projectUrl,
		"Set E2E_MEETING_DIGEST_PROJECT_URL (authed project with a linked meeting) to enable",
	);

	test("opens the Meeting Digest tab and shows the calendar canvas", async ({
		page,
	}) => {
		if (!projectUrl) {
			return;
		}
		await page.goto(projectUrl);

		await page.getByRole("tab", { name: "Meeting Digest" }).click();

		// The custom calendar grid renders weekday headers.
		await expect(page.getByText("Mon", { exact: true })).toBeVisible();
	});

	test("opens a meeting detail sheet from a calendar badge", async ({
		page,
	}) => {
		if (!projectUrl) {
			return;
		}
		await page.goto(projectUrl);
		await page.getByRole("tab", { name: "Meeting Digest" }).click();

		// Meeting badges use the primary-tinted button style in CalendarCanvas.
		const badge = page.locator("button.bg-primary\\/10").first();
		if ((await badge.count()) === 0) {
			test.skip(
				true,
				"Seeded project has no meeting badge in the current month",
			);
			return;
		}
		await badge.click();

		// The detail Sheet exposes a Summary section.
		await expect(page.getByText("Summary")).toBeVisible();
	});

	// Negative test only: the flag is off by default in CI (not enabled in
	// Admin → Feature Flags, and FABRIC_FEATURE_PERSONAL_MEETINGS is unset),
	// so this asserts the Meeting Digest still renders with no "All meetings"
	// control. The positive path — flag on, filter present, personal rows
	// loading from a real Microsoft-connected account — cannot be exercised
	// here because CI has no Microsoft-connected test account. That gap is
	// deliberate, not an oversight; see the verification checklist in
	// .superpowers/sdd/task-10-brief.md for the manual steps that cover it.
	test("does not render an All meetings control when the personal meetings flag is off", async ({
		page,
	}) => {
		if (!projectUrl) {
			return;
		}
		await page.goto(projectUrl);
		await page.getByRole("tab", { name: "Meeting Digest" }).click();

		// The custom calendar grid still renders normally.
		await expect(page.getByText("Mon", { exact: true })).toBeVisible();

		// The Team/All meetings toggle is absent unless PERSONAL_MEETINGS is
		// enabled in Admin → Feature Flags (or seeded via
		// FABRIC_FEATURE_PERSONAL_MEETINGS).
		await expect(
			page.getByRole("button", { name: "All meetings" }),
		).toHaveCount(0);
	});

	test("opens the meeting picker from the digest without leaving the page", async ({
		page,
	}) => {
		if (!projectUrl) {
			return;
		}
		await page.goto(projectUrl);
		await page.getByRole("tab", { name: "Meeting Digest" }).click();
		const urlBefore = page.url();

		await page.getByRole("button", { name: /add meeting/i }).click();

		await expect(
			page.getByRole("dialog", { name: /link meetings/i }),
		).toBeVisible();
		expect(page.url()).toBe(urlBefore);
	});

	// Real-browser coverage of the #1898 accessibility NFR — focus trap in the
	// modal and focus return to the opener on close. jsdom can't verify focus
	// restoration, so this half lives here rather than in the RTL a11y test.
	test("keyboard: focus is trapped in the picker and returns to the opener on close", async ({
		page,
	}) => {
		if (!projectUrl) {
			return;
		}
		await page.goto(projectUrl);
		await page.getByRole("tab", { name: "Meeting Digest" }).click();

		const opener = page
			.getByRole("button", { name: /add meeting/i })
			.first();
		await opener.focus();
		await page.keyboard.press("Enter");

		const dialog = page.getByRole("dialog", { name: /link meetings/i });
		await expect(dialog).toBeVisible();

		// Focus trap: after several Tabs, focus stays inside the dialog rather
		// than escaping to the page behind it.
		for (let i = 0; i < 8; i++) {
			await page.keyboard.press("Tab");
			const focusInDialog = await dialog.evaluate((el) =>
				el.contains(document.activeElement),
			);
			expect(focusInDialog).toBe(true);
		}

		// Focus return: Escape closes the dialog and focus lands back on the
		// control that opened it — a keyboard user is not stranded.
		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
		await expect(opener).toBeFocused();
	});
});
