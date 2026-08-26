/**
 * Stop / Cancel AI Generation — Loom Orchestrator E2E
 *
 * Spec: `specs/2026-05-09-stop-ai-generation/spec.md` § 9.1 (Task 6.4).
 *
 * Surface D in `spec.md` § 1.3: the standalone Loom page at
 * `/app/agents/fabric-ai` with the `Orchestrator` tab active. This page
 * mounts `FabricTemporalOrchestratorChat`, which uses
 * `useOrchestratorStream` — the orchestrator-temporal cancel route is
 * already in place (no new server endpoint).
 *
 * This spec exercises:
 *   - AC-1 — Stop halts the in-flight generation immediately.
 *   - AC-3 — Input becomes unblocked.
 *   - AC-5 — Cancelled message renders with the `Stopped` label and
 *            survives reload.
 *   - AC-9 — Stop is visible (and effective) even when the workflow is
 *            paused on `pendingApproval`.
 *
 * The mocked stream emits `started` quickly, then a few text deltas, then
 * an `approval_required` event so the orchestrator state enters
 * `pendingApproval`. Per spec § 8.6 / decision 20 the morph button's
 * visibility predicate is `isLoading || pendingApproval`, so the Stop
 * button stays visible across the approval pause.
 */

import { expect, test } from "@playwright/test";
import {
	expectInputUnblocked,
	getStopButton,
	getStoppedCaption,
	installSlowStream,
} from "./helpers/stop-ai";

const LOOM_PATH = "/app/agents/fabric-ai";

async function switchToOrchestratorTab(page: import("@playwright/test").Page) {
	// The Loom page header has a `Direct | Orchestrator | Research` toggle
	// — click "Orchestrator". The visible label is "Orchestrator" inside a
	// button with `aria-haspopup` from the tooltip wrapper, so we match by
	// visible text.
	const orchestratorButton = page.getByRole("button", {
		name: /Orchestrator/i,
	});
	await orchestratorButton.first().click();
}

test.describe("Stop AI generation — Loom Orchestrator", () => {
	test.beforeEach(async ({ page }) => {
		await installSlowStream(page, {
			endpoint: "orchestrator-temporal-stream",
			executionIdPrefix: "orch-",
			emitApprovalRequired: true,
			// Tight delays so `approval_required` fires within ~3s — the
			// test waits for the orchestrator to enter pendingApproval
			// state before Stop, so AC-9 is exercised.
			betweenEventsDelayMs: 500,
		});
	});

	test("AC-1 / AC-3 / AC-5 / AC-9 — Stop is visible, click halts the turn, partial persists across reload", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(90_000);

		await page.goto(LOOM_PATH);
		await page.waitForLoadState("networkidle");
		await switchToOrchestratorTab(page);

		const textbox = page.getByRole("textbox").first();
		await textbox.waitFor({ state: "visible", timeout: 15_000 });
		await textbox.fill(
			"Plan and execute a long task so I can pause for approval and Stop.",
		);
		await textbox.press("Enter");

		// Stop button morph appears as soon as the request is in-flight
		// (`isLoading` flips true synchronously in the hook).
		const stopButton = getStopButton(page);
		await expect(stopButton).toBeVisible({ timeout: 15_000 });

		// Wait for partial content to land so the AC-1 partial assertion
		// is meaningful when we Stop.
		await expect(page.getByText(/Working on it/)).toBeVisible({
			timeout: 15_000,
		});

		// AC-9 / decision 20: Stop must remain visible AFTER the
		// orchestrator enters `pendingApproval`. The mock sends an
		// `approval_required` event ~3s after `started` (4 text deltas at
		// 500ms + one approval delay). The `<ApprovalDialog>` renders
		// `Approval Required` once the state flips. If this assertion
		// times out (no approval pause reached), the test fails honestly
		// — we don't paper over it with a timing-dependent skip.
		await expect(page.getByText("Approval Required")).toBeVisible({
			timeout: 15_000,
		});
		await expect(stopButton).toBeVisible();

		await stopButton.click();

		// AC-1 / AC-5 — caption appears, partial body remains.
		await expect(getStoppedCaption(page)).toBeVisible({ timeout: 5_000 });
		await expect(page.getByText(/Working on it/)).toBeVisible();

		// AC-3 — input ready for the next prompt.
		await expectInputUnblocked(page);

		// AC-5 — reload preserves the partial assistant message + Stopped
		// caption. The orchestrator persists messages by way of the
		// existing JSON blob; reading the same conversation re-renders the
		// cancelled message with the same caption.
		await page.reload();
		await page.waitForLoadState("networkidle");

		// After reload, the persisted partial + label should still appear
		// in the conversation. The mock fetch override does not need to
		// fire again because we are rendering already-persisted data —
		// but be lenient in assertion timing in case the
		// orchestrator-mode hydration is async.
		await expect(getStoppedCaption(page)).toBeVisible({ timeout: 15_000 });
	});
});
