/**
 * MCP Registry "Always on" pill — E2E coverage.
 *
 * The MCP Registry settings page renders a row per MCP server. For rows
 * where the backing `MCPServer.defaultEnabled === true` (Excalidraw after
 * the backfill), the configure-button is replaced with a non-actionable
 * "Always on" pill. The pill carries the accessible name and tooltip copy
 * "Enabled for everyone, no setup needed." (locked copy).
 *
 * Scenarios:
 *
 *   1. The pill is rendered for the Excalidraw row.
 *   2. Hovering the pill shows the tooltip with the locked copy.
 *   3. Keyboard-focusing the pill also shows the tooltip (accessibility —
 *      per `fabric/standards/frontend/accessibility.md`).
 *   4. No "+ Configure" button is rendered on the Excalidraw row.
 *
 * Prerequisites: dev server on :3001 + auth state from `auth.setup.ts`.
 */

import { expect, type Page, test } from "@playwright/test";

// Visible pill label and tooltip copy — both locked.
// The pill's accessible name equals its visible label per WCAG 2.5.3
// (Label in Name); the longer description lives in the tooltip and is
// surfaced via Radix's `aria-describedby` wiring.
const ALWAYS_ON_LABEL = "Always on";
const ALWAYS_ON_TOOLTIP_COPY = "Enabled for everyone, no setup needed.";

// The MCP registry page (personal context). The org-context equivalent is
// `/app/{slug}/mcp-servers`. Both render the same registry component.
const MCP_SETTINGS_URL = "/app/mcp-servers";

/**
 * Locate the Excalidraw row in the registry. The registry renders one
 * `<Card>` per server; we identify the row by its visible name. Returns
 * the row locator so callers can chain queries against just that row.
 */
function locateExcalidrawRow(page: Page) {
	// The server name is rendered in a `font-medium` div inside the card.
	// Filter by the visible text "Excalidraw" so we don't accidentally match
	// a custom server with the same key. Case-sensitive — the seed
	// (`packages/database/prisma/seed-enterprise-mcp.ts`) uses the exact
	// capitalization "Excalidraw".
	return page
		.locator("[class*='Card'], div")
		.filter({ has: page.getByText("Excalidraw", { exact: true }) })
		.first();
}

test.describe("MCP Registry — 'Always on' pill", () => {
	test.beforeEach(async ({ page }) => {
		await page.goto(MCP_SETTINGS_URL);
		await page.waitForLoadState("networkidle");
	});

	test("renders the 'Always on' pill on the Excalidraw row", async ({
		page,
	}) => {
		const row = locateExcalidrawRow(page);
		await expect(row).toBeVisible();

		const pill = row.getByRole("button", { name: ALWAYS_ON_LABEL });
		await expect(pill).toBeVisible();
		// The pill is non-actionable — aria-disabled signals this to assistive
		// tech.
		await expect(pill).toHaveAttribute("aria-disabled", "true");
		// Visible text shows the short label.
		await expect(pill).toHaveText("Always on");
	});

	test("hovering the pill reveals the tooltip with the locked copy", async ({
		page,
	}) => {
		const row = locateExcalidrawRow(page);
		const pill = row.getByRole("button", { name: ALWAYS_ON_LABEL });
		await pill.hover();

		// Tooltip text appears inside a Radix-managed portal. We assert the
		// document has it visible — the locked copy is unique on the page.
		await expect(
			page.getByText(ALWAYS_ON_TOOLTIP_COPY).first(),
		).toBeVisible({ timeout: 2000 });
	});

	test("keyboard-focusing the pill reveals the tooltip (accessibility)", async ({
		page,
	}) => {
		// Tab through the page until the Excalidraw row's pill receives
		// focus. The tab order may have many entries before reaching it;
		// using `pill.focus()` directly is acceptable here because the
		// purpose is to verify the tooltip reacts to focus, not to verify
		// the natural tab order (a separate accessibility audit covers
		// that).
		const row = locateExcalidrawRow(page);
		const pill = row.getByRole("button", { name: ALWAYS_ON_LABEL });
		await pill.focus();

		await expect(
			page.getByText(ALWAYS_ON_TOOLTIP_COPY).first(),
		).toBeVisible({ timeout: 2000 });
	});

	test("does NOT render a '+ Configure' action on the Excalidraw row", async ({
		page,
	}) => {
		const row = locateExcalidrawRow(page);
		// The legacy + Configure button is rendered with a PlusIcon and the
		// accessible label "Configure" (from the tooltip). It is replaced
		// with the pill for default-enabled rows.
		await expect(
			row.getByRole("button", { name: /^Configure$/i }),
		).toHaveCount(0);
	});
});
