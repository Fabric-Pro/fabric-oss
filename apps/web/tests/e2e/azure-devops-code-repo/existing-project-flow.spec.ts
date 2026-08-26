/**
 * E2E: Azure DevOps code-repository — EXISTING-project flow journey (mocked)
 *
 * Spec:  fabric/specs/2026-05-27-azure-devops-code-repository/spec.md §9.3, §8.1 (V3),
 *        §3.9 (swap MCP picker → shared PAT picker; fix the credential-drop bug).
 * Tasks: fabric/specs/2026-05-27-azure-devops-code-repository/tasks.md Task 6.1.
 *
 * Journey under test (all ADO network calls MOCKED — no real ADO org/PAT;
 * live clone+index is TG6.2, deferred to staging):
 *
 *   1. Open the existing-project flow at `/app/projects/new/existing`.
 *   2. Step 1 (Codebase) → enter a project name → a DRAFT projectId is minted
 *      via `projects.saveDraft` (MOCKED) so the picker can `connect` at confirm.
 *   3. Click the "Azure DevOps" trigger in the Repository URLs controls → opens
 *      the shared `AzureDevOpsPatRepoPicker` (NOT the retired MCP picker).
 *   4. Connect step (org + PAT) → `projects.azureDevOps.listRepos` (MOCKED) →
 *      grouped multi-select → "Add N Repos" → `repositoryIntegrations.connect`
 *      (MOCKED → success) runs per repo BEFORE existing-setup ever runs (this
 *      is the fix for the silent ADO credential-drop, spec §3.9).
 *   5. Assert: the picked ADO repo URL is appended to the Repository URLs list
 *      (so the existing-setup workflow sees it in `repoUrls`), and one
 *      `connect` fired per selected repo against the DRAFT projectId.
 *
 * Strategy: mirrors `tests/gitlab-issues-sync.spec.ts` — oRPC procedures are
 * intercepted via `page.route` using the canonical RPC envelope. The
 * picker/flow selectors mirror the components landed by TG2/TG4
 * (`AzureDevOpsPatRepoPicker.tsx`, `ExistingProjectFlow.tsx`).
 *
 * Status: SKIPPED by default (set `RUN_ADO_E2E=1` to opt in). Same deferral
 * convention as the sibling `tests/e2e/unified-context-wizard/*` and
 * `tests/e2e/projects/*` specs: even with every ADO call mocked, the suite
 * still needs a built+running web app on :3001 (the playwright.config
 * `webServer`) and the `auth.setup.ts` storageState (signed-in seeded user) so
 * the route is reachable post-login.
 *
 * Run (with the local stack + a seeded auth user available):
 *   RUN_ADO_E2E=1 pnpm --filter web e2e tests/e2e/azure-devops-code-repo/existing-project-flow.spec.ts
 */

import { expect, type Page, type Route, test } from "@playwright/test";
import { orpcJsonResponse, unwrapOrpcInput } from "./_orpc-mock";

// ---------------------------------------------------------------------------
// Opt-in guard (see file header)
// ---------------------------------------------------------------------------

const RUN_ADO_E2E = process.env.RUN_ADO_E2E === "1";

// ---------------------------------------------------------------------------
// Fixtures — grouped ADO discovery result (parity with §3.2.1).
// ---------------------------------------------------------------------------

const ADO_ORG = "fabrikam";
const ADO_PROJECT = "Core";

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
	buildRepo("payments-gateway"),
	buildRepo("ledger-core"),
];

function buildListReposResponse() {
	return {
		configured: true,
		organization: ADO_ORG,
		groups: [{ owner: ADO_PROJECT, repos: REPOS }],
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

interface AdoExistingMockHandles {
	draftProjectId: string;
	saveDraftCalls: Array<{ name: string; hasPat: boolean }>;
	listReposCalls: Array<{ azureOrganization: string; pat: string }>;
	connectCalls: ConnectCall[];
}

/**
 * Install the ADO oRPC interceptors for the existing-project flow. The picker
 * here ALWAYS has a DRAFT projectId (minted from the project name), so `connect`
 * runs at confirm time inside the picker — this is exactly the path that fixes
 * the credential-drop bug.
 */
async function installAdoExistingMocks(
	page: Page,
): Promise<AdoExistingMockHandles> {
	const draftProjectId = `draft_${Date.now()}`;
	const handles: AdoExistingMockHandles = {
		draftProjectId,
		saveDraftCalls: [],
		listReposCalls: [],
		connectCalls: [],
	};

	await page.route(
		"**/api/rpc/projects/saveDraft**",
		async (route: Route) => {
			const input = unwrapOrpcInput<Record<string, unknown>>(
				route.request().postDataJSON() as unknown,
			);
			handles.saveDraftCalls.push({
				name: String(input.name ?? ""),
				// Guard: the PAT must NEVER be in the draft payload.
				hasPat: "pat" in input || "encryptedPat" in input,
			});
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse({
					project: { id: draftProjectId, status: "DRAFT" },
				}),
			});
		},
	);

	await page.route(
		"**/api/rpc/projects/azureDevOps/listRepos**",
		async (route: Route) => {
			const input = unwrapOrpcInput<{
				azureOrganization: string;
				pat: string;
			}>(route.request().postDataJSON() as unknown);
			handles.listReposCalls.push({
				azureOrganization: input.azureOrganization,
				pat: input.pat,
			});
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse(buildListReposResponse()),
			});
		},
	);

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

	return handles;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Azure DevOps code-repo — existing-project flow (mocked)", () => {
	test.skip(
		!RUN_ADO_E2E,
		"Set RUN_ADO_E2E=1 with a running web app + seeded auth user. Mocks remove the ADO/Temporal/DB deps but not the login + reachable-route requirement (see file header).",
	);

	test("Azure DevOps 'Add' opens the shared PAT picker → connect creates an integration before existing-setup", async ({
		page,
	}) => {
		const handles = await installAdoExistingMocks(page);

		// (1) Open the existing-project flow.
		await page.goto("/app/projects/new/existing");

		// (2) Step 1 (Codebase) — enter a project name → mints the DRAFT host.
		const projectName = `E2E ADO Existing ${Date.now()}`;
		await page.getByLabel(/project name/i).fill(projectName);
		await page.getByLabel(/project name/i).blur();

		// DRAFT minted via saveDraft (so the picker has a projectId for connect).
		await expect
			.poll(() => handles.saveDraftCalls.length)
			.toBeGreaterThan(0);
		// The PAT was NEVER sent to the draft.
		expect(handles.saveDraftCalls.every((c) => c.hasPat === false)).toBe(
			true,
		);

		// (3) Click the "Azure DevOps" trigger in the Repository URLs controls.
		// (ExistingProjectFlow renders an outlined <Button>Azure DevOps</Button>
		// alongside GitHub/GitLab/Add-Repository. There is also an inline text
		// link with the same name; the first match is the controls button.)
		await page
			.getByRole("button", { name: /^Azure DevOps$/ })
			.first()
			.click();

		// (3b) The SHARED PAT picker opens (its title is unique to the new
		// component — the retired MCP picker never had this title).
		const dialog = page.getByRole("dialog");
		await expect(
			dialog.getByText(/Select Azure DevOps Repositories/i),
		).toBeVisible({ timeout: 5_000 });
		// The PAT connect step is present (the MCP picker had no PAT field).
		const patInput = dialog.getByLabel(/Personal access token/i);
		await expect(patInput).toBeVisible();
		await expect(patInput).toHaveAttribute("type", "password");

		// (4) Connect → mocked listRepos → grouped multi-select.
		await dialog
			.getByLabel(/Organization or repository URL/i)
			.fill(
				`https://dev.azure.com/${ADO_ORG}/${ADO_PROJECT}/_git/payments-gateway`,
			);
		await patInput.fill("existing-flow-pat");
		await dialog.getByRole("button", { name: /^Connect$/ }).click();

		await expect
			.poll(() => handles.listReposCalls.length)
			.toBeGreaterThan(0);
		// The org parsed from the full repo URL is just the org segment.
		expect(handles.listReposCalls[0]).toMatchObject({
			azureOrganization: ADO_ORG,
			pat: "existing-flow-pat",
		});

		// Select one repo.
		await expect(
			dialog.getByText(ADO_PROJECT, { exact: false }).first(),
		).toBeVisible({ timeout: 5_000 });
		const repoCheckbox = dialog.getByRole("checkbox", {
			name: /Select payments-gateway/i,
		});
		if ((await repoCheckbox.count()) === 0) {
			await dialog
				.getByRole("button", { name: new RegExp(ADO_PROJECT, "i") })
				.first()
				.click();
		}
		await repoCheckbox.check();

		await dialog.getByRole("button", { name: /^Add 1 Repo$/i }).click();

		// (4b) The picker created the integration via `connect` BEFORE any
		// existing-setup run — against the DRAFT projectId, with PAT + provider.
		await expect.poll(() => handles.connectCalls.length).toBe(1);
		expect(handles.connectCalls[0]).toMatchObject({
			projectId: handles.draftProjectId,
			provider: "AZURE_DEVOPS",
			authMethod: "PAT",
		});
		expect(handles.connectCalls[0].pat).toBe("existing-flow-pat");
		expect(handles.connectCalls[0].repositoryUrl).toContain(
			"dev.azure.com",
		);

		// Dialog closes.
		await expect(dialog).toBeHidden({ timeout: 5_000 });

		// (5) The selected ADO repo URL was appended to the Repository URLs list
		// (so the existing-setup workflow sees it in `repoUrls` — no silent drop).
		// React controls the input `value` PROPERTY (not the DOM attribute), so we
		// read the live property values via `evaluateAll` rather than an
		// `[value=...]` attribute selector.
		const expectedUrl = adoRepoUrl(
			ADO_ORG,
			ADO_PROJECT,
			"payments-gateway",
		);
		await expect
			.poll(
				async () =>
					page
						.locator('input[type="url"]')
						.evaluateAll((nodes) =>
							nodes.map((n) => (n as HTMLInputElement).value),
						),
				{ timeout: 5_000 },
			)
			.toContain(expectedUrl);
	});
});
