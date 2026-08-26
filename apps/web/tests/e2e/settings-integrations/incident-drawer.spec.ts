/**
 * E2E: Settings -> Integrations incident-drawer click-through.
 *
 * Scope
 * -----
 * Complements the unit-test coverage in
 * `IntegrationIncidentDrawer.test.tsx` with a real click-path through the
 * Settings page. The unit tests cover the data-bound rendering; this E2E
 * covers the actual user interaction (badge click → drawer slide-in →
 * timeline rows render → drawer closes).
 *
 * Why stub the API?
 * -----------------
 * The drawer queries `integrationHealth.getProviderIncidents`, which reads
 * from the admin-only `IntegrationIncident` table. Seeding from a non-
 * admin test user fails because RLS denies the write. The orpc route is
 * stable (`/api/rpc/integrationHealth/getProviderIncidents`) so a
 * Playwright route stub is the lowest-friction way to exercise the click
 * path deterministically.
 *
 * Status: SKIPPED in CI. Requires:
 *   - `NEXT_PUBLIC_FABRIC_FEATURE_INTEGRATION_HEALTH_BADGES=true`
 *   - An authenticated session
 * Local run:
 *   NEXT_PUBLIC_FABRIC_FEATURE_INTEGRATION_HEALTH_BADGES=true pnpm --filter web e2e \
 *     tests/e2e/settings-integrations/incident-drawer.spec.ts
 */

import { expect, type Page, test } from "@playwright/test";

const FLAG = "NEXT_PUBLIC_FABRIC_FEATURE_INTEGRATION_HEALTH_BADGES";

const PROVIDER_INCIDENTS_URL =
	/\/api\/rpc\/integrationHealth\/getProviderIncidents/;
const LIST_PROVIDER_HEALTH_URL =
	/\/api\/rpc\/integrationHealth\/listProviderHealth/;

interface IncidentFixture {
	id: string;
	providerKey: string;
	providerName: string;
	severity: "SEV1" | "SEV2" | "SEV3";
	health:
		| "OPERATIONAL"
		| "DEGRADED"
		| "PARTIAL_OUTAGE"
		| "MAJOR_OUTAGE"
		| "MAINTENANCE"
		| "UNKNOWN";
	status: "FIRING" | "ACKNOWLEDGED" | "RESOLVED";
	startedAt: string;
	resolvedAt: string | null;
	summary: string | null;
	affectedComponents: string[];
	statusPageUrl: string | null;
}

const OPENAI_OPEN_INCIDENT: IncidentFixture = {
	id: "inc-openai-1",
	providerKey: "openai",
	providerName: "OpenAI",
	severity: "SEV2",
	health: "PARTIAL_OUTAGE",
	status: "FIRING",
	startedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
	resolvedAt: null,
	summary: "Elevated 5xx on /v1/chat/completions",
	affectedComponents: ["API"],
	statusPageUrl: "https://status.openai.com",
};

async function stubGetProviderIncidents(
	page: Page,
	incidents: IncidentFixture[],
) {
	await page.route(PROVIDER_INCIDENTS_URL, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({ json: { incidents } }),
		});
	});
}

async function stubListProviderHealth(page: Page) {
	// Minimal stub so the page renders at least one ConnectionCard with a
	// non-OPERATIONAL badge (the interactive variant).
	await page.route(LIST_PROVIDER_HEALTH_URL, async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				json: {
					providers: [
						{
							providerKey: "openai",
							displayName: "OpenAI",
							currentHealth: "PARTIAL_OUTAGE",
							lastPolledAt: new Date().toISOString(),
							statusPageUrl: "https://status.openai.com",
							affectedFeatures: ["ai_generation"],
							activeIncident: OPENAI_OPEN_INCIDENT,
						},
					],
				},
			}),
		});
	});
}

test.describe("Settings -> Integrations incident drawer click-through", () => {
	test.skip(
		() => process.env[FLAG] !== "true",
		`Skipped: set ${FLAG}=true to exercise this path.`,
	);

	test("opens the drawer from a non-operational badge and lists incidents", async ({
		page,
	}) => {
		await stubListProviderHealth(page);
		await stubGetProviderIncidents(page, [OPENAI_OPEN_INCIDENT]);

		await page.goto("/app/settings/integrations");

		// Wait for the integrations page to mount the OpenAI card.
		await expect(page.getByText("OpenAI").first()).toBeVisible();

		// Find and click the OpenAI provider-health badge. The badge in the
		// interactive variant is a <button> with the provider-qualified
		// aria-label "OpenAI status: partial outage".
		const badge = page.getByRole("button", {
			name: /OpenAI status:/i,
		});
		await badge.click();

		// Drawer slides in from the right.
		const drawer = page.getByTestId("integration-incident-drawer");
		await expect(drawer).toBeVisible();

		// Drawer renders the provider name as the SheetTitle.
		await expect(drawer.getByText("OpenAI", { exact: true })).toBeVisible();

		// The seeded incident summary appears in the timeline.
		await expect(
			drawer.getByText(/Elevated 5xx on \/v1\/chat\/completions/),
		).toBeVisible();

		// Statuspage link is present.
		await expect(
			drawer.getByRole("link", { name: /provider status page/i }),
		).toHaveAttribute("href", "https://status.openai.com");
	});

	test("closes the drawer when the user dismisses it via the close affordance", async ({
		page,
	}) => {
		await stubListProviderHealth(page);
		await stubGetProviderIncidents(page, [OPENAI_OPEN_INCIDENT]);

		await page.goto("/app/settings/integrations");
		await page.getByRole("button", { name: /OpenAI status:/i }).click();

		const drawer = page.getByTestId("integration-incident-drawer");
		await expect(drawer).toBeVisible();

		// Radix Sheet exposes the close button as `<button aria-label="Close">`
		// — exact match keeps the assertion stable across icon swaps.
		await page.getByRole("button", { name: /close/i }).first().click();
		await expect(drawer).toBeHidden();
	});

	test("renders the empty state when no incidents are returned", async ({
		page,
	}) => {
		await stubListProviderHealth(page);
		await stubGetProviderIncidents(page, []);

		await page.goto("/app/settings/integrations");
		await page.getByRole("button", { name: /OpenAI status:/i }).click();

		const drawer = page.getByTestId("integration-incident-drawer");
		await expect(drawer).toBeVisible();

		// Editorial empty-state copy. Matches the component's
		// "No incidents in the last 30 days" string.
		await expect(
			drawer.getByText(/no incidents in the last 30 days/i),
		).toBeVisible();
	});
});
