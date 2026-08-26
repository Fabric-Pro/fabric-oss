/**
 * Stop / Cancel AI Generation — Loom Direct standalone E2E
 *
 * Spec: `specs/2026-05-09-stop-ai-generation/spec.md` § 9.1 (Task 6.3).
 *
 * Surface C in `spec.md` § 1.3: the standalone Loom page at
 * `/app/agents/fabric-ai` with the `Direct` tab active. This page mounts
 * `FabricDirectChat` directly (no launcher chrome), so the morph button
 * and the Esc binding are owned by the chat component itself.
 *
 * This spec exercises:
 *   - AC-1  — Stop halts the in-flight generation immediately, partial
 *             response is shown.
 *   - AC-2  — While idle the Send button is shown (no Stop control).
 *   - AC-3  — User can submit a new prompt right away.
 *   - AC-4  — On a server cancel-failure, the UI does not break.
 *   - AC-5  — Cancelled message renders with the `Stopped` label.
 *   - AC-10 — On a 5xx from the cancel endpoint, the
 *             `chat.stopFailed.toast` appears AND the visual state does
 *             NOT revert.
 *
 * Implementation note for AC-10
 * -----------------------------
 * `useDirectStream.stop()` only fires the cancel POST when
 * `executionIdRef.current` is set (i.e. after the `started` SSE event has
 * been processed). The slow-stream helper emits `started` on the very
 * first chunk so the executionId is captured before the user clicks Stop.
 */

import { expect, test } from "@playwright/test";
import {
	expectInputUnblocked,
	getStopButton,
	getStoppedCaption,
	installSlowStream,
} from "./helpers/stop-ai";

const LOOM_PATH = "/app/agents/fabric-ai";

test.describe("Stop AI generation — Loom Direct standalone page", () => {
	test.beforeEach(async ({ page }) => {
		await installSlowStream(page, {
			endpoint: "fabric-ai-stream",
			executionIdPrefix: "direct-chat-",
		});
	});

	test("AC-2 — idle state shows Send, not Stop", async ({ page }) => {
		await page.goto(LOOM_PATH);
		await page.waitForLoadState("networkidle");

		// AC-2: while idle, no Stop control is visible.
		await expect(getStopButton(page)).toHaveCount(0);
	});

	test("AC-1 / AC-3 / AC-5 — Stop halts the turn, partial visible, input unblocked", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(60_000);

		await page.goto(LOOM_PATH);
		await page.waitForLoadState("networkidle");

		// Find the textbox in the Loom page. The Direct tab is the default
		// surface so `FabricDirectChat` is mounted on first paint.
		const textbox = page.getByRole("textbox").first();
		await textbox.waitFor({ state: "visible", timeout: 15_000 });
		await textbox.fill(
			"Long-running Loom Direct prompt to test the Stop morph.",
		);
		await textbox.press("Enter");

		// Stop button morphs in.
		const stopButton = getStopButton(page);
		await expect(stopButton).toBeVisible({ timeout: 15_000 });

		// Wait for partial content so AC-1 is meaningful.
		await expect(page.getByText(/Working on it/)).toBeVisible({
			timeout: 10_000,
		});

		await stopButton.click();

		await expect(getStoppedCaption(page)).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText(/Working on it/)).toBeVisible();

		await expectInputUnblocked(page);
	});

	test("AC-4 / AC-10 — cancel endpoint 500 surfaces a toast, visual state does not revert", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(60_000);

		// Mock the cancel endpoint to return 500 so the hook's
		// `onStopFailed` callback fires. Per AC-10 the visual state must
		// stay in "Stopped" — the toast is non-blocking and informational
		// only.
		let cancelCallCount = 0;
		await page.route(
			"**/api/agents/fabric-ai/stream/cancel",
			async (route) => {
				cancelCallCount += 1;
				await route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify({ error: "Internal server error" }),
				});
			},
		);

		await page.goto(LOOM_PATH);
		await page.waitForLoadState("networkidle");

		const textbox = page.getByRole("textbox").first();
		await textbox.waitFor({ state: "visible", timeout: 15_000 });
		await textbox.fill(
			"Prompt that lets the started event capture executionId before Stop.",
		);
		await textbox.press("Enter");

		const stopButton = getStopButton(page);
		await expect(stopButton).toBeVisible({ timeout: 15_000 });

		// Critical: wait until at least one text delta has rendered. The
		// `started` event arrives BEFORE the first `text` delta, so by the
		// time we see "Working on it" the executionId has been captured by
		// `useDirectStream` and the upcoming Stop click WILL fire the
		// cancel POST.
		await expect(page.getByText(/Working on it/)).toBeVisible({
			timeout: 15_000,
		});

		await stopButton.click();

		// Optimistic flip — the Stopped caption appears immediately.
		await expect(getStoppedCaption(page)).toBeVisible({ timeout: 5_000 });

		// The cancel POST fires fire-and-forget. Verify it was hit.
		await expect
			.poll(() => cancelCallCount, { timeout: 10_000 })
			.toBeGreaterThanOrEqual(1);

		// AC-10 — non-blocking toast appears with the audited copy from
		// spec § 4.3 / Task 4.1.
		await expect(
			page.getByText(
				"Couldn't fully stop the response. Trailing tokens may still arrive.",
			),
		).toBeVisible({ timeout: 5_000 });

		// AC-10 — visual state does NOT revert. The Stopped caption is
		// still present, input is still unblocked.
		await expect(getStoppedCaption(page)).toBeVisible();
		await expectInputUnblocked(page);
	});
});
