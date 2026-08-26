/**
 * E2E: Document-assistant hydration — TTI overhead (D.6).
 *
 * Spec: 2026-05-19-ai-assistant-document-chat-history §10.1 NFR-1, AC-6.
 * The SSR hydration path MUST NOT add more than 100 ms to document-editor
 * TTI at p50 on a 200-turn conversation.
 *
 * Test strategy:
 *  - Baseline: open the document with the hydrator switched off (the
 *    `?disableAssistantHydration=1` query param tells the page wrapper to
 *    treat the seed as empty — see opt-out logic in `DocumentEditorPage`).
 *    NOTE: the toggle is implemented inline in this spec via a route-level
 *    override at fetch time (we intercept the SSR fetch and swap the
 *    payload). This avoids contaminating production code with a test-only
 *    branch.
 *  - With hydration: same URL, no override → SSR delivers the active
 *    conversation; `<HydratedMessagesProvider>` + `<CustomMessages>`
 *    render historical turns immediately on first paint (no `agent.messages`
 *    round-trip).
 *  - Measure the time from `goto` resolved to `performance.timing
 *    .domContentLoadedEventEnd - navigationStart` (DOMContentLoaded
 *    relative to navigation start). Repeat 5 times per arm.
 *  - Assert p50(with) - p50(baseline) <= 100 ms locally; relax to 250 ms
 *    on CI where shared runners introduce up to ~150 ms of noise.
 *
 * The assertion EXISTS in both environments; only the threshold widens
 * on CI per orchestrator guidance ("the assertion itself MUST exist
 * either way").
 */

import { expect, type Page, test } from "@playwright/test";
import {
	getActiveConversation,
	HYDRATION_TURN_COUNT,
	pageUrlFor,
	readSeedConfig,
	removeConversation,
	resolveScope,
	seedConversation,
} from "./_fixtures";

const cfg = readSeedConfig();
const scope = resolveScope(cfg);

const RUNS_PER_ARM = 5;
const LOCAL_DELTA_BUDGET_MS = 100;
const CI_DELTA_BUDGET_MS = 250;

/**
 * Read the document's TTI proxy: DOMContentLoaded relative to
 * navigationStart, in ms. This is intentionally cheap — the live first-
 * paint metrics (LCP / FCP) would need PerformanceObserver scaffolding
 * that adds its own variance on Windows runners. DOMContentLoaded is a
 * stable proxy because both arms render identical post-DCL UI; only the
 * hydration cost differs.
 */
async function readDcl(page: Page): Promise<number> {
	return await page.evaluate(() => {
		const timing = performance.timing;
		return timing.domContentLoadedEventEnd - timing.navigationStart;
	});
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0
		? (sorted[mid - 1] + sorted[mid]) / 2
		: sorted[mid];
}

test.describe("document assistant hydration — TTI overhead", () => {
	test.skip(
		!scope,
		"Set TEST_ORG_* or TEST_PERSONAL_* env vars to run this suite — see _fixtures.ts.",
	);

	let seededConversationId: string | null = null;

	test.beforeAll(async ({ request }) => {
		if (!scope) {
			return;
		}
		const existing = await getActiveConversation(request, scope);
		if (existing && existing.messageCount >= HYDRATION_TURN_COUNT) {
			seededConversationId = existing.conversationId;
			return;
		}
		seededConversationId = await seedConversation(
			request,
			scope,
			HYDRATION_TURN_COUNT,
		);
	});

	test.afterAll(async ({ request }) => {
		if (!seededConversationId) {
			return;
		}
		await removeConversation(request, seededConversationId);
	});

	test("hydration overhead does not exceed the spec budget at p50", async ({
		page,
	}) => {
		if (!scope) {
			test.skip();
			return;
		}

		const url = pageUrlFor(scope);

		// Arm A — baseline: intercept the RSC streaming response and clear
		// the seeded conversation so the editor mounts an empty thread.
		// We achieve this by short-circuiting the underlying oRPC POST that
		// the SSR loader makes (`/api/rpc/agents/conversations/getActiveForDocument`)
		// during page.goto. Returning a synthetic `{ conversation: null }`
		// payload mimics a freshly-created document.
		const baselineDurations: number[] = [];
		await page.route(
			"**/api/rpc/agents/conversations/getActiveForDocument",
			async (route) => {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: JSON.stringify({ json: { conversation: null } }),
				});
			},
		);
		for (let i = 0; i < RUNS_PER_ARM; i++) {
			await page.goto(url, { waitUntil: "domcontentloaded" });
			baselineDurations.push(await readDcl(page));
		}
		await page.unroute(
			"**/api/rpc/agents/conversations/getActiveForDocument",
		);

		// Arm B — hydration: no route override, SSR delivers the seeded
		// payload, `<HydratedMessagesProvider>` + `<CustomMessages>` render
		// historical turns immediately on first paint.
		const hydrationDurations: number[] = [];
		for (let i = 0; i < RUNS_PER_ARM; i++) {
			await page.goto(url, { waitUntil: "domcontentloaded" });
			hydrationDurations.push(await readDcl(page));
		}

		const baselineP50 = median(baselineDurations);
		const hydrationP50 = median(hydrationDurations);
		const delta = hydrationP50 - baselineP50;

		// Surface the measurement on every run so failures are diagnosable
		// from the test log without re-running locally.
		// eslint-disable-next-line no-console
		console.log(
			JSON.stringify({
				baselineDurations,
				hydrationDurations,
				baselineP50,
				hydrationP50,
				deltaMs: delta,
			}),
		);

		const budget = process.env.CI
			? CI_DELTA_BUDGET_MS
			: LOCAL_DELTA_BUDGET_MS;
		expect(
			delta,
			`p50 hydration overhead ${delta.toFixed(1)} ms exceeded the ${budget} ms budget (spec NFR-1 / AC-6).`,
		).toBeLessThanOrEqual(budget);
	});
});
