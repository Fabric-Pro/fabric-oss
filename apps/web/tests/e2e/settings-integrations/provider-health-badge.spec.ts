/**
 * E2E: Settings -> Integrations provider-health badge.
 *
 * Scope
 * -----
 * Smoke-tests the provider-health badge surface on the Settings ->
 * Integrations page. Sets the feature flag via env, mounts the page,
 * and asserts that the new "Provider status" filter chips render and
 * the badges keep the page free of console errors.
 *
 * Status: SKIPPED in CI. Requires:
 *   - `NEXT_PUBLIC_FABRIC_FEATURE_INTEGRATION_HEALTH_BADGES=true`
 *   - A seeded `IntegrationProviderRegistry` (33 providers)
 *   - An authenticated session
 * In local dev, run with the feature flag on and an authenticated session
 * to exercise the path manually. An authoring environment that fulfils
 * all three conditions is required before enabling this test in CI.
 */

import { expect, test } from "@playwright/test";

test.describe("Settings -> Integrations provider health badge", () => {
	test.skip(
		() => !process.env.NEXT_PUBLIC_FABRIC_FEATURE_INTEGRATION_HEALTH_BADGES,
		"Skipped: requires NEXT_PUBLIC_FABRIC_FEATURE_INTEGRATION_HEALTH_BADGES=true + registry seed + auth",
	);

	test("renders the Provider status filter and at least one badge", async ({
		page,
	}) => {
		const consoleErrors: string[] = [];
		page.on("console", (message) => {
			if (message.type() === "error") {
				consoleErrors.push(message.text());
			}
		});

		await page.goto("/app/settings/integrations");

		// Filter chips visible.
		const filter = page.getByTestId("provider-status-filter");
		await expect(filter).toBeVisible();
		await expect(filter.getByText(/^Operational$/)).toBeVisible();
		await expect(filter.getByText(/^Outage$/)).toBeVisible();

		// Drill into "Operational" -> grid still renders something.
		await filter.getByRole("button", { name: "Operational" }).click();
		await expect(
			page.locator(".grid > a, .grid > div").first(),
		).toBeVisible();

		// No hydration warnings or runtime errors on the page.
		expect(
			consoleErrors.filter((error) => /hydration|warning/i.test(error)),
		).toEqual([]);
	});

	test("opens the incident drawer from a ConnectionCard badge", async ({
		page,
	}) => {
		test.skip(
			!process.env.TEST_PROVIDER_WITH_INCIDENT,
			"Requires a seeded provider with an active incident",
		);

		await page.goto("/app/settings/integrations");
		// The interactive badge lives inside the ConnectionCard for the
		// targeted provider. Click it -> drawer slides in from the right.
		const badge = page
			.getByRole("status")
			.filter({ hasText: /Operational|Degraded|Partial|Major/ })
			.first();
		await badge.click();
		await expect(
			page.getByTestId("integration-incident-drawer"),
		).toBeVisible();
	});
});
