/**
 * E2E: Unified Context Wizard — Accessibility audit
 *
 * Spec: fabric/specs/2026-05-23-unified-context-uploader-wizard/spec.md §7.8
 *   (a11y checklist) + CLAUDE.md "Accessibility Standard" (WCAG 2.1 AA).
 *
 * Runs axe-core in two states:
 *   1. Wizard at Step 1 with the Add Context CTA disabled (empty name)
 *   2. Wizard at Step 1 with the Add Context dialog OPEN on the File tab
 *
 * The dialog open state catches accessibility regressions on the new chrome
 * the spec introduced (multi-file rows, tabs, status pills, drop zone).
 *
 * Strategy: axe-core injected via CDN to avoid a package.json change. The
 * scan is constrained to the visible test region and asserts zero
 * "serious" or "critical" violations. Lower-severity findings are reported
 * as warnings (non-fatal) so we have a baseline to improve without
 * blocking the deploy.
 *
 * Status: SKIPPED in CI by default — matches the deferral pattern of the
 * other 6 specs in this folder (needs a live local stack for auth + the
 * wizard route to render). Run locally with:
 *   pnpm --filter web e2e tests/e2e/unified-context-wizard/a11y-wizard.spec.ts
 */

import { expect, test, type Page } from "@playwright/test";

/**
 * Inject axe-core into the page at a pinned version. Using a CDN keeps the
 * spec dependency-free; the version pin avoids drift between runs.
 */
async function injectAxe(page: Page): Promise<void> {
	await page.addScriptTag({
		url: "https://cdn.jsdelivr.net/npm/axe-core@4.10.3/axe.min.js",
	});
}

interface AxeViolation {
	id: string;
	impact: "minor" | "moderate" | "serious" | "critical" | null;
	description: string;
	helpUrl: string;
	nodes: Array<{ target: string[]; failureSummary?: string }>;
}

interface AxeResults {
	violations: AxeViolation[];
}

async function runAxe(
	page: Page,
	includeSelector?: string,
): Promise<AxeResults> {
	return await page.evaluate(async (selector) => {
		// biome-ignore lint/suspicious/noExplicitAny: axe is loaded via CDN
		const axe = (window as any).axe;
		const opts = {
			runOnly: {
				type: "tag",
				values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
			},
			resultTypes: ["violations"],
		};
		// biome-ignore lint/suspicious/noExplicitAny: result shape matches AxeResults
		const results: any = await axe.run(
			selector ? document.querySelector(selector) : document,
			opts,
		);
		return { violations: results.violations as AxeViolation[] };
	}, includeSelector);
}

function partitionViolations(violations: AxeViolation[]) {
	const blocking = violations.filter(
		(v) => v.impact === "serious" || v.impact === "critical",
	);
	const warnings = violations.filter(
		(v) => v.impact === "minor" || v.impact === "moderate",
	);
	return { blocking, warnings };
}

function describeViolations(label: string, violations: AxeViolation[]): string {
	if (violations.length === 0) {
		return `${label}: clean.`;
	}
	const lines = violations.map((v) => {
		const targets = v.nodes
			.slice(0, 3)
			.map((n) => n.target.join(" > "))
			.join("  |  ");
		return `  [${v.impact ?? "?"}] ${v.id} — ${v.description}\n    ${targets}\n    ${v.helpUrl}`;
	});
	return `${label} (${violations.length}):\n${lines.join("\n\n")}`;
}

test.describe("Unified Context Wizard — a11y audit", () => {
	test.skip(
		() => true,
		"Group 14 deferral — same convention as the other specs in this folder. Run locally once auth fixtures + CDN reachability are set up.",
	);

	test("Step 1 with CTA disabled: no serious/critical violations", async ({
		page,
	}) => {
		await page.goto("/app/projects/new/create");

		// Empty form — CTA is disabled, hint visible
		await expect(page.getByTestId("add-context-cta")).toBeDisabled();
		await expect(
			page.getByTestId("add-context-disabled-hint"),
		).toBeVisible();

		await injectAxe(page);
		const results = await runAxe(page, "main");
		const { blocking, warnings } = partitionViolations(results.violations);

		// Surface BOTH severities in the test output for easy triage; only
		// fail on serious/critical.
		console.log(
			describeViolations("blocking (serious/critical)", blocking),
		);
		console.log(describeViolations("warnings (minor/moderate)", warnings));

		expect(blocking, describeViolations("blocking", blocking)).toEqual([]);
	});

	test("Step 1 with Add Context dialog OPEN on File tab: no serious/critical violations", async ({
		page,
	}) => {
		await page.goto("/app/projects/new/create");
		await page.getByLabel(/project name/i).fill(`A11y ${Date.now()}`);
		await page.getByLabel(/project name/i).blur();

		// Wait for autosave so the CTA enables
		await expect(page.getByText(/Draft saved/i).first()).toBeVisible({
			timeout: 15_000,
		});

		await page.getByTestId("add-context-cta").click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible({ timeout: 5_000 });
		await dialog.getByRole("tab", { name: /^file$/i }).click();

		await injectAxe(page);
		// Scope the scan to the dialog — the rest of the page is parent
		// surface that's audited by sibling specs.
		const results = await runAxe(
			page,
			'[role="dialog"]:not([aria-hidden="true"])',
		);
		const { blocking, warnings } = partitionViolations(results.violations);

		console.log(
			describeViolations("dialog blocking (serious/critical)", blocking),
		);
		console.log(
			describeViolations("dialog warnings (minor/moderate)", warnings),
		);

		expect(
			blocking,
			describeViolations("dialog blocking", blocking),
		).toEqual([]);
	});

	test("Step 1 with pending cards rendered: no serious/critical violations", async ({
		page,
	}) => {
		await page.goto("/app/projects/new/create");
		await page
			.getByLabel(/project name/i)
			.fill(`A11y Pending ${Date.now()}`);
		await page.getByLabel(/project name/i).blur();
		await expect(page.getByText(/Draft saved/i).first()).toBeVisible({
			timeout: 15_000,
		});

		await page.getByTestId("add-context-cta").click();
		const dialog = page.getByRole("dialog");
		await dialog.getByRole("tab", { name: /^text$/i }).click();
		await dialog.getByLabel(/^title$/i).fill("A11y test snippet");
		await dialog
			.getByLabel(/^content$/i)
			.fill(
				"Content sample for the a11y audit so the pending card carries a real title.",
			);
		await dialog.getByRole("button", { name: /add context/i }).click();

		// Pending card appears
		const pendingList = page.getByTestId("pending-items-list");
		await expect(pendingList).toBeVisible({ timeout: 10_000 });
		await expect(
			pendingList.locator("[data-testid^='pending-row-']").first(),
		).toBeVisible();

		await injectAxe(page);
		const results = await runAxe(
			page,
			'[data-testid="pending-items-list"]',
		);
		const { blocking, warnings } = partitionViolations(results.violations);

		console.log(describeViolations("pending list blocking", blocking));
		console.log(describeViolations("pending list warnings", warnings));

		expect(
			blocking,
			describeViolations("pending list blocking", blocking),
		).toEqual([]);
	});
});
