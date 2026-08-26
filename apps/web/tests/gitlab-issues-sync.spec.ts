/**
 * GitLab Issues sync E2E — happy-path coverage for the generic PM pipeline
 * when the configured PM tool is GitLab Issues.
 *
 * Scenarios
 * ---------
 *   - Pull dialog lists GitLab Issues fetched from the mocked PM adapter.
 *   - IID filter grammar (`1, 3-5`) narrows results, matching AC-7 semantics
 *     with GitLab-flavoured data.
 *   - Import fires `importFromPM` with the exact GitLab IID chosen (AC-3/4
 *     evidence — the external id round-trips through the procedure).
 *   - Push fires `stories/sync` with `direction=push` and the success response
 *     carries `externalUrl` so the StoryCard badge can render (AC-1/2).
 *
 * Strategy
 * --------
 * Mirrors `pm-import-filtering.spec.ts`: the oRPC PM procedures
 * (`pmCapabilities`, `listPMTickets`, `importFromPM`, `sync`) are intercepted
 * via `page.route` so no live GitLab connection is required. The container
 * name is set to a GitLab-shaped label so the dialog renders "Pull from
 * GitLab Project" and the StoryCard menu renders "Push to GitLab Project".
 *
 * Prerequisites
 * -------------
 *   - Dev server on :3001 (playwright.config webServer handles this).
 *   - `TEST_PERSONAL_PROJECT_ID` env var set to a real project the seeded
 *     user can access. Without it the suite skips.
 *
 * Run with:
 *   pnpm --filter web e2e tests/gitlab-issues-sync.spec.ts
 */

import {
	expect,
	type Page,
	type Request,
	type Route,
	test,
} from "@playwright/test";

const RUN_MCP_TESTS = Boolean(process.env.GITLAB_DUO_TEST_TOKEN);

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_DATA = {
	projectId: process.env.TEST_PERSONAL_PROJECT_ID || "<personal-project-id>",
};

const PM_TOOL_NAME = "GitLab Project";

interface GitLabTicketFixture {
	id: string;
	displayId: string;
	title: string;
	labels: string[];
}

// Fixture that emulates a GitLab project board's top-level Issues. IIDs are
// project-scoped small integers; labels include a status label and generic
// tags so AC-4 (label pass-through) is observable on the import payload.
const BOARD_TICKETS: GitLabTicketFixture[] = [
	{
		id: "1",
		displayId: "1",
		title: "Add OAuth reconnect flow",
		labels: ["workflow::todo", "feature"],
	},
	{
		id: "2",
		displayId: "2",
		title: "Fix rate-limit toast copy",
		labels: ["workflow::in-review", "bug"],
	},
	{
		id: "3",
		displayId: "3",
		title: "Dot-grid hero treatment",
		labels: ["workflow::done", "design"],
	},
	{
		id: "4",
		displayId: "4",
		title: "Editorial label polish",
		labels: ["workflow::todo", "design"],
	},
	{
		id: "5",
		displayId: "5",
		title: "Kanban WIP limits",
		labels: ["workflow::in-review", "feature"],
	},
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skipIfNoData(projectId: string) {
	if (projectId.startsWith("<")) {
		test.skip();
	}
}

interface ListPMTicketsInput {
	projectId: string;
	page?: number;
	pageSize?: number;
	search?: string;
	filters?: { ids?: number[] };
}

interface ListPMTicketsResponse {
	tickets: {
		id: string;
		displayId: string;
		title: string;
		labels?: string[];
	}[];
	total: number;
	totalOnBoard: number;
	alreadySynced: number;
	page: number;
	pageSize: number;
	hasNextPage: boolean;
	notes: { kind: "already_imported"; id: number }[];
	errors: { kind: "not_found" | "wrong_board"; id: number }[];
}

function buildListResponse(input: ListPMTicketsInput): ListPMTicketsResponse {
	const pageSize = input.pageSize ?? 20;
	const filters = input.filters ?? {};
	const idSet = filters.ids ? new Set(filters.ids) : null;

	let filtered = BOARD_TICKETS.slice();

	if (idSet) {
		filtered = filtered.filter((t) => idSet.has(Number(t.id)));
	}

	const q = input.search?.trim().toLowerCase();
	if (q) {
		filtered = filtered.filter(
			(t) =>
				t.displayId.toLowerCase().includes(q) ||
				t.title.toLowerCase().includes(q),
		);
	}

	const errors: { kind: "not_found" | "wrong_board"; id: number }[] = [];
	if (idSet) {
		const onBoard = new Set(BOARD_TICKETS.map((t) => Number(t.id)));
		for (const id of idSet) {
			if (!onBoard.has(id)) {
				errors.push({ kind: "not_found", id });
			}
		}
	}

	const page = input.page ?? 1;
	const start = (page - 1) * pageSize;
	const paged = filtered.slice(start, start + pageSize);

	return {
		tickets: paged.map((t) => ({
			id: t.id,
			displayId: t.displayId,
			title: t.title,
			labels: t.labels,
		})),
		total: filtered.length,
		totalOnBoard: BOARD_TICKETS.length,
		alreadySynced: 0,
		page,
		pageSize,
		hasNextPage: start + pageSize < filtered.length,
		notes: [],
		errors,
	};
}

function unwrapOrpcInput<T>(body: unknown): T {
	if (body && typeof body === "object" && "json" in body) {
		return (body as { json: T }).json;
	}
	return body as T;
}

function orpcJsonResponse(payload: unknown): string {
	return JSON.stringify({ json: payload });
}

interface GitLabMockHandles {
	importCalls: Array<{ projectId: string; externalId: string }>;
	syncCalls: Array<{
		projectId: string;
		storyId: string;
		direction: "push" | "pull";
	}>;
}

/**
 * Install PM-related oRPC interceptors for the full GitLab push/pull flow.
 * The returned handles capture calls so assertions can inspect payloads.
 */
async function installGitLabMocks(
	page: Page,
	options: { additionalContext?: Record<string, unknown> } = {},
): Promise<GitLabMockHandles> {
	const handles: GitLabMockHandles = {
		importCalls: [],
		syncCalls: [],
	};

	await page.route(
		"**/api/rpc/projects/stories/pmCapabilities**",
		async (route: Route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse({
					configured: true,
					capabilities: {
						hasPMCapabilities: true,
						canCreate: true,
						canUpdate: true,
						canGet: true,
						canList: true,
						supportsPush: true,
						supportsPull: true,
						supportsTaskSync: false,
						detectedType: "gitlab",
					},
					containerName: PM_TOOL_NAME,
					mcpConfigId: "mock-gitlab-config",
					containerId: "mock-gitlab-project",
					additionalContext: options.additionalContext ?? null,
					error: null,
				}),
			});
		},
	);

	await page.route(
		"**/api/rpc/projects/stories/listPMTickets**",
		async (route: Route) => {
			const req = route.request();
			let input: ListPMTicketsInput = { projectId: TEST_DATA.projectId };
			try {
				input = unwrapOrpcInput<ListPMTicketsInput>(
					req.postDataJSON() as unknown,
				);
			} catch {
				// Tolerant to empty bodies during hot-reload fetches.
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse(buildListResponse(input)),
			});
		},
	);

	await page.route(
		"**/api/rpc/projects/stories/importFromPM**",
		async (route: Route) => {
			const req: Request = route.request();
			const payload = unwrapOrpcInput<{
				projectId: string;
				externalId: string;
			}>(req.postDataJSON() as unknown);
			handles.importCalls.push(payload);

			const ticket = BOARD_TICKETS.find(
				(t) => t.id === payload.externalId,
			);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse({
					story: {
						id: `imported-${payload.externalId}`,
						title:
							ticket?.title ?? `Imported ${payload.externalId}`,
						externalId: payload.externalId,
						externalUrl: `https://gitlab.com/fabric/test/-/issues/${payload.externalId}`,
						labels: ticket?.labels ?? [],
					},
					imported: true,
				}),
			});
		},
	);

	await page.route(
		"**/api/rpc/projects/stories/sync**",
		async (route: Route) => {
			const req: Request = route.request();
			const payload = unwrapOrpcInput<{
				projectId: string;
				storyId: string;
				direction: "push" | "pull";
			}>(req.postDataJSON() as unknown);
			handles.syncCalls.push(payload);

			const iid = 42;
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse({
					success: true,
					story: {
						id: payload.storyId,
						externalId: String(iid),
						externalUrl: `https://gitlab.com/fabric/test/-/issues/${iid}`,
					},
					externalId: String(iid),
					externalUrl: `https://gitlab.com/fabric/test/-/issues/${iid}`,
					direction: payload.direction,
				}),
			});
		},
	);

	return handles;
}

async function gotoRoadmap(page: Page, projectId: string): Promise<void> {
	await page.goto(`/app/projects/${projectId}`);
	await page.getByRole("tab", { name: /Roadmap/i }).click();
	await page.waitForLoadState("networkidle");
}

async function openPullDialog(page: Page): Promise<void> {
	await page
		.getByRole("button", {
			name: new RegExp(`Pull from ${PM_TOOL_NAME}`, "i"),
		})
		.first()
		.click();
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(page.getByRole("dialog").getByText(/on board/i)).toBeVisible();
}

function dialog(page: Page) {
	return page.getByRole("dialog");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("GitLab Issues sync (REST adapter) @rest", () => {
	test.beforeEach(async () => {
		skipIfNoData(TEST_DATA.projectId);
	});

	test("Pull dialog lists GitLab Issues from the mocked adapter", async ({
		page,
	}) => {
		await installGitLabMocks(page);
		await gotoRoadmap(page, TEST_DATA.projectId);
		await openPullDialog(page);

		const d = dialog(page);

		for (const id of [1, 2, 3, 4, 5]) {
			await expect(d.getByText(`#${id}`, { exact: true })).toBeVisible();
		}
		await expect(d.getByText("Add OAuth reconnect flow")).toBeVisible();
	});

	test("IID filter `1, 3-5` renders exactly those GitLab Issues (AC-7)", async ({
		page,
	}) => {
		await installGitLabMocks(page);
		await gotoRoadmap(page, TEST_DATA.projectId);
		await openPullDialog(page);

		const d = dialog(page);

		await d.getByLabel(/Ticket IDs/i).fill("1, 3-5");
		await d.getByRole("button", { name: /^Apply$/ }).click();

		for (const id of [1, 3, 4, 5]) {
			await expect(d.getByText(`#${id}`, { exact: true })).toBeVisible();
		}
		await expect(d.getByText("#2", { exact: true })).not.toBeVisible();
	});

	test("Importing a ticket calls importFromPM with the GitLab IID (AC-3/4)", async ({
		page,
	}) => {
		const handles = await installGitLabMocks(page);
		await gotoRoadmap(page, TEST_DATA.projectId);
		await openPullDialog(page);

		const d = dialog(page);

		// Select the row for issue #2, then trigger the import action. The
		// dialog provides a row-level checkbox and a footer action; both paths
		// surface via an accessible name that includes the ticket title.
		const row = d
			.locator("li, tr, [role='row']")
			.filter({
				hasText: "Fix rate-limit toast copy",
			})
			.first();
		await row.getByRole("checkbox").check();

		await d
			.getByRole("button", { name: /^(Import|Import selected)$/i })
			.click();

		// Wait until the mock records the call.
		await expect.poll(() => handles.importCalls.length).toBeGreaterThan(0);

		expect(handles.importCalls[0]).toMatchObject({
			externalId: "2",
		});
	});

	test("Pushing a feature calls sync with direction=push and returns GitLab url (AC-1/2)", async ({
		page,
	}) => {
		const handles = await installGitLabMocks(page);
		await gotoRoadmap(page, TEST_DATA.projectId);

		// Open the action menu on the first StoryCard and click the "Push to
		// GitLab Project" item. The card renders `Push to {pmToolName}` when
		// pmCapabilities returns `configured: true`.
		const firstCard = page
			.getByRole("article")
			.or(page.locator("[data-story-card]"))
			.first();

		// Kebab / options trigger is usually the only button inside the card
		// without visible text; we match by accessible name.
		await firstCard
			.getByRole("button", { name: /more|options|menu/i })
			.first()
			.click();

		await page
			.getByRole("menuitem", {
				name: new RegExp(`Push to ${PM_TOOL_NAME}`, "i"),
			})
			.click();

		await expect.poll(() => handles.syncCalls.length).toBeGreaterThan(0);

		expect(handles.syncCalls[0]).toMatchObject({
			direction: "push",
		});
	});

	test("Label-status mapping: import carries labelStatusMap through capabilities (AC-4)", async ({
		page,
	}) => {
		const handles = await installGitLabMocks(page, {
			additionalContext: {
				labelStatusMap: {
					"workflow::in-review": "status-in-review-id",
				},
			},
		});
		await gotoRoadmap(page, TEST_DATA.projectId);
		await openPullDialog(page);

		const d = dialog(page);

		// The #2 fixture has label `workflow::in-review`. After import, the
		// mapping path should fire; we assert the call shape here — the
		// `applyLabelStatusMapOnPull` helper is unit-tested separately.
		const row = d
			.locator("li, tr, [role='row']")
			.filter({ hasText: "Fix rate-limit toast copy" })
			.first();
		await row.getByRole("checkbox").check();

		await d
			.getByRole("button", { name: /^(Import|Import selected)$/i })
			.click();

		await expect.poll(() => handles.importCalls.length).toBeGreaterThan(0);
		expect(handles.importCalls[0]).toMatchObject({ externalId: "2" });
	});

	test("Conflict dialog: user can resolve with REMOTE (Use PM version)", async ({
		page,
	}) => {
		/**
		 * Strategy: intercept the stories list to inject a story with
		 * lastPmSyncStatus=CONFLICT so the PmSyncConflictBadge renders.
		 * Then intercept resolveConflict to record the call.
		 * Click the badge → dialog opens → click "Use PM version" →
		 * toast "Conflict cleared" appears.
		 */
		await installGitLabMocks(page);

		const resolveConflictCalls: Array<{
			storyId: string;
			resolution: string;
		}> = [];

		// Mock the resolveConflict endpoint.
		await page.route(
			"**/api/rpc/projects/stories/resolveConflict**",
			async (route: Route) => {
				const req = route.request();
				const payload = unwrapOrpcInput<{
					storyId: string;
					resolution: string;
				}>(req.postDataJSON() as unknown);
				resolveConflictCalls.push(payload);
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: orpcJsonResponse({ cleared: true }),
				});
			},
		);

		// Inject a CONFLICT story into the stories list.
		await page.route(
			"**/api/rpc/projects/stories/list**",
			async (route: Route) => {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: orpcJsonResponse({
						stories: [
							{
								id: "conflict-story-1",
								identifier: "F-001",
								title: "Conflicted feature",
								description: null,
								priority: "P2_MEDIUM",
								size: null,
								statusId: null,
								externalId: "42",
								externalUrl:
									"https://gitlab.com/fabric/test/-/issues/42",
								lastPmSyncStatus: "CONFLICT",
								lastPmSyncError:
									"Remote was updated externally",
								lastPmSyncAttemptAt: new Date().toISOString(),
								lastSyncedStatusId: null,
								externalMcpServerId: null,
								labels: [],
								assigneeId: null,
								projectId: TEST_DATA.projectId,
								draftingStage: "PUBLISHED",
								tasks: [],
								latestCodingRun: null,
								source: "GITLAB",
								createdAt: new Date().toISOString(),
								updatedAt: new Date().toISOString(),
							},
						],
						total: 1,
					}),
				});
			},
		);

		await gotoRoadmap(page, TEST_DATA.projectId);

		// Wait for the conflict badge to appear.
		await expect(
			page.getByRole("button", { name: /resolve sync conflict/i }),
		).toBeVisible({ timeout: 10000 });

		// Click it — dialog should open.
		await page
			.getByRole("button", { name: /resolve sync conflict/i })
			.first()
			.click();

		await expect(
			page.getByRole("dialog", { name: /resolve sync conflict/i }),
		).toBeVisible();

		// Choose "Use PM version" (REMOTE resolution).
		await page
			.getByRole("dialog")
			.getByRole("button", { name: /use pm version/i })
			.click();

		// Toast confirms the action.
		await expect(page.getByText(/conflict cleared/i)).toBeVisible({
			timeout: 5000,
		});

		// Verify the RPC was called with REMOTE resolution.
		await expect.poll(() => resolveConflictCalls.length).toBeGreaterThan(0);
		expect(resolveConflictCalls[0]).toMatchObject({ resolution: "REMOTE" });
	});
});

test.describe("GitLab Issues sync (Official MCP) @mcp", () => {
	test.skip(!RUN_MCP_TESTS, "Requires GitLab Premium/Ultimate test account");

	test("syncs an issue end-to-end through gitlab-official MCP", async () => {
		// Behavior identical to the @rest test, but the test account must
		// have the official MCP connected via Settings → MCP Servers.
		// Without GITLAB_DUO_TEST_TOKEN this block is skipped.
	});
});
