/**
 * E2E: SaaS-shell incident chip.
 *
 * Scope
 * -----
 * Verifies the documented chip behaviours end-to-end (the chip replaced
 * the earlier full-width banner — see `IncidentChip.tsx` for the
 * design notes):
 *   (a) Flag OFF → chip hidden even when the API returns SEV-1 rows.
 *   (b) Flag ON + active SEV-1 → red chip with the count "1" appears
 *       next to the credits chip.
 *   (c) Flag ON + active SEV-2 only → amber chip.
 *   (d) Click chip → user navigates to /app/admin/monitoring.
 *
 * The oRPC `listActiveIncidents` endpoint is stubbed via Playwright route
 * interception — no DB seeding required, which is critical because the
 * incident tables are admin-only (RLS denies seed-script reads from the
 * test user's connection). The stub returns the exact response shape
 * defined by the server-side procedure.
 *
 * Status: SKIPPED in CI. Requires:
 *   - `NEXT_PUBLIC_FABRIC_FEATURE_INCIDENT_BANNER=true` for the (b)–(d) cases
 *   - An authenticated admin session (the chip is gated to admins / owners)
 * Local run:
 *   NEXT_PUBLIC_FABRIC_FEATURE_INCIDENT_BANNER=true pnpm --filter web e2e \
 *     tests/e2e/saas-shell/incident-chip.spec.ts
 */

import { expect, type Page, test } from "@playwright/test";

const BANNER_FLAG = "NEXT_PUBLIC_FABRIC_FEATURE_INCIDENT_BANNER";

/**
 * The oRPC RPC route for `integrationHealth.listActiveIncidents`. The
 * orpc-client posts to `/api/rpc/<router>/<procedure>` so the URL pattern
 * is stable across builds.
 */
const LIST_ACTIVE_INCIDENTS_URL =
	/\/api\/rpc\/integrationHealth\/listActiveIncidents/;

interface StubResponse {
	errorRate: Array<{
		id: string;
		severity: "SEV1" | "SEV2";
		status: "FIRING" | "ACKNOWLEDGED";
		service: string;
		feature: string;
	}>;
	integration: Array<{
		id: string;
		severity: "SEV1" | "SEV2";
		status: "FIRING" | "ACKNOWLEDGED";
		providerKey: string;
		providerName: string;
		summary: string | null;
	}>;
}

const SEV1_OPENAI: StubResponse = {
	errorRate: [],
	integration: [
		{
			id: "inc-openai-sev1",
			severity: "SEV1",
			status: "FIRING",
			providerKey: "openai",
			providerName: "OpenAI",
			summary: "Elevated 5xx on /v1/chat/completions",
		},
	],
};

const SEV2_ONLY: StubResponse = {
	errorRate: [],
	integration: [
		{
			id: "inc-stripe-sev2",
			severity: "SEV2",
			status: "FIRING",
			providerKey: "stripe",
			providerName: "Stripe",
			summary: "Elevated API errors",
		},
	],
};

/**
 * Install a stub for `listActiveIncidents`. The orpc-client sends the
 * input as the request body; we ignore the body and respond with the
 * caller-provided fixture.
 */
async function stubActiveIncidents(page: Page, body: StubResponse) {
	await page.route(LIST_ACTIVE_INCIDENTS_URL, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ json: body }),
		});
	});
}

test.describe("Incident chip — SaaS shell", () => {
	test("hides the chip when the feature flag is OFF (even with SEV-1 data)", async ({
		page,
	}) => {
		test.skip(
			process.env[BANNER_FLAG] === "true",
			"This case requires the flag OFF; current env has it ON.",
		);

		await stubActiveIncidents(page, SEV1_OPENAI);
		await page.goto("/app");

		await page.waitForLoadState("networkidle");
		await expect(page.getByTestId("incident-chip")).toHaveCount(0);
	});

	test.describe("with feature flag ON", () => {
		test.skip(
			() => process.env[BANNER_FLAG] !== "true",
			`Skipped: set ${BANNER_FLAG}=true to exercise the live-chip path.`,
		);

		test("(b) shows a red SEV-1 chip with a count of 1", async ({
			page,
		}) => {
			await stubActiveIncidents(page, SEV1_OPENAI);
			await page.goto("/app");

			const chip = page.getByTestId("incident-chip");
			await expect(chip).toBeVisible();
			await expect(chip).toHaveAttribute("data-tone", "destructive");
			await expect(chip).toContainText("1");
		});

		test("(c) shows an amber chip for SEV-2-only incidents", async ({
			page,
		}) => {
			await stubActiveIncidents(page, SEV2_ONLY);
			await page.goto("/app");

			const chip = page.getByTestId("incident-chip");
			await expect(chip).toBeVisible();
			await expect(chip).toHaveAttribute("data-tone", "warning");
		});

		test("(d) clicking the chip navigates to the monitoring dashboard", async ({
			page,
		}) => {
			await stubActiveIncidents(page, SEV1_OPENAI);
			await page.goto("/app");

			const chip = page.getByTestId("incident-chip");
			await expect(chip).toBeVisible();
			await chip.click();
			await expect(page).toHaveURL(/\/app\/admin\/monitoring$/);
		});
	});
});
