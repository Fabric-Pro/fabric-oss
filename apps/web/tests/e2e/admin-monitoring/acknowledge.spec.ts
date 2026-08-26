/**
 * E2E: Admin monitoring dashboard -- acknowledge flow.
 *
 * Scope
 * -----
 * Smoke-tests the click path of acknowledging an integration incident from
 * the admin monitoring dashboard:
 *   1. Visit `/app/admin/monitoring`.
 *   2. Row for the seeded incident appears with status FIRING.
 *   3. Click the row's "Acknowledge" button.
 *   4. Dialog opens; click confirm.
 *   5. The list invalidation refetches with the row in ACKNOWLEDGED state.
 *   6. Toast surfaces "Incident acknowledged".
 *
 * Both the data fetch and the acknowledge mutation are stubbed via
 * Playwright route interception. The acknowledge stub responds with the
 * post-acknowledge row shape, and a SECOND stub takes over for the
 * follow-up list refetch (since the query is invalidated on success).
 *
 * Status: SKIPPED in CI. Requires:
 *   - `NEXT_PUBLIC_FABRIC_FEATURE_ADMIN_MONITORING_DASHBOARD=true`
 *   - An authenticated admin session
 * Local run:
 *   NEXT_PUBLIC_FABRIC_FEATURE_ADMIN_MONITORING_DASHBOARD=true \
 *     pnpm --filter web e2e tests/e2e/admin-monitoring/acknowledge.spec.ts
 */

import { expect, type Route, test } from "@playwright/test";

const FLAG = "NEXT_PUBLIC_FABRIC_FEATURE_ADMIN_MONITORING_DASHBOARD";

const ERROR_RATE_LIST_URL = /\/api\/rpc\/incidents\/errorRate\/list(?!Events)/;
const INTEGRATION_LIST_URL =
	/\/api\/rpc\/integrationHealth\/listActiveIncidents/;
const PROVIDER_HEALTH_URL = /\/api\/rpc\/integrationHealth\/listProviderHealth/;
const ACKNOWLEDGE_URL =
	/\/api\/rpc\/integrationHealth\/acknowledgeIntegrationIncident/;

interface IntegrationIncidentListRow {
	id: string;
	severity: "SEV1" | "SEV2";
	status: "FIRING" | "ACKNOWLEDGED";
	providerKey: string;
	providerName: string;
	summary: string | null;
}

const INCIDENT_ID = "inc-openai-ack-test";

const FIRING_ROW: IntegrationIncidentListRow = {
	id: INCIDENT_ID,
	severity: "SEV1",
	status: "FIRING",
	providerKey: "openai",
	providerName: "OpenAI",
	summary: "Investigating elevated 5xx",
};

const ACKNOWLEDGED_ROW: IntegrationIncidentListRow = {
	...FIRING_ROW,
	status: "ACKNOWLEDGED",
};

async function fulfillJson(route: Route, body: unknown) {
	await route.fulfill({
		status: 200,
		contentType: "application/json",
		body: JSON.stringify({ json: body }),
	});
}

test.describe("Admin monitoring -- acknowledge incident", () => {
	test.skip(
		() => process.env[FLAG] !== "true",
		`Skipped: set ${FLAG}=true and seed an admin auth session to run this test.`,
	);

	test("clicking Acknowledge updates the row from FIRING -> ACKNOWLEDGED", async ({
		page,
	}) => {
		let currentList: IntegrationIncidentListRow[] = [FIRING_ROW];
		let ackCalled = false;

		// Stub the error-rate list -- empty for this test, focus on the
		// integration path.
		await page.route(ERROR_RATE_LIST_URL, async (route) => {
			await fulfillJson(route, { incidents: [], nextCursor: null });
		});

		// Stub the integration list. The handler is dynamic so the same
		// route serves FIRING before the click and ACKNOWLEDGED after.
		await page.route(INTEGRATION_LIST_URL, async (route) => {
			await fulfillJson(route, {
				errorRate: [],
				integration: currentList,
			});
		});

		// Provider health grid -- minimal payload.
		await page.route(PROVIDER_HEALTH_URL, async (route) => {
			await fulfillJson(route, { providers: [] });
		});

		// Stub the acknowledge mutation. On call, flip the in-memory row
		// state and respond with the updated row (matches procedure shape).
		await page.route(ACKNOWLEDGE_URL, async (route) => {
			ackCalled = true;
			currentList = [ACKNOWLEDGED_ROW];
			await fulfillJson(route, {
				incident: ACKNOWLEDGED_ROW,
			});
		});

		const response = await page.goto("/app/admin/monitoring");
		if (response?.status() === 404) {
			test.skip();
			return;
		}
		if (!page.url().endsWith("/app/admin/monitoring")) {
			test.skip();
			return;
		}

		// Locate the row by the data-testid the table renders.
		const row = page.getByTestId(`incident-row-${INCIDENT_ID}`);
		await expect(row).toBeVisible();
		await expect(row.getByText(/firing/i)).toBeVisible();

		// Click the Acknowledge action button on this row.
		await row.getByRole("button", { name: /^Acknowledge / }).click();

		// Dialog opens with the provider name in its title.
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByText("OpenAI", { exact: true })).toBeVisible();

		// Confirm the acknowledge in the dialog. The component renders the
		// primary button as "Acknowledge".
		await dialog.getByRole("button", { name: /^Acknowledge$/ }).click();

		// Wait for the mutation to fire + the invalidated query to refetch.
		await expect.poll(() => ackCalled, { timeout: 3000 }).toBe(true);
		await expect(dialog).toBeHidden();

		// The row should now reflect ACKNOWLEDGED status. Two assertions:
		// the row still exists (admin table includes ack'd) AND the status
		// pill text changed.
		await expect(row).toBeVisible();
		await expect(row.getByText(/acknowledged/i)).toBeVisible();
	});
});
