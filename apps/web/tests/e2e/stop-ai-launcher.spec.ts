/**
 * Stop / Cancel AI Generation — Fabric Agent Launcher E2E
 *
 * Spec: `specs/2026-05-09-stop-ai-generation/spec.md` § 9.1 (Task 6.2).
 *
 * Surface B in `spec.md` § 1.3: the global Cmd/Ctrl+J launcher mounts
 * `FabricDirectChat` inside a side-sheet. The launcher passes
 * `surface="fabric-agent-launcher"` so cancel telemetry is tagged
 * accordingly.
 *
 * This spec exercises:
 *   - AC-1  — Stop halts the in-flight generation immediately and the
 *             partial response is shown.
 *   - AC-5  — The cancelled message renders with a calm `Stopped` label.
 *   - AC-7  — Esc is context-sensitive: while the turn is in-flight Esc
 *             stops it; while idle Esc closes the launcher.
 *
 * The test mocks `/api/agents/fabric-ai/stream` via a `window.fetch`
 * override (see `helpers/stop-ai.ts`) so the SSE stream emits a
 * deterministic `started` event quickly and then deliberately holds the
 * connection open. That gives us a stable mid-stream window in which to
 * press Escape.
 */

import { expect, test } from "@playwright/test";
import {
	expectInputUnblocked,
	getStopButton,
	getStoppedCaption,
	installSlowStream,
} from "./helpers/stop-ai";

const LAUNCHER_PANEL_SELECTOR = "[data-fabric-agent-chat]";

test.describe("Stop AI generation — Fabric Agent launcher", () => {
	test.beforeEach(async ({ page }) => {
		await installSlowStream(page, {
			endpoint: "fabric-ai-stream",
			executionIdPrefix: "direct-chat-",
		});
		await page.goto("/app");
		await page.waitForLoadState("networkidle");
	});

	test("Esc while streaming stops; Esc while idle closes the launcher", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(60_000);

		// Open the launcher with the Cmd/Ctrl+J shortcut. Per
		// `omnipresent-launcher.spec.ts`, `Meta+j` works on all platforms in
		// Playwright's Chromium build (the mac-style modifier is normalized
		// to the platform's modifier key).
		await page.keyboard.press("Meta+j");
		const launcher = page.locator(LAUNCHER_PANEL_SELECTOR);
		await expect(launcher).toBeVisible({ timeout: 5_000 });

		// Send a prompt. The mocked stream takes 30+ seconds, so the user
		// has plenty of time to press Esc while the response is "in-flight".
		const textbox = launcher.getByRole("textbox").first();
		await textbox.waitFor({ state: "visible", timeout: 10_000 });
		await textbox.fill(
			"Tell me a long story about distributed systems so I have time to press Stop.",
		);
		await textbox.press("Enter");

		// Stop button (the morphed Send -> Stop control) becomes available
		// almost immediately. Once the `started` event arrives, the partial
		// text begins to land.
		await expect(getStopButton(page)).toBeVisible({ timeout: 10_000 });

		// Wait for at least one `text` delta so the partial body is
		// non-empty when we Stop. AC-1 requires the partial to remain on
		// screen.
		await expect(launcher.getByText(/Working on it/)).toBeVisible({
			timeout: 10_000,
		});

		// Press Esc while in-flight — the shared `useEscToStopOrClose` hook
		// should call `stop()` rather than close the launcher.
		await page.keyboard.press("Escape");

		// The inline Stopped caption appears on the cancelled message.
		await expect(getStoppedCaption(page)).toBeVisible({ timeout: 5_000 });
		await expectInputUnblocked(page);

		// Critical AC-7 assertion: the launcher is still open after the
		// "Stop" Escape — the hook prevented the Escape from also closing
		// the panel.
		await expect(launcher).toBeVisible();

		// Press Esc again — now the turn is idle, so Esc closes the
		// launcher (the `onClose` branch of the hook fires).
		await page.keyboard.press("Escape");
		await expect(launcher).not.toBeVisible({ timeout: 5_000 });
	});

	test("Stop button click halts the turn and shows the Stopped caption", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(60_000);

		await page.keyboard.press("Meta+j");
		const launcher = page.locator(LAUNCHER_PANEL_SELECTOR);
		await expect(launcher).toBeVisible({ timeout: 5_000 });

		const textbox = launcher.getByRole("textbox").first();
		await textbox.fill("Long-running prompt for the Stop button click.");
		await textbox.press("Enter");

		// Wait for the morph to expose the Stop button.
		const stopButton = getStopButton(page);
		await expect(stopButton).toBeVisible({ timeout: 10_000 });

		// Wait for at least one text delta to land before clicking. Without
		// this the partial body would be empty and the AC-1 "partial
		// response is shown" assertion below would be vacuous.
		await expect(launcher.getByText(/Working on it/)).toBeVisible({
			timeout: 10_000,
		});

		await stopButton.click();

		// AC-1 / AC-5 — caption visible, partial body remains.
		await expect(getStoppedCaption(page)).toBeVisible({ timeout: 5_000 });
		await expect(launcher.getByText(/Working on it/)).toBeVisible();

		// AC-3 — input unblocked.
		await expectInputUnblocked(page);
	});
});
