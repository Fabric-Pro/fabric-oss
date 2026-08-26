/**
 * E2E: URL Context Sources — Firecrawl pre-flight notice
 *
 * Spec: fabric/specs/2026-05-13-url-context-sources/spec.md §9.1, §15.3
 * Tasks: fabric/specs/2026-05-13-url-context-sources/tasks.md §10.2
 *
 * Scope:
 *   1. The Link tab renders the editorial pre-flight notice when the
 *      tenant has not configured a Firecrawl API key.
 *   2. The "Add Context" submit is `aria-disabled="true"` and not clickable.
 *   3. The notice's deep link points at `/app/settings/search-providers`
 *      for personal context and `/app/{slug}/settings/search-providers`
 *      for the org context.
 *
 * Status: SKIPPED in CI. This spec relies on the local dev server, a
 * seeded user, and a known project ID. The needed fixtures aren't wired
 * into the global Playwright auth setup yet — see `ROLLOUT.md` for the
 * manual smoke runbook.
 *
 * TODO(group-10-followup): enable once `tests/auth.setup.ts` seeds at
 * least one `Personal-tenant` project + one `Org-tenant` project without
 * a Firecrawl key.
 */

import { expect, test } from "@playwright/test";

const PROJECT_ID =
	process.env.TEST_PERSONAL_PROJECT_WITHOUT_FIRECRAWL_ID ??
	"<personal-project-id>";
const ORG_SLUG = process.env.TEST_ORG_SLUG ?? "<org-slug>";
const ORG_PROJECT_ID =
	process.env.TEST_ORG_PROJECT_WITHOUT_FIRECRAWL_ID ?? "<org-project-id>";

function isPlaceholder(v: string): boolean {
	return v.startsWith("<") && v.endsWith(">");
}

test.describe("URL Context Sources — Firecrawl pre-flight notice", () => {
	test.skip(
		() => true,
		"Group 10 deferral: enable once auth/fixtures + v2 flag wired in CI",
	);

	test("personal tenant: notice card visible + submit disabled", async ({
		page,
	}) => {
		if (isPlaceholder(PROJECT_ID)) {
			test.skip();
		}

		await page.goto(`/app/projects/${PROJECT_ID}/contexts`);
		await page.getByRole("button", { name: /add context/i }).click();
		await page.getByRole("tab", { name: /link/i }).click();

		await expect(
			page.getByText(/URL sources need a Firecrawl API key/i),
		).toBeVisible({ timeout: 10_000 });

		const settingsCta = page.getByRole("link", {
			name: /Settings → Search Providers/i,
		});
		await expect(settingsCta).toHaveAttribute(
			"href",
			"/app/settings/search-providers",
		);

		const submit = page.getByRole("button", { name: /^Add Context$/i });
		await expect(submit).toHaveAttribute("aria-disabled", "true");
	});

	test("org tenant: deep link resolves to /app/{slug}/settings/search-providers", async ({
		page,
	}) => {
		if (isPlaceholder(ORG_SLUG) || isPlaceholder(ORG_PROJECT_ID)) {
			test.skip();
		}

		await page.goto(`/app/${ORG_SLUG}/projects/${ORG_PROJECT_ID}/contexts`);
		await page.getByRole("button", { name: /add context/i }).click();
		await page.getByRole("tab", { name: /link/i }).click();

		await expect(
			page.getByText(/URL sources need a Firecrawl API key/i),
		).toBeVisible({ timeout: 10_000 });
		await expect(
			page.getByRole("link", { name: /Settings → Search Providers/i }),
		).toHaveAttribute("href", `/app/${ORG_SLUG}/settings/search-providers`);
	});
});
