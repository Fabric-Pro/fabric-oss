/**
 * E2E: Download a single feature — workspace + editor sheet placements.
 *
 * Spec:
 *   fabric/specs/2026-05-05-feature-export-download/spec.md §3.1, §5.1, §5.2
 *   fabric/specs/2026-05-05-feature-export-download/spec.md §8.4
 *
 * Scenarios:
 *   1. Open a feature workspace → click `Download` → choose `Markdown` →
 *      assert a `.md` download arrives.
 *   2. Same workspace → choose `PDF` → assert a `.pdf` download arrives.
 *   3. Same workspace → choose `Word` → assert a `.docx` download arrives.
 *   4. Stub feature → click any format → assert the toast is visible AND
 *      no download is captured.
 *
 * Setup: reuses the existing `auth.setup.ts` storageState. Concrete IDs
 * are read from env vars (same pattern as `apps/web/tests/projects/
 * contexts-download.spec.ts`); tests skip themselves when placeholders
 * remain unset so the suite stays green on PR checks while still being
 * runnable manually.
 *
 * Env vars consumed (all optional):
 *   TEST_PERSONAL_PROJECT_WITH_FEATURES_ID    - project id
 *   TEST_PERSONAL_FEATURE_NON_STUB_ID         - story id with content
 *   TEST_PERSONAL_FEATURE_STUB_ID             - story id that is a stub
 *
 * Manual runbook:
 *   - Personal: create a project with at least two features. Give one
 *     feature a real description, acceptance criteria, and a task. Leave
 *     the other in PLACEHOLDER stage with no content.
 *   - Note both story IDs and the project ID; export them as the env
 *     vars above before running the suite.
 *
 * Run:
 *   pnpm --filter web e2e tests/stories/feature-download-single.spec.ts
 */

import { expect, type Page, test } from "@playwright/test";

// ── Test data & guards ────────────────────────────────────────────────────

const TEST_DATA = {
	projectId:
		process.env.TEST_PERSONAL_PROJECT_WITH_FEATURES_ID ??
		"<personal-project-id>",
	storyId:
		process.env.TEST_PERSONAL_FEATURE_NON_STUB_ID ?? "<personal-story-id>",
	stubStoryId:
		process.env.TEST_PERSONAL_FEATURE_STUB_ID ?? "<personal-stub-id>",
} as const;

function isPlaceholder(value: string): boolean {
	return value.startsWith("<") && value.endsWith(">");
}

function skipIfAnyPlaceholder(...values: string[]): void {
	for (const v of values) {
		if (isPlaceholder(v)) {
			test.skip();
			return;
		}
	}
}

// ── Page helpers ──────────────────────────────────────────────────────────

function workspaceUrl(projectId: string, storyId: string): string {
	return `/app/projects/${projectId}/stories/${storyId}`;
}

/** Wait for the workspace header to render the Download trigger. */
async function gotoWorkspace(
	page: Page,
	projectId: string,
	storyId: string,
): Promise<void> {
	await page.goto(workspaceUrl(projectId, storyId));
	await page
		.getByRole("button", { name: /^download$/i })
		.first()
		.waitFor({ state: "visible", timeout: 15_000 });
}

/** Open the workspace Download dropdown, click a format item, return the download. */
async function captureFormatDownload(
	page: Page,
	formatLabel: RegExp,
): Promise<{ filename: string; path: string }> {
	await page
		.getByRole("button", { name: /^download$/i })
		.first()
		.click();
	const [download] = await Promise.all([
		page.waitForEvent("download", { timeout: 30_000 }),
		page.getByRole("menuitem", { name: formatLabel }).click(),
	]);
	const filename = download.suggestedFilename();
	const path = await download.path();
	if (!path) {
		throw new Error(
			`Download for ${filename} did not produce a local path`,
		);
	}
	return { filename, path };
}

// ── Tests ─────────────────────────────────────────────────────────────────

test.describe("Feature export — single feature (workspace placement)", () => {
	test.beforeEach(() => {
		skipIfAnyPlaceholder(TEST_DATA.projectId, TEST_DATA.storyId);
	});

	test("Markdown export saves a .md file", async ({ page }) => {
		await gotoWorkspace(page, TEST_DATA.projectId, TEST_DATA.storyId);
		const { filename } = await captureFormatDownload(page, /markdown/i);
		expect(filename).toMatch(/\.md$/i);
	});

	test("PDF export saves a .pdf file", async ({ page }) => {
		await gotoWorkspace(page, TEST_DATA.projectId, TEST_DATA.storyId);
		const { filename } = await captureFormatDownload(page, /pdf/i);
		expect(filename).toMatch(/\.pdf$/i);
	});

	test("DOCX export saves a .docx file", async ({ page }) => {
		await gotoWorkspace(page, TEST_DATA.projectId, TEST_DATA.storyId);
		const { filename } = await captureFormatDownload(page, /word/i);
		expect(filename).toMatch(/\.docx$/i);
	});
});

test.describe("Feature export — stub blocking", () => {
	test.beforeEach(() => {
		skipIfAnyPlaceholder(TEST_DATA.projectId, TEST_DATA.stubStoryId);
	});

	test("Stub feature shows the warning toast and does NOT trigger a download", async ({
		page,
	}) => {
		await gotoWorkspace(page, TEST_DATA.projectId, TEST_DATA.stubStoryId);

		// Listen for downloads; assert none is fired during the click.
		let downloadFired = false;
		page.on("download", () => {
			downloadFired = true;
		});

		await page
			.getByRole("button", { name: /^download$/i })
			.first()
			.click();
		await page.getByRole("menuitem", { name: /markdown/i }).click();

		// The toast is sourced from `projects.stories.download.stubBlocked`.
		// We assert on a stable substring rather than the full English copy
		// so a future i18n tweak does not break this smoke test.
		await expect(page.getByText(/enough content to export/i)).toBeVisible({
			timeout: 5_000,
		});

		// Give the page a beat; a synchronous download would fire by now.
		await page.waitForTimeout(500);
		expect(downloadFired).toBe(false);
	});
});
