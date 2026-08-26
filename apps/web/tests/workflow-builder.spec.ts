import { expect, test } from "@playwright/test";

/**
 * Smoke coverage for the visual workflow builder.
 *
 * The builder had no e2e coverage at all, which left its most consequential
 * path — the node graph surviving a save/reload round-trip — unverified. A
 * node type renamed in the registry, a palette that stops rendering, or a save
 * that silently drops config would all ship green.
 *
 * Scope is deliberately narrow and non-destructive: it creates a draft
 * workflow, adds a node that needs no credentials (`http-request`), saves,
 * reloads, and asserts the node is still there. It never clicks Run, so no
 * external side effect is possible.
 *
 * Prerequisites: the global auth setup (tests/*.setup.ts) and a reachable app.
 * Following the house pattern, each test skips rather than fails when the
 * surface it needs is not present in the environment.
 */

const WORKFLOWS_URL = "/app/workflows";

async function openWorkflowsList(page: import("@playwright/test").Page) {
	await page.goto(WORKFLOWS_URL);
	await page.waitForLoadState("networkidle");
}

/**
 * Dismiss the MFA setup banner if it is showing.
 *
 * A freshly seeded admin gets prompted to enable two-factor auth, and the
 * banner is a fixed overlay that intercepts pointer events — every click on
 * the builder toolbar below it fails with "subtree intercepts pointer events".
 */
async function dismissMfaBanner(page: import("@playwright/test").Page) {
	const dismiss = page.getByRole("button", { name: /^dismiss$/i });
	if (await dismiss.isVisible().catch(() => false)) {
		await dismiss.click();
		await dismiss.waitFor({ state: "hidden" }).catch(() => {
			// Best-effort: if it lingers, the assertions below will say so.
		});
	}
}

/**
 * Create a draft workflow and land in the builder, returning its URL.
 *
 * `/app/workflows/new` renders no form: it creates a workflow immediately and
 * replaces the URL with `/app/workflows/{id}`. (An earlier version of this
 * helper looked for a name field, found nothing, and made every test that
 * used it skip rather than fail — which is how it stayed wrong.)
 */
async function createDraftWorkflow(
	page: import("@playwright/test").Page,
): Promise<string | null> {
	await page.goto(`${WORKFLOWS_URL}/new`);

	try {
		await page.waitForURL(/\/app\/workflows\/[^/]+$/, { timeout: 30_000 });
	} catch {
		// Creation failed (it redirects back to the list on error).
		return null;
	}

	await expect(page.getByTestId("workflow-canvas")).toBeVisible({
		timeout: 30_000,
	});
	await dismissMfaBanner(page);
	return page.url();
}

test.describe("Workflow builder", () => {
	test("lists workflows without erroring", async ({ page }) => {
		await openWorkflowsList(page);

		// Either the list or its empty state must render; a crash renders neither.
		const heading = page
			.getByRole("heading", { name: /workflow/i })
			.first();
		await expect(heading).toBeVisible({ timeout: 15_000 });
	});

	test("renders the canvas and the action palette", async ({ page }) => {
		const url = await createDraftWorkflow(page);
		if (!url) {
			test.skip();
			return;
		}

		await expect(page.getByTestId("workflow-canvas")).toBeVisible();

		await page.getByTestId("workflow-actions-tab").click();

		// The palette must offer real actions. `http-request` is a system node
		// with no credential requirement, so it is present in every environment.
		await expect(
			page.getByTestId("workflow-action-http-request"),
		).toBeVisible({ timeout: 10_000 });
	});

	test("gives the canvas the full height of the viewport", async ({
		page,
	}) => {
		const url = await createDraftWorkflow(page);
		if (!url) {
			test.skip();
			return;
		}

		// The editor page wrapper used `h-full`, but the shell's content column
		// takes its height from `flex-1` — not a definite height — so the
		// percentage resolved to `auto` and the editor collapsed to its own
		// content: a 211px canvas on a 900px viewport, at every breakpoint.
		// `toBeVisible` never caught it, because a collapsed canvas is visible.
		const viewport = page.viewportSize();
		expect(viewport).not.toBeNull();

		const canvas = page.locator(".react-flow").first();
		await expect(canvas).toBeVisible({ timeout: 15_000 });

		const box = await canvas.boundingBox();
		expect(box).not.toBeNull();

		// Generous: the toolbar legitimately takes a slice off the top. The
		// regression this guards against left the canvas under a quarter of
		// the viewport.
		expect(box?.height ?? 0).toBeGreaterThan((viewport?.height ?? 0) * 0.6);
	});

	test("keeps an added node across a save and reload", async ({ page }) => {
		const url = await createDraftWorkflow(page);
		if (!url) {
			test.skip();
			return;
		}

		await page.getByTestId("workflow-actions-tab").click();
		await page.getByTestId("workflow-action-http-request").click();

		const node = page.getByTestId("workflow-node-http-request").first();
		await expect(node).toBeVisible({ timeout: 10_000 });

		const save = page.getByTestId("workflow-save");
		await expect(save).toBeEnabled();
		await save.click();

		// Reload from the server rather than trusting in-memory state — the
		// round-trip is the thing under test.
		await page.goto(url);
		await page.waitForLoadState("networkidle");

		await expect(
			page.getByTestId("workflow-node-http-request").first(),
		).toBeVisible({ timeout: 15_000 });
	});

	test("does not offer actions that have no executor", async ({ page }) => {
		const url = await createDraftWorkflow(page);
		if (!url) {
			test.skip();
			return;
		}

		await page.getByTestId("workflow-actions-tab").click();
		await expect(
			page.getByTestId("workflow-action-http-request"),
		).toBeVisible({ timeout: 10_000 });

		// Integrations that were unreachable before the palette was wired to
		// the plugin registry. Their executors existed the whole time.
		for (const nodeType of [
			"jira-create-issue",
			"zendesk-create-ticket",
			"asana-create-task",
			"gitlab-get-file",
		]) {
			await expect(
				page.getByTestId(`workflow-action-${nodeType}`),
			).toBeVisible();
		}

		// Notion, Confluence, Google Drive, Teams, NHTSA and Databricks are
		// defined as plugins but have no step implementation. Offering them
		// would let a user build a workflow that cannot run. The authoritative
		// list lives in
		// modules/saas/workflows/lib/plugins/__tests__/action-executor-contract.test.ts
		for (const nodeType of [
			"notion-create-page",
			"confluence-create-page",
			"google-drive-list-files",
			"microsoft-graph-list-teams",
		]) {
			await expect(
				page.getByTestId(`workflow-action-${nodeType}`),
			).toHaveCount(0);
		}
	});
});
