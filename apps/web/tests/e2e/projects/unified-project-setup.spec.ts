/**
 * E2E: Unified Project Setup Wizard (spec 2026-05-27-unified-project-setup-wizard).
 *
 * Spec: specs/2026-05-27-unified-project-setup-wizard/spec.md §3 (AC#1–4),
 *   §12.3 (E2E scenario list). Tasks: tasks.md §7.1.
 *
 * Covers the four acceptance criteria across BOTH personal (`/app/...`) and
 * org (`/app/{slug}/...`) contexts. Assertions are aligned to the ACTUAL
 * post-create routing shipped by TG3 + TG4 (which the spec's §12.3 predates):
 *
 *   - Connected repo and/or backlog  → fires `existingSetup.start({ skipAutoSync })`
 *                                       (fire-and-forget) then REDIRECTS straight
 *                                       to the project page (NO finish-setup step).
 *   - Brief-only / minimal (no repo, no backlog, no documents) → lands on the
 *                                       in-wizard FINISH-SETUP step (id 6) hosting
 *                                       transcript linking + a "Go to project"
 *                                       primary action / skip.
 *   - Documents selected, no integration → advances to the doc-gen step (5);
 *                                       redirect on generation completion.
 *
 * So this spec asserts the finish-setup step + transcript skip on the BRIEF-ONLY
 * path (outcome 2), and the DIRECT redirect on the connected path (outcome 1).
 *
 * ── Runnable vs credential/infra-dependent ───────────────────────────────────
 * RUNNABLE against a local stack + a seeded signed-in user, NO external creds:
 *   - AC#1 — wizard renders directly, no New-vs-Existing chooser, both optional
 *            cards present and COLLAPSED.
 *   - AC#3 — brief-only project (cards untouched, no documents) creates without
 *            error and lands on the finish-setup step.
 *   - D4   — finish-setup hosts transcript linking and is skippable
 *            ("Go to project" works without linking).
 *   - AC#2 (partial) — expanding the Repository card reveals ALL THREE provider
 *            entry points (GitHub, GitLab, Azure DevOps).
 *   - Connected-repo routing — a repository URL typed directly into the URL row
 *            (incl. an `https://dev.azure.com/...` URL) drives the connected path
 *            (`existingSetup.start` + direct redirect, NO finish-setup). This
 *            needs NO Azure DevOps MCP credentials — `codebaseRepoUrls` is the
 *            source of truth the routing keys off.
 *   - Redirects — `projects/new/existing` + `projects/new/create` (personal +
 *            org) 302 to the unified wizard, preserving `?step` / `?projectId`.
 *
 * CREDENTIAL / INFRA-DEPENDENT (gated behind env vars; CI skips by default):
 *   - AC#2 live ADO picker — driving the `AzureDevOpsPatRepoPicker` dialog
 *            (PAT-connect flow) to pick a real repo: phase 1 fills a read-only
 *            PAT + organization (or a `dev.azure.com` repo URL) and clicks
 *            Connect, which calls `projects.azureDevOps.listRepos`; phase 2
 *            picks a repo from the grouped (by ADO project) multi-select list
 *            and confirms. Requires a real ADO PAT — there is no MCP server in
 *            this flow. Annotated + env-gated, NOT silently passing.
 *   - AC#4 backlog connect + cascade + surfacing — connecting a PM tool/board
 *            (and the ADO project→team cascade), then asserting (a) redirect,
 *            (b) backlog in `ProjectManagementSettings`, (c) a backlog
 *            `INTEGRATION` row in `ProjectContextsList`, needs a real PM MCP
 *            config (Jira / Linear / Azure DevOps / GitLab / …). Env-gated.
 *
 * Auth: reuses the global `chromium` storageState from `tests/auth.setup.ts`
 * (same as the sibling `projects/*.spec.ts`). Personal vs org context is
 * selected via env var (see TENANTS below) — empty `…_ORG_SLUG` ⇒ personal.
 *
 * Run locally (drop nothing — CI-safe; credential legs self-skip):
 *   pnpm --filter web e2e tests/e2e/projects/unified-project-setup.spec.ts
 *
 * To exercise the org context, set TEST_UPS_ORG_SLUG=<your-org-slug>.
 * To exercise the live ADO repo picker (PAT-connect flow), set:
 *   TEST_UPS_ADO_PAT      — a read-only Azure DevOps PAT (Code: Read scope).
 *                            REQUIRED for the ADO picker leg.
 *   TEST_UPS_ADO_ORG      — the ADO organization name OR a full
 *                            `https://dev.azure.com/{org}/...` repo URL.
 *                            REQUIRED for the ADO picker leg.
 *   TEST_UPS_ADO_PROJECT  — OPTIONAL: an ADO project name to scope the repo
 *                            selection to a specific group; when unset, the
 *                            first discovered repo is selected.
 * To exercise the backlog connect/surfacing leg (AC#4), set:
 *   TEST_UPS_PM_TOOL_LABEL     — the PMToolSelect option label for a configured
 *                                 PM MCP server (e.g. "Azure DevOps", "Jira")
 *   TEST_UPS_PM_CONTAINER_LABEL — the board/container option label to select
 * (plus TEST_UPS_ADO_TEAM_LABEL when the PM tool is Azure DevOps).
 */

import { expect, type Page, test } from "@playwright/test";

// ──────────────────────────────────────────────────────────────────────────
// Tenant parameterization: run the credential-free scenarios for personal and
// (when a slug is provided) org. Empty slug ⇒ personal `/app/...` routes.
// ──────────────────────────────────────────────────────────────────────────
const ORG_SLUG = process.env.TEST_UPS_ORG_SLUG ?? "";

const TENANTS: Array<{ label: string; slug: string }> = [
	{ label: "personal", slug: "" },
	...(ORG_SLUG ? [{ label: "org", slug: ORG_SLUG }] : []),
];

// Credential-dependent fixtures for the live-picker / backlog legs.
// The ADO picker is now PAT-based (PR #1219 — `AzureDevOpsPatRepoPicker`): the
// connect step needs a real read-only PAT + organization, NOT an MCP server.
const ADO_PAT = process.env.TEST_UPS_ADO_PAT ?? "";
const ADO_ORG = process.env.TEST_UPS_ADO_ORG ?? "";
// Optional: scope the repo selection to a specific ADO project group.
const ADO_PROJECT = process.env.TEST_UPS_ADO_PROJECT ?? "";
const PM_TOOL_LABEL = process.env.TEST_UPS_PM_TOOL_LABEL ?? "";
const PM_CONTAINER_LABEL = process.env.TEST_UPS_PM_CONTAINER_LABEL ?? "";

/** Escape user-supplied env values before embedding them in a RegExp. */
function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function newProjectUrl(slug: string): string {
	return slug ? `/app/${slug}/projects/new` : "/app/projects/new";
}

/** The project-page URL the wizard redirects to (path ends with the projectId). */
function projectUrlPattern(slug: string): RegExp {
	return slug
		? new RegExp(`/app/${slug}/projects/[^/?#]+`)
		: /\/app\/projects\/[^/?#]+/;
}

/**
 * Minimal page-object for the unified wizard. Keeps the scenarios readable and
 * the selectors in one place — all hooks are stable `data-testid`s / roles /
 * labels that exist in the TG1–TG4 components (no new test-ids were added).
 */
class UnifiedWizard {
	constructor(
		private readonly page: Page,
		private readonly slug: string,
	) {}

	async open(query = ""): Promise<void> {
		await this.page.goto(`${newProjectUrl(this.slug)}${query}`);
		// The unified wizard's page-level heading. Its presence (and the ABSENCE
		// of any New-vs-Existing chooser, asserted separately) is the AC#1 signal.
		await expect(
			this.page.getByRole("heading", { name: /create new project/i }),
		).toBeVisible({ timeout: 20_000 });
	}

	nameInput() {
		return this.page.getByLabel(/project name/i);
	}

	backlogCard() {
		return this.page.getByTestId("backlog-card");
	}

	backlogTrigger() {
		return this.page.getByTestId("backlog-card-trigger");
	}

	repositoryCard() {
		return this.page.getByTestId("repository-card");
	}

	repositoryTrigger() {
		return this.page.getByTestId("repository-card-trigger");
	}

	/** Fill the name and wait for the DRAFT autosave so a real projectId exists. */
	async fillNameAndWaitForDraft(name: string): Promise<void> {
		await this.nameInput().fill(name);
		await this.nameInput().blur();
		// Autosave badge flips to "Draft saved" once the DRAFT row is persisted.
		await expect(this.page.getByText(/draft saved/i).first()).toBeVisible({
			timeout: 20_000,
		});
	}

	/**
	 * Advance from the Brief step to the Review step (the standard, non-code
	 * flow: Brief → Tech Stack → Modules → Review). Clicks "Continue" until the
	 * "Create Project" button is visible. Behavior-first: we wait for the create
	 * affordance rather than counting clicks.
	 */
	async advanceToReview(): Promise<void> {
		const createButton = this.page.getByRole("button", {
			name: /^create project$/i,
		});
		const continueButton = this.page.getByRole("button", {
			name: /^continue$/i,
		});
		// At most 4 hops (Brief→TechStack→Modules→Review) — bounded loop with a
		// per-iteration wait, no arbitrary sleeps.
		for (let i = 0; i < 5; i++) {
			if (await createButton.isVisible().catch(() => false)) {
				return;
			}
			await continueButton.click();
			// Wait for either the next Continue or the Create button to settle.
			await expect(continueButton.or(createButton).first()).toBeVisible({
				timeout: 10_000,
			});
		}
		await expect(createButton).toBeVisible({ timeout: 10_000 });
	}

	async clickCreate(): Promise<void> {
		await this.page
			.getByRole("button", { name: /^create project$/i })
			.click();
	}
}

// ──────────────────────────────────────────────────────────────────────────
// AC#1 + AC#3 + D4: the credential-free core. Parameterized per tenant.
// ──────────────────────────────────────────────────────────────────────────
for (const tenant of TENANTS) {
	test.describe(`Unified Project Setup — ${tenant.label} context`, () => {
		test("AC#1: renders the unified wizard with no New-vs-Existing chooser; both optional cards present and collapsed", async ({
			page,
		}) => {
			const wizard = new UnifiedWizard(page, tenant.slug);
			await wizard.open();

			// No chooser: the removed `CreateProjectChoiceScreen` offered two
			// "Create new" / "Existing project" cards. Neither affordance exists.
			await expect(
				page.getByRole("heading", {
					name: /existing project/i,
				}),
			).toHaveCount(0);
			await expect(
				page.getByRole("button", { name: /^existing project$/i }),
			).toHaveCount(0);
			// The unified Brief step renders both optional cards.
			await expect(wizard.backlogCard()).toBeVisible();
			await expect(wizard.repositoryCard()).toBeVisible();

			// Collapsed by default: triggers carry aria-expanded="false" and the
			// expanded regions are not rendered (Radix Collapsible).
			await expect(wizard.backlogTrigger()).toHaveAttribute(
				"aria-expanded",
				"false",
			);
			await expect(wizard.repositoryTrigger()).toHaveAttribute(
				"aria-expanded",
				"false",
			);
			// The collapsed state hides the PM-tool select and the provider
			// buttons (only present inside the expanded region).
			await expect(
				page.getByTestId("repository-github-button"),
			).toHaveCount(0);
		});

		test("AC#3 + D4: brief-only project creates without error, lands on the finish-setup step, and 'Go to project' navigates to the project", async ({
			page,
		}) => {
			const wizard = new UnifiedWizard(page, tenant.slug);
			await wizard.open();

			const name = `UPS ${tenant.label} brief-only ${Date.now()}`;
			await wizard.fillNameAndWaitForDraft(name);

			// Both optional cards remain untouched (collapsed) — no repo, no
			// backlog. No documents added ⇒ the brief-only terminal path.
			await wizard.advanceToReview();
			await wizard.clickCreate();

			// Success toast confirms the create did not error (AC#3).
			await expect(
				page.getByText(/project created successfully/i),
			).toBeVisible({ timeout: 30_000 });

			// D4 / real routing: brief-only lands on the in-wizard FINISH-SETUP
			// step, NOT a redirect. The finish step's "Go to project" primary
			// action is the signal.
			const goToProject = page.getByTestId("finish-go-to-project");
			await expect(goToProject).toBeVisible({ timeout: 15_000 });
			// Still on the wizard route (finish step is in-wizard), not the
			// project page yet.
			expect(page.url()).toContain("/projects/new");
			// The finish step confirms what was set up (the brief summary row).
			await expect(
				page.getByRole("heading", { name: /what was set up/i }),
			).toBeVisible();

			// D4: transcripts are skippable — "Go to project" works WITHOUT
			// linking any meeting.
			await goToProject.click();
			await expect(page).toHaveURL(projectUrlPattern(tenant.slug), {
				timeout: 30_000,
			});
			// Landed on the real project page (not back on the wizard).
			expect(page.url()).not.toContain("/projects/new");
		});

		test("D4: the finish-setup step hosts meeting-transcript linking (MeetingTranscriptSyncSettings)", async ({
			page,
		}) => {
			const wizard = new UnifiedWizard(page, tenant.slug);
			await wizard.open();

			const name = `UPS ${tenant.label} finish ${Date.now()}`;
			await wizard.fillNameAndWaitForDraft(name);
			await wizard.advanceToReview();
			await wizard.clickCreate();

			await expect(page.getByTestId("finish-go-to-project")).toBeVisible({
				timeout: 30_000,
			});

			// The transcript-linking section is present on the finish step
			// (reused MeetingTranscriptSyncSettings → LinkedMeetingSelector).
			await expect(
				page.getByRole("heading", {
					name: /link meeting transcripts/i,
				}),
			).toBeVisible();
		});

		test("AC#2 (entry points): expanding the Repository card reveals GitHub, GitLab, and Azure DevOps pickers together", async ({
			page,
		}) => {
			const wizard = new UnifiedWizard(page, tenant.slug);
			await wizard.open();

			await wizard.repositoryTrigger().click();
			await expect(wizard.repositoryTrigger()).toHaveAttribute(
				"aria-expanded",
				"true",
			);

			// All three provider entry points are present in the expanded card
			// (ADO folded in from the Existing flow — AC#2).
			await expect(
				page.getByTestId("repository-github-button"),
			).toBeVisible();
			await expect(
				page.getByTestId("repository-gitlab-button"),
			).toBeVisible();
			await expect(
				page.getByTestId("repository-ado-button"),
			).toBeVisible();
		});

		test("Former-existing routing: a repository URL (incl. Azure DevOps) drives the connected path — direct redirect, NO finish-setup", async ({
			page,
		}) => {
			const wizard = new UnifiedWizard(page, tenant.slug);
			await wizard.open();

			const name = `UPS ${tenant.label} repo-url ${Date.now()}`;
			await wizard.fillNameAndWaitForDraft(name);

			// Expand the Repository card and type an Azure DevOps repo URL into
			// the URL row. This populates `codebaseRepoUrls` (the source of truth
			// the connected-repo routing keys off) WITHOUT needing the live ADO
			// picker or any MCP credentials — it exercises the same outcome-1
			// routing (existingSetup.start + direct redirect).
			await wizard.repositoryTrigger().click();
			const urlRow = page.getByLabel(/repository urls/i).first();
			await expect(urlRow).toBeVisible();
			await urlRow.fill(
				"https://dev.azure.com/contoso/Contoso/_git/contoso-api",
			);
			await urlRow.blur();

			// Selecting any repo flips the wizard into the code-based collapse
			// (D13): Brief → Review only, and the create button becomes
			// "Create & Analyze".
			const createAnalyze = page.getByRole("button", {
				name: /create & analyze/i,
			});
			// Advance to the (code-based) Review step.
			const continueButton = page.getByRole("button", {
				name: /^continue$/i,
			});
			await continueButton.click();
			await expect(createAnalyze).toBeVisible({ timeout: 10_000 });
			await createAnalyze.click();

			await expect(
				page.getByText(/project created successfully/i),
			).toBeVisible({ timeout: 30_000 });

			// Connected path (outcome 1): direct redirect to the project page,
			// NOT the finish-setup step.
			await expect(page).toHaveURL(projectUrlPattern(tenant.slug), {
				timeout: 30_000,
			});
			expect(page.url()).not.toContain("/projects/new");
			await expect(page.getByTestId("finish-go-to-project")).toHaveCount(
				0,
			);
		});

		test("Back-compat: /projects/new/existing redirects to the unified wizard, preserving ?step/?projectId", async ({
			page,
		}) => {
			const base = tenant.slug ? `/app/${tenant.slug}` : "/app";
			await page.goto(`${base}/projects/new/existing?step=2`);

			// 302 → unified wizard; the chooser is gone and the wizard heading
			// renders. `?step` is preserved on the destination URL.
			await expect(
				page.getByRole("heading", { name: /create new project/i }),
			).toBeVisible({ timeout: 20_000 });
			await expect
				.poll(() => new URL(page.url()).pathname, { timeout: 10_000 })
				.toMatch(/\/projects\/new$/);
			expect(page.url()).toContain("step=2");
		});

		test("Back-compat: /projects/new/create redirects to the unified wizard", async ({
			page,
		}) => {
			const base = tenant.slug ? `/app/${tenant.slug}` : "/app";
			await page.goto(`${base}/projects/new/create`);

			await expect(
				page.getByRole("heading", { name: /create new project/i }),
			).toBeVisible({ timeout: 20_000 });
			await expect
				.poll(() => new URL(page.url()).pathname, { timeout: 10_000 })
				.toMatch(/\/projects\/new$/);
		});
	});
}

// ──────────────────────────────────────────────────────────────────────────
// AC#2 (live ADO picker) — credential-dependent, PAT-connect flow (PR #1219).
// The `AzureDevOpsPatRepoPicker` is two-phase: (1) CONNECT — fill a read-only
// PAT + organization (or a dev.azure.com repo URL) and click Connect, which
// calls `projects.azureDevOps.listRepos`; (2) REPO-LIST — pick a repo from the
// grouped (by ADO project) multi-select list, then confirm. NO MCP server is
// involved. Skips unless TEST_UPS_ADO_PAT + TEST_UPS_ADO_ORG are both set, so
// CI stays green.
// ──────────────────────────────────────────────────────────────────────────
test.describe("Unified Project Setup — live Azure DevOps repo picker (AC#2)", () => {
	test.skip(
		!(ADO_PAT && ADO_ORG),
		"Requires a real Azure DevOps PAT. Set TEST_UPS_ADO_PAT + TEST_UPS_ADO_ORG (+ optionally TEST_UPS_ADO_PROJECT / TEST_UPS_ORG_SLUG) to run.",
	);

	test("connect with a PAT, pick a repo, and complete the wizard onto the connected project", async ({
		page,
	}) => {
		const wizard = new UnifiedWizard(page, ORG_SLUG);
		await wizard.open();

		await wizard.fillNameAndWaitForDraft(`UPS ADO PAT ${Date.now()}`);
		await wizard.repositoryTrigger().click();
		await page.getByTestId("repository-ado-button").click();

		// The AzureDevOpsPatRepoPicker dialog ("Select Azure DevOps
		// Repositories") opens on its CONNECT step.
		const dialog = page.getByRole("dialog", {
			name: /select azure devops repositor/i,
		});
		await expect(dialog).toBeVisible({ timeout: 15_000 });

		// ── Phase 1: CONNECT ──────────────────────────────────────────────
		// Fill the organization (bare name or a dev.azure.com repo URL) + the
		// read-only PAT, then click Connect. Both inputs carry <Label>s.
		await dialog
			.getByLabel(/organization or repository url/i)
			.fill(ADO_ORG);
		await dialog.getByLabel(/personal access token/i).fill(ADO_PAT);
		await dialog.getByRole("button", { name: /^connect$/i }).click();

		// ── Phase 2: REPO-LIST ────────────────────────────────────────────
		// Discovery (`listRepos`) resolves into a grouped, multi-select list.
		// When TEST_UPS_ADO_PROJECT is set, expand that project's group so its
		// repos render (only the first group auto-expands); otherwise the
		// auto-expanded first group's repos are already visible.
		if (ADO_PROJECT) {
			const projectGroup = dialog.getByRole("button", {
				name: new RegExp(`^${escapeRegExp(ADO_PROJECT)}`, "i"),
			});
			await expect(projectGroup).toBeVisible({ timeout: 20_000 });
			// Idempotent expand: only click when the group's repos aren't yet
			// shown (clicking an already-expanded group would collapse it).
			const repoInGroup = dialog
				.getByRole("checkbox", { name: /^select /i })
				.first();
			if (!(await repoInGroup.isVisible().catch(() => false))) {
				await projectGroup.click();
			}
		}

		// Repo rows expose a checkbox with aria-label="Select {repoName}". This
		// targets repo selectors only — never the group-header or row-wrapper
		// buttons. Select the first available repo.
		const firstRepo = dialog
			.getByRole("checkbox", { name: /^select /i })
			.first();
		await expect(firstRepo).toBeVisible({ timeout: 20_000 });
		await firstRepo.click();

		// The confirm button reads "Add {N} Repo(s)" and enables once a repo
		// is selected.
		const confirm = dialog.getByRole("button", {
			name: /^add \d+ repos?$/i,
		});
		await expect(confirm).toBeEnabled({ timeout: 10_000 });
		await confirm.click();

		// The dialog closes and the picked repo URL lands in the URL rows
		// (codebaseRepoUrls) — the connected-repo signal.
		await expect(dialog).toBeHidden({ timeout: 20_000 });
		await expect(page.getByText(/dev\.azure\.com/i).first()).toBeVisible({
			timeout: 10_000,
		});

		// Completing the wizard with a connected repo drives the code-based
		// collapse (D13): Brief → Review and a "Create & Analyze" action, then
		// the connected path (outcome 1) — direct redirect to the project page,
		// NOT the finish-setup step.
		const createAnalyze = page.getByRole("button", {
			name: /create & analyze/i,
		});
		const continueButton = page.getByRole("button", {
			name: /^continue$/i,
		});
		await continueButton.click();
		await expect(createAnalyze).toBeVisible({ timeout: 10_000 });
		await createAnalyze.click();

		await expect(
			page.getByText(/project created successfully/i),
		).toBeVisible({ timeout: 30_000 });
		await expect(page).toHaveURL(projectUrlPattern(ORG_SLUG), {
			timeout: 30_000,
		});
		expect(page.url()).not.toContain("/projects/new");
		await expect(page.getByTestId("finish-go-to-project")).toHaveCount(0);
	});
});

// ──────────────────────────────────────────────────────────────────────────
// AC#4 — connect a backlog, complete, and verify it surfaces in BOTH
// ProjectManagementSettings AND ProjectContextsList. Credential-dependent:
// requires a configured PM MCP server. Skips unless the PM fixtures are set.
// ──────────────────────────────────────────────────────────────────────────
test.describe("Unified Project Setup — connect a backlog (AC#2/#4)", () => {
	test.skip(
		!(PM_TOOL_LABEL && PM_CONTAINER_LABEL),
		"Requires a configured PM MCP server. Set TEST_UPS_PM_TOOL_LABEL + TEST_UPS_PM_CONTAINER_LABEL (+ TEST_UPS_ADO_TEAM_LABEL for ADO) to run.",
	);

	test("connecting a backlog redirects to the project, shows in settings, and appears as an INTEGRATION context", async ({
		page,
	}) => {
		const slug = ORG_SLUG;
		const wizard = new UnifiedWizard(page, slug);
		await wizard.open();

		await wizard.fillNameAndWaitForDraft(`UPS backlog ${Date.now()}`);

		// Expand the Backlog card and connect the PM tool + board (ADO cascade
		// when the detected type is azure-devops).
		await wizard.backlogTrigger().click();
		await expect(wizard.backlogTrigger()).toHaveAttribute(
			"aria-expanded",
			"true",
		);

		// PMToolSelect: pick the configured PM tool by its option label.
		const pmSelect = page.getByRole("combobox").first();
		await pmSelect.click();
		await page
			.getByRole("option", { name: new RegExp(PM_TOOL_LABEL, "i") })
			.click();

		// Board / container select appears after the tool resolves.
		const containerSelect = page
			.getByRole("combobox")
			.filter({ hasText: /select a (board|project)/i })
			.first();
		await expect(containerSelect).toBeVisible({ timeout: 20_000 });
		await containerSelect.click();
		await page
			.getByRole("option", {
				name: new RegExp(PM_CONTAINER_LABEL, "i"),
			})
			.click();

		// ADO project→team cascade: select a board/team when configured.
		const adoTeamLabel = process.env.TEST_UPS_ADO_TEAM_LABEL ?? "";
		if (adoTeamLabel) {
			const teamSelect = page
				.getByRole("combobox")
				.filter({ hasText: /select a board\/team/i })
				.first();
			await expect(teamSelect).toBeVisible({ timeout: 20_000 });
			await teamSelect.click();
			await page
				.getByRole("option", {
					name: new RegExp(adoTeamLabel, "i"),
				})
				.click();
		}

		// Complete. A connected backlog routes through the connected path
		// (outcome 1): direct redirect to the project page.
		await wizard.advanceToReview();
		await page
			.getByRole("button", { name: /create (project|& analyze)/i })
			.click();

		await expect(page).toHaveURL(projectUrlPattern(slug), {
			timeout: 30_000,
		});
		expect(page.url()).not.toContain("/projects/new");

		// (b) AC#4: the backlog shows in ProjectManagementSettings — the
		// "Connected to {board}" status. Settings tab on the project page.
		await page.getByRole("button", { name: "Settings" }).click();
		await expect(
			page.getByText(
				new RegExp(`connected to ${PM_CONTAINER_LABEL}`, "i"),
			),
		).toBeVisible({ timeout: 20_000 });

		// (c) AC#4: the backlog appears as an INTEGRATION row in the Context
		// list (D8). The card title carries the board/container name.
		await page.getByRole("button", { name: "Context" }).click();
		await expect(
			page
				.getByRole("heading", {
					name: new RegExp(PM_CONTAINER_LABEL, "i"),
				})
				.first(),
		).toBeVisible({ timeout: 20_000 });
	});
});
