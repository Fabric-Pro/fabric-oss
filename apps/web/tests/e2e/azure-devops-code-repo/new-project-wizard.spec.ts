/**
 * E2E: Azure DevOps code-repository — NEW-project wizard journey (mocked)
 *
 * Spec:  fabric/specs/2026-05-27-azure-devops-code-repository/spec.md §9.3, §8.1 (V2).
 * Tasks: fabric/specs/2026-05-27-azure-devops-code-repository/tasks.md Task 6.1.
 *
 * Journey under test (all ADO network calls MOCKED — no real ADO org/PAT;
 * live clone+index is TG6.2, deferred to staging):
 *
 *   1. Open the new-project wizard at `/app/projects/new/create`.
 *   2. Step 1 (Basic Info) → enter a project name → the "Code Repository"
 *      section renders the Azure DevOps card → click its "Add" button to open
 *      the shared `AzureDevOpsPatRepoPicker`.
 *   3. Connect step: type an org/URL + a PAT (type=password) → "Connect" fires
 *      `projects.azureDevOps.listRepos` (MOCKED → grouped repos).
 *   4. Grouped multi-select repo list → select repo(s) → "Add N Repos" fires
 *      `projects.repositoryIntegrations.connect` per repo (MOCKED → success)
 *      because the wizard holds a DRAFT projectId by confirm time.
 *   5. Advance to the review step → "Create & Analyze" fires `projects.create`
 *      (MOCKED) then `projects.azureDevOps.startCodeSetup` (MOCKED → SCANNING)
 *      → asserts the wizard lands on the project-detail page `/app/projects/{id}`.
 *
 * Strategy: mirrors `tests/gitlab-issues-sync.spec.ts` /
 * `tests/pm-import-filtering.spec.ts` — the oRPC procedures are intercepted via
 * `page.route` using the canonical RPC envelope (`{ json: payload }` out,
 * `{ json: T }` in), so no live ADO connection, Temporal worker, or seeded
 * project is required. The picker/wizard UI selectors mirror the components
 * landed by TG2/TG3 (`AzureDevOpsPatRepoPicker.tsx`,
 * `WizardIntegrationsSection.tsx`, `ProjectCreationWizard.tsx`,
 * `wizard/BasicInfoStep.tsx`).
 *
 * Status: SKIPPED by default (set `RUN_ADO_E2E=1` to opt in). Same deferral
 * convention as the sibling `tests/e2e/unified-context-wizard/*` and
 * `tests/e2e/projects/*` specs: even though every ADO call is mocked, the suite
 * still needs (a) a built+running web app on :3001 (the playwright.config
 * `webServer` handles this) and (b) the `auth.setup.ts` storageState (a
 * signed-in seeded user) so the wizard route is reachable post-login. Mocking
 * does not remove those two host requirements, so we gate on the env flag and
 * defer the always-on green bar to CI/staging.
 *
 * Run (with the local stack + a seeded auth user available):
 *   RUN_ADO_E2E=1 pnpm --filter web e2e tests/e2e/azure-devops-code-repo/new-project-wizard.spec.ts
 */

import { expect, type Page, type Route, test } from "@playwright/test";
import {
	orpcErrorResponse,
	orpcJsonResponse,
	unwrapOrpcInput,
} from "./_orpc-mock";

// ---------------------------------------------------------------------------
// Opt-in guard (see file header)
// ---------------------------------------------------------------------------

const RUN_ADO_E2E = process.env.RUN_ADO_E2E === "1";

// ---------------------------------------------------------------------------
// Fixtures — a grouped ADO discovery result (parity with the §3.2.1 shape the
// `listAzureDevOpsProjectsAndRepos` connector helper returns).
// ---------------------------------------------------------------------------

const ADO_ORG = "contoso-eng";
const ADO_PROJECT = "Platform";

/** Canonical web URL for an ADO repo (matches the connector helper's output). */
function adoRepoUrl(org: string, project: string, repo: string): string {
	return `https://dev.azure.com/${org}/${project}/_git/${repo}`;
}

interface AdoRepoFixture {
	name: string;
	projectName: string;
	fullName: string;
	htmlUrl: string;
	defaultBranch: string;
	isPrivate: boolean;
	language: null;
}

function buildRepo(repo: string, project = ADO_PROJECT): AdoRepoFixture {
	const url = adoRepoUrl(ADO_ORG, project, repo);
	return {
		name: repo,
		projectName: project,
		fullName: url,
		htmlUrl: url,
		defaultBranch: "main",
		isPrivate: true,
		language: null,
	};
}

const REPOS: AdoRepoFixture[] = [
	buildRepo("checkout-service"),
	buildRepo("billing-api"),
	buildRepo("design-tokens", "Design"),
];

/** The grouped `listRepos` response (grouped by ADO project = "owner"). */
function buildListReposResponse() {
	const byProject = new Map<string, AdoRepoFixture[]>();
	for (const repo of REPOS) {
		const list = byProject.get(repo.projectName) ?? [];
		list.push(repo);
		byProject.set(repo.projectName, list);
	}
	return {
		configured: true,
		organization: ADO_ORG,
		groups: Array.from(byProject.entries()).map(([owner, repos]) => ({
			owner,
			repos,
		})),
		error: null,
	};
}

// ---------------------------------------------------------------------------
// Mock handles
// ---------------------------------------------------------------------------

interface ConnectCall {
	projectId: string;
	provider: string;
	authMethod: string;
	repositoryUrl: string;
	repositoryName: string;
	azureOrganization?: string;
	pat?: string;
}

interface AdoMockHandles {
	saveDraftCalls: Array<{ hasPat: boolean }>;
	createCalls: Array<{ name: string; hasPat: boolean }>;
	connectCalls: ConnectCall[];
	startCodeSetupCalls: Array<{ projectId: string }>;
	listReposCalls: Array<{
		azureOrganization: string;
		pat: string;
		projectId?: string;
	}>;
	createdProjectId: string;
}

/**
 * Install the ADO oRPC interceptors for the full new-project create journey.
 * The returned handles capture each call so assertions can inspect payloads
 * (e.g. assert the PAT round-tripped to `connect`, never to `create`/draft).
 */
async function installAdoMocks(
	page: Page,
	options: { listReposOverride?: () => unknown } = {},
): Promise<AdoMockHandles> {
	const createdProjectId = `proj_${Date.now()}`;
	const handles: AdoMockHandles = {
		saveDraftCalls: [],
		createCalls: [],
		connectCalls: [],
		startCodeSetupCalls: [],
		listReposCalls: [],
		createdProjectId,
	};

	// saveDraft — the wizard mints a DRAFT projectId so the picker can `connect`
	// per repo at confirm time. Return the SAME id `create` will activate.
	// Guard: the PAT must NEVER appear in the persisted draft payload.
	await page.route(
		"**/api/rpc/projects/saveDraft**",
		async (route: Route) => {
			const input = unwrapOrpcInput<Record<string, unknown>>(
				route.request().postDataJSON() as unknown,
			);
			handles.saveDraftCalls.push({
				hasPat: "pat" in input || "encryptedPat" in input,
			});
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse({
					project: { id: createdProjectId, status: "DRAFT" },
				}),
			});
		},
	);

	// listRepos — PAT-based discovery. Capture creds so we can assert the PAT
	// reached discovery (request-scoped) and the org was parsed correctly.
	await page.route(
		"**/api/rpc/projects/azureDevOps/listRepos**",
		async (route: Route) => {
			const input = unwrapOrpcInput<{
				azureOrganization: string;
				pat: string;
				projectId?: string;
			}>(route.request().postDataJSON() as unknown);
			handles.listReposCalls.push({
				azureOrganization: input.azureOrganization,
				pat: input.pat,
				projectId: input.projectId,
			});
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse(
					(options.listReposOverride ?? buildListReposResponse)(),
				),
			});
		},
	);

	// connect — one integration per selected repo. Capture each payload.
	await page.route(
		"**/api/rpc/projects/repositoryIntegrations/connect**",
		async (route: Route) => {
			const input = unwrapOrpcInput<ConnectCall>(
				route.request().postDataJSON() as unknown,
			);
			handles.connectCalls.push(input);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse({
					integration: { id: `int_${handles.connectCalls.length}` },
					success: true,
				}),
			});
		},
	);

	// create — activate the DRAFT (same id). Capture the name only; the PAT must
	// NEVER appear here.
	await page.route("**/api/rpc/projects/create**", async (route: Route) => {
		const input = unwrapOrpcInput<Record<string, unknown>>(
			route.request().postDataJSON() as unknown,
		);
		handles.createCalls.push({
			name: String(input.name ?? ""),
			hasPat: "pat" in input || "encryptedPat" in input,
		});
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: orpcJsonResponse({
				project: {
					id: createdProjectId,
					name: input.name,
					status: "ACTIVE",
				},
			}),
		});
	});

	// startCodeSetup — flips codeAnalysisStatus to SCANNING.
	await page.route(
		"**/api/rpc/projects/azureDevOps/startCodeSetup**",
		async (route: Route) => {
			const input = unwrapOrpcInput<{ projectId: string }>(
				route.request().postDataJSON() as unknown,
			);
			handles.startCodeSetupCalls.push({ projectId: input.projectId });
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse({
					workflowId: `code-based-setup-ado-${input.projectId}-1`,
					runId: "run_1",
					status: "SCANNING",
				}),
			});
		},
	);

	return handles;
}

// ---------------------------------------------------------------------------
// Page-object-ish helpers (mirror the picker/wizard selectors from TG2/TG3)
// ---------------------------------------------------------------------------

/** Open the ADO picker from the wizard's "Code Repository" → Azure DevOps card. */
async function openAdoPickerFromWizard(page: Page): Promise<void> {
	// The Azure DevOps card renders an <h5>Azure DevOps</h5> with an adjacent
	// "Add" button (WizardIntegrationsSection.tsx). Scope the Add click to the
	// card so we don't hit the GitHub/GitLab "Add" buttons.
	const adoCard = page
		.locator("div")
		.filter({ has: page.getByRole("heading", { name: /^Azure DevOps$/ }) })
		.filter({ has: page.getByRole("button", { name: /^Add$/ }) })
		.last();
	await expect(adoCard).toBeVisible({ timeout: 10_000 });
	await adoCard.getByRole("button", { name: /^Add$/ }).click();
}

/** Complete the picker connect step (org + PAT) and submit. */
async function connectInPicker(
	dialog: ReturnType<Page["getByRole"]>,
	opts: { org: string; pat: string },
): Promise<void> {
	await dialog.getByLabel(/Organization or repository URL/i).fill(opts.org);
	const patInput = dialog.getByLabel(/Personal access token/i);
	await patInput.fill(opts.pat);
	// The PAT field MUST be masked.
	await expect(patInput).toHaveAttribute("type", "password");
	await dialog.getByRole("button", { name: /^Connect$/ }).click();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Azure DevOps code-repo — new-project wizard (mocked)", () => {
	test.skip(
		!RUN_ADO_E2E,
		"Set RUN_ADO_E2E=1 with a running web app + seeded auth user. Mocks remove the ADO/Temporal/DB deps but not the login + reachable-route requirement (see file header).",
	);

	test("ADO card → PAT picker → connect → select → create lands on project detail", async ({
		page,
	}) => {
		const handles = await installAdoMocks(page);

		// (1) Open the wizard.
		await page.goto("/app/projects/new/create");

		// (2) Step 1 — enter a project name; blur to trigger the DRAFT autosave.
		const projectName = `E2E ADO Wizard ${Date.now()}`;
		await page.getByLabel(/project name/i).fill(projectName);
		await page.getByLabel(/project name/i).blur();
		// Wait for the DRAFT to be minted (so the picker has a projectId and runs
		// `connect` at confirm time — the preferred path). saveDraft fired and the
		// "Draft saved" affordance reflects it.
		await expect
			.poll(() => handles.saveDraftCalls.length)
			.toBeGreaterThan(0);
		await expect(page.getByText(/Draft saved/i).first()).toBeVisible({
			timeout: 15_000,
		});
		// Guard: the PAT is never written to the DRAFT.
		expect(handles.saveDraftCalls.every((c) => c.hasPat === false)).toBe(
			true,
		);

		// (2b) Open the shared ADO PAT picker from the Azure DevOps card.
		await openAdoPickerFromWizard(page);

		const dialog = page.getByRole("dialog");
		await expect(
			dialog.getByText(/Select Azure DevOps Repositories/i),
		).toBeVisible({ timeout: 5_000 });

		// (3) Connect step → fires the mocked listRepos.
		await connectInPicker(dialog, {
			org: `https://dev.azure.com/${ADO_ORG}`,
			pat: "ado-pat-secret-value",
		});

		// listRepos received the parsed org + the request-scoped PAT.
		await expect
			.poll(() => handles.listReposCalls.length)
			.toBeGreaterThan(0);
		expect(handles.listReposCalls[0]).toMatchObject({
			azureOrganization: ADO_ORG,
			pat: "ado-pat-secret-value",
		});

		// (4) Grouped repo list renders. Expand the "Platform" group if needed and
		// select two repos via their accessible "Select {name}" checkboxes.
		await expect(
			dialog.getByText(ADO_PROJECT, { exact: false }).first(),
		).toBeVisible({ timeout: 5_000 });

		const checkoutCheckbox = dialog.getByRole("checkbox", {
			name: /Select checkout-service/i,
		});
		// If the group is collapsed, click its header to reveal the rows.
		if ((await checkoutCheckbox.count()) === 0) {
			await dialog
				.getByRole("button", { name: new RegExp(ADO_PROJECT, "i") })
				.first()
				.click();
		}
		await checkoutCheckbox.check();
		await dialog
			.getByRole("checkbox", { name: /Select billing-api/i })
			.check();

		// Footer reflects the selected count and confirms.
		const confirmButton = dialog.getByRole("button", {
			name: /^Add 2 Repos$/i,
		});
		await expect(confirmButton).toBeEnabled();
		await confirmButton.click();

		// (4b) The picker created one integration per selected repo (DRAFT id is
		// present, so connect runs at confirm time — the preferred path).
		await expect.poll(() => handles.connectCalls.length).toBe(2);
		for (const call of handles.connectCalls) {
			expect(call).toMatchObject({
				projectId: handles.createdProjectId,
				provider: "AZURE_DEVOPS",
				authMethod: "PAT",
			});
			// The PAT round-trips to connect (encrypted server-side), and the
			// repo URL is the canonical dev.azure.com web URL.
			expect(call.pat).toBe("ado-pat-secret-value");
			expect(call.repositoryUrl).toContain("dev.azure.com");
		}

		// Dialog closes after confirm.
		await expect(dialog).toBeHidden({ timeout: 5_000 });

		// (4c) The wizard summarises "2 repos added" + chips for each repo.
		await expect(page.getByText(/2 repos added/i)).toBeVisible();
		await expect(
			page.getByText(`${ADO_PROJECT}/checkout-service`),
		).toBeVisible();

		// (5) Selecting ADO repos flips the wizard to the code-based flow — the
		// primary action becomes "Create & Analyze". Advance to the review step.
		await page.getByRole("button", { name: /^Continue$/ }).click();

		const createButton = page.getByRole("button", {
			name: /^Create & Analyze$/,
		});
		await expect(createButton).toBeEnabled({ timeout: 10_000 });
		await createButton.click();

		// `create` fired with the project name — and WITHOUT any PAT field
		// (the credential only ever travels to `connect`; spec §6 / R3).
		await expect.poll(() => handles.createCalls.length).toBeGreaterThan(0);
		expect(handles.createCalls[0]).toMatchObject({
			name: projectName,
			hasPat: false,
		});

		// startCodeSetup fired for the created project.
		await expect
			.poll(() => handles.startCodeSetupCalls.length)
			.toBeGreaterThan(0);
		expect(handles.startCodeSetupCalls[0]).toMatchObject({
			projectId: handles.createdProjectId,
		});

		// (5b) The wizard lands on the project-detail page `/app/projects/{id}`.
		await expect(page).toHaveURL(
			new RegExp(`/app/projects/${handles.createdProjectId}$`),
			{ timeout: 30_000 },
		);
	});

	test("invalid PAT shows an inline error and allows retry without leaving the picker", async ({
		page,
	}) => {
		const handles = await installAdoMocks(page);

		// Force the FIRST listRepos to return the oRPC BAD_REQUEST shape the
		// procedure throws for 401/403 ("Invalid PAT or insufficient
		// permissions"); subsequent calls succeed so retry can proceed.
		let listReposHits = 0;
		await page.unroute("**/api/rpc/projects/azureDevOps/listRepos**");
		await page.route(
			"**/api/rpc/projects/azureDevOps/listRepos**",
			async (route: Route) => {
				listReposHits += 1;
				if (listReposHits === 1) {
					// The oRPC RPC error envelope the client deserializes into an
					// ORPCError (see `_orpc-mock.ts`). The HTTP status MUST match
					// the envelope's status (400) so the client reconstructs the
					// error and surfaces its message to the picker.
					await route.fulfill({
						status: 400,
						contentType: "application/json",
						body: orpcErrorResponse(
							"BAD_REQUEST",
							400,
							"Invalid PAT or insufficient permissions",
						),
					});
					return;
				}
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: orpcJsonResponse(buildListReposResponse()),
				});
			},
		);

		await page.goto("/app/projects/new/create");
		await page
			.getByLabel(/project name/i)
			.fill(`E2E ADO Retry ${Date.now()}`);
		await page.getByLabel(/project name/i).blur();
		await openAdoPickerFromWizard(page);

		const dialog = page.getByRole("dialog");
		await connectInPicker(dialog, {
			org: ADO_ORG,
			pat: "wrong-pat",
		});

		// Inline destructive error surfaces, dialog stays open on the connect step.
		await expect(
			dialog.getByText(/Invalid PAT or insufficient permissions/i),
		).toBeVisible({ timeout: 5_000 });
		await expect(dialog.getByLabel(/Personal access token/i)).toBeVisible();

		// Retry with a good PAT → grouped list renders.
		await dialog.getByLabel(/Personal access token/i).fill("good-pat");
		await dialog.getByRole("button", { name: /^Connect$/ }).click();
		await expect(
			dialog.getByText(ADO_PROJECT, { exact: false }).first(),
		).toBeVisible({ timeout: 5_000 });

		// No integration should have been created on the failed attempt.
		expect(handles.connectCalls.length).toBe(0);
	});
});
