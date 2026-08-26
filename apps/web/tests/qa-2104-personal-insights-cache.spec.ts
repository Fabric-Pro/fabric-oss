import * as path from "node:path";
import { expect, test } from "@playwright/test";

/**
 * #2104 — opt-in on-device caching for personal meeting summaries.
 * Full QA run against a deployed environment, producing screenshots.
 *
 * Deliberately one long serial test rather than many: every check builds on the
 * state the previous one left behind (consent granted, cache warmed, then
 * purged), and splitting them would either re-do the expensive cold summarise
 * or quietly test a state nobody set up.
 *
 * PRECONDITIONS — the run fails loudly rather than skipping if these are unmet,
 * because a silent skip in a QA report reads as a pass:
 *   QA_BASE_URL       deployed host (the PR preview — NOT staging, which runs master)
 *   QA_PROJECT_ID     a project whose owner has a personal meeting WITH a transcript
 *   E2E_USER_EMAIL / E2E_USER_PASSWORD   (consumed by qa-2104-auth.setup.ts)
 *   PERSONAL_MEETINGS and PERSONAL_INSIGHTS_CACHE both enabled for this user.
 */

const PROJECT_ID = process.env.QA_PROJECT_ID;
const SHOTS = path.join(__dirname, "..", "qa-2104-shots");

/** Sequential screenshot names so the report reads in order. */
let shotIndex = 0;

test.describe.configure({ mode: "serial", timeout: 300_000 });

test("#2104 personal insights cache — full QA", async ({ page }) => {
	expect(
		PROJECT_ID,
		"Set QA_PROJECT_ID to a project with a transcript-bearing personal meeting",
	).toBeTruthy();

	const shot = async (name: string) => {
		shotIndex += 1;
		const file = path.join(
			SHOTS,
			`${String(shotIndex).padStart(2, "0")}-${name}.png`,
		);
		await page.screenshot({ path: file, fullPage: false });
		return file;
	};

	// Every request the app makes to the insights procedure. The central claim
	// of this feature is that a warm open makes ZERO of these, so it is counted
	// rather than eyeballed.
	const insightsCalls: string[] = [];
	page.on("request", (req) => {
		if (req.url().includes("getPersonalInsights")) {
			insightsCalls.push(`${req.method()} ${req.url()}`);
		}
	});
	const countSince = (mark: number) => insightsCalls.length - mark;

	const readCacheBlobs = () =>
		page.evaluate(() =>
			Object.keys(localStorage)
				.filter((k) =>
					k.startsWith("meeting-digest-personal-insights:"),
				)
				.map((k) => ({ key: k, value: localStorage.getItem(k) })),
		);

	// ── 1. Open the Meeting Digest tab ────────────────────────────────────────
	await page.goto(`/app/projects/${PROJECT_ID}`);
	await page.getByRole("tab", { name: "Meeting Digest" }).click();
	await expect(page.getByText("Mon", { exact: true })).toBeVisible({
		timeout: 30_000,
	});
	await shot("digest-tab");

	// ── 2. Switch to All meetings and grant the #1899 consent ────────────────
	await page.getByText("All meetings", { exact: true }).click();
	const enableBtn = page.getByRole("button", {
		name: /enable personal meetings/i,
	});
	if (await enableBtn.isVisible().catch(() => false)) {
		await shot("consent-panel-before-opt-in");
		await enableBtn.click();
	}
	await expect(
		page.getByText(/transcripts are never stored/i).first(),
	).toBeVisible();
	await shot("personal-meetings-enabled");

	// ── 3. The cache toggle is present (proves PERSONAL_INSIGHTS_CACHE is on) ─
	const rememberBtn = page.getByRole("button", {
		name: /remember summaries/i,
	});
	await expect(
		rememberBtn,
		'"Remember summaries" not found — enable the PERSONAL_INSIGHTS_CACHE flag for this user before running QA',
	).toBeVisible({ timeout: 15_000 });
	await shot("cache-toggle-offered");

	// ── 4. Opt in to caching ─────────────────────────────────────────────────
	await rememberBtn.click();
	await expect(
		page.getByRole("button", { name: /forget summaries/i }),
	).toBeVisible();
	await shot("cache-opted-in");

	// ── 5. Cold summarise — expect exactly one API call ──────────────────────
	// Month view renders a personal row as an icon with an accessible label
	// ("Personal meeting"), not a text badge — the text badge only exists in
	// the Agenda view. Match on the icon's label, present in both views, so
	// the spec works in the default Month view (2026-08-03 regression run,
	// testing-infra note).
	const personalRow = page
		.locator('button:has([aria-label="Personal meeting"])')
		.first();
	await expect(
		personalRow,
		"No personal meeting row found in this month — pick a project/month that has one",
	).toBeVisible({ timeout: 15_000 });
	await personalRow.click();

	const summariseBtn = page.getByRole("button", {
		name: /summarise meeting/i,
	});
	await expect(summariseBtn).toBeVisible();
	await shot("sheet-open-before-summarise");

	const coldMark = insightsCalls.length;
	const coldStart = Date.now();
	await summariseBtn.click();
	await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible({
		timeout: 120_000,
	});
	const coldMs = Date.now() - coldStart;
	const coldCalls = countSince(coldMark);
	await shot("cold-summary-rendered");

	expect(
		coldCalls,
		`cold summarise should issue exactly 1 getPersonalInsights call, saw ${coldCalls}`,
	).toBe(1);

	// The copy must now tell the truth about persistence.
	await expect(page.getByText(/saved in this browser/i)).toBeVisible();
	await expect(page.getByText(/isn't saved/i)).toHaveCount(0);

	// ── 6. The blob holds derived text only — no join URL, no transcript ─────
	const blobs = await readCacheBlobs();
	expect(blobs.length, "expected a cached blob after summarising").toBe(1);
	const blobText = blobs[0].value ?? "";
	expect(
		blobText.includes("meetup-join"),
		"join URL (a capability URL) must never be stored",
	).toBe(false);
	expect(blobs[0].key).toMatch(
		/^meeting-digest-personal-insights:[^:]+:[^:]+$/,
	);

	// ── 7. Warm re-open in the SAME session — expect ZERO API calls ──────────
	await page.keyboard.press("Escape");
	const warmMark = insightsCalls.length;
	await personalRow.click();
	// The explicit-ask gate must survive a cache hit: nothing until the click.
	await expect(page.getByRole("heading", { name: "Summary" })).toHaveCount(0);
	await shot("warm-reopen-requires-click");
	await page.getByRole("button", { name: /summarise meeting/i }).click();
	await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible({
		timeout: 15_000,
	});
	const warmCalls = countSince(warmMark);
	await shot("warm-summary-from-cache");
	expect(
		warmCalls,
		`warm re-open must issue 0 getPersonalInsights calls, saw ${warmCalls}`,
	).toBe(0);

	// ── 8. Survives a full reload (proves localStorage, not just memory) ─────
	await page.reload();
	await page.getByRole("tab", { name: "Meeting Digest" }).click();
	await page.getByText("All meetings", { exact: true }).click();
	const reloadMark = insightsCalls.length;
	await page.locator('button:has-text("Personal")').first().click();
	await page.getByRole("button", { name: /summarise meeting/i }).click();
	await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible({
		timeout: 15_000,
	});
	const reloadCalls = countSince(reloadMark);
	await shot("after-reload-still-cached");
	expect(
		reloadCalls,
		`after reload the cache must still serve it, saw ${reloadCalls} calls`,
	).toBe(0);

	// ── 9. Forget summaries purges immediately ───────────────────────────────
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: /forget summaries/i }).click();
	const afterForget = await readCacheBlobs();
	await shot("after-forget-summaries");
	expect(
		afterForget.length,
		"turning caching off must purge every entry for this project",
	).toBe(0);

	// ── 10. Turning personal meetings off also purges ────────────────────────
	await page.getByRole("button", { name: /remember summaries/i }).click();
	await page.locator('button:has-text("Personal")').first().click();
	await page.getByRole("button", { name: /summarise meeting/i }).click();
	await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible({
		timeout: 120_000,
	});
	await page.keyboard.press("Escape");
	expect((await readCacheBlobs()).length).toBe(1);

	await page.getByRole("button", { name: /^turn off$/i }).click();
	const afterTurnOff = await readCacheBlobs();
	await shot("after-personal-meetings-off");
	expect(
		afterTurnOff.length,
		"turning personal meetings off must purge cached summaries too",
	).toBe(0);

	// eslint-disable-next-line no-console
	console.log(
		`\n#2104 QA timings — cold summarise ${coldMs}ms / 1 call; warm 0 calls; post-reload 0 calls\n` +
			`Screenshots: ${SHOTS}\n`,
	);
});
