/**
 * Re-Sync Features E2E Tests (Task 7.1 + 7.2)
 *
 * Covers:
 *   7.1 — Single re-push / re-pull confirmation dialogs on StoryCard kebab menu
 *   7.2 — Bulk push new/update breakdown dialog + pull dialog toggle behavior
 *
 * Strategy
 * --------
 * All PM and stories oRPC endpoints are intercepted via `page.route` so the
 * tests are fully deterministic — no ADO/PM connection or specific project
 * state required. The interceptors drive the data the components render.
 *
 * Prerequisites
 * -------------
 * - Dev server on :3001 (playwright.config webServer handles this).
 * - `TEST_PERSONAL_PROJECT_ID` env var set to a real project the seeded user
 *   can access. Without it the suite skips.
 *
 * Run with:
 *   pnpm --filter web e2e tests/re-sync-features.spec.ts
 */

import { expect, type Page, type Route, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_DATA = {
	projectId: process.env.TEST_PERSONAL_PROJECT_ID || "<personal-project-id>",
};

const PM_TOOL_NAME = "FabricOnE2E";

// ---------------------------------------------------------------------------
// Story fixtures
// ---------------------------------------------------------------------------

interface StoryFixture {
	id: string;
	identifier: string;
	title: string;
	externalId: string | null;
	externalUrl: string | null;
}

const SYNCED_STORY: StoryFixture = {
	id: "story-synced-001",
	identifier: "F-101",
	title: "Already synced feature",
	externalId: "ext-123",
	externalUrl: "https://example.com/ticket/123",
};

const UNSYNCED_STORY: StoryFixture = {
	id: "story-unsynced-002",
	identifier: "F-102",
	title: "Brand new feature",
	externalId: null,
	externalUrl: null,
};

function buildStoryObject(fixture: StoryFixture) {
	return {
		id: fixture.id,
		identifier: fixture.identifier,
		title: fixture.title,
		description: null,
		acceptanceCriteria: null,
		statusId: "status-default",
		priority: "P2_MEDIUM",
		size: null,
		storyPoints: null,
		order: 0,
		roadmapOrder: 0,
		labels: [],
		tasks: [],
		assigneeId: null,
		createdById: "user-1",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		externalId: fixture.externalId,
		externalUrl: fixture.externalUrl,
		source: "manual",
		version: 1,
		draftingStage: "PUBLISHED",
		draftingStageUpdatedAt: null,
		externalSyncStatus: null,
		latestCodingRun: null,
		latestKanbanQueue: null,
	};
}

// ---------------------------------------------------------------------------
// oRPC helpers
// ---------------------------------------------------------------------------

function orpcJsonResponse(payload: unknown): string {
	return JSON.stringify({ json: payload });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skipIfNoData(projectId: string) {
	if (projectId.startsWith("<")) {
		test.skip();
	}
}

async function installStoriesMock(
	page: Page,
	stories: StoryFixture[] = [SYNCED_STORY, UNSYNCED_STORY],
): Promise<void> {
	await page.route(
		"**/api/rpc/projects/stories/list**",
		async (route: Route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse(stories.map((s) => buildStoryObject(s))),
			});
		},
	);

	// Mock statuses list (required for the roadmap to render)
	await page.route(
		"**/api/rpc/projects/stories/statuses/list**",
		async (route: Route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse({
					statuses: [
						{
							id: "status-default",
							name: "To Do",
							color: "#6B7280",
							order: 0,
							isDefault: true,
							isFinal: false,
						},
					],
				}),
			});
		},
	);
}

async function installPMCapabilitiesMock(page: Page): Promise<void> {
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
						supportsTaskSync: true,
					},
					containerName: PM_TOOL_NAME,
					mcpConfigId: "mock-mcp-config",
					containerId: "mock-container",
					additionalContext: null,
					error: null,
				}),
			});
		},
	);
}

/** Ticket fixtures for the PullFromPMDialog */
interface TicketFixture {
	id: string;
	displayId: string;
	title: string;
	alreadySynced: boolean;
}

const BOARD_TICKETS: TicketFixture[] = [
	{
		id: "417",
		displayId: "417",
		title: "New ticket A",
		alreadySynced: false,
	},
	{
		id: "418",
		displayId: "418",
		title: "Already imported ticket",
		alreadySynced: true,
	},
	{
		id: "419",
		displayId: "419",
		title: "New ticket B",
		alreadySynced: false,
	},
];

interface ListPMTicketsInput {
	projectId: string;
	page?: number;
	pageSize?: number;
	search?: string;
	filters?: { ids?: number[] };
	includeAlreadySynced?: boolean;
}

function unwrapOrpcInput<T>(body: unknown): T {
	if (body && typeof body === "object" && "json" in body) {
		return (body as { json: T }).json;
	}
	return body as T;
}

function buildListResponse(input: ListPMTicketsInput) {
	const pageSize = input.pageSize ?? 20;
	const includeAlreadySynced = input.includeAlreadySynced ?? false;
	const filters = input.filters ?? {};
	const idSet = filters.ids ? new Set(filters.ids) : null;

	let filtered = BOARD_TICKETS.slice();

	// Filter by IDs if specified
	if (idSet) {
		filtered = filtered.filter((t) => idSet.has(Number(t.id)));
	}

	// Search by title/displayId
	const q = input.search?.trim().toLowerCase();
	if (q) {
		filtered = filtered.filter(
			(t) =>
				t.displayId.toLowerCase().includes(q) ||
				t.title.toLowerCase().includes(q),
		);
	}

	// Hide already-synced unless toggle is on
	const notes: { kind: "already_imported"; id: number }[] = [];
	if (!includeAlreadySynced) {
		filtered = filtered.filter((t) => {
			if (t.alreadySynced) {
				notes.push({ kind: "already_imported", id: Number(t.id) });
				return false;
			}
			return true;
		});
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

	const alreadySyncedCount = BOARD_TICKETS.filter(
		(t) => t.alreadySynced,
	).length;

	return {
		tickets: paged.map((t) => ({
			id: t.id,
			displayId: t.displayId,
			title: t.title,
			alreadySynced: t.alreadySynced,
		})),
		total: filtered.length,
		totalOnBoard: BOARD_TICKETS.length,
		alreadySynced: alreadySyncedCount,
		page,
		pageSize,
		hasNextPage: start + pageSize < filtered.length,
		notes,
		errors,
	};
}

async function installPMListMock(page: Page): Promise<void> {
	await page.route(
		"**/api/rpc/projects/stories/listPMTickets**",
		async (route: Route) => {
			const req = route.request();
			let input: ListPMTicketsInput = {
				projectId: TEST_DATA.projectId,
			};
			try {
				const parsed = req.postDataJSON() as unknown;
				input = unwrapOrpcInput<ListPMTicketsInput>(parsed);
			} catch {
				// fallback
			}
			const payload = buildListResponse(input);
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse(payload),
			});
		},
	);
}

async function gotoRoadmap(page: Page, projectId: string): Promise<void> {
	await page.goto(`/app/projects/${projectId}`);
	await page.getByRole("tab", { name: /Roadmap/i }).click();
	await page.waitForLoadState("networkidle");
}

/** Hover a story card and open its kebab menu */
async function openKebabMenu(page: Page, storyTitle: string): Promise<void> {
	// The card row has a title button; hover the parent card to reveal the kebab
	const titleBtn = page
		.getByRole("button", {
			name: new RegExp(`Open details for ${storyTitle}`, "i"),
		})
		.first();
	await expect(titleBtn).toBeVisible();

	// Hover the title button area to reveal the kebab (opacity-0 -> opacity-60)
	await titleBtn.hover();

	// The kebab trigger has aria-label="Story actions"
	const kebabBtn = page
		.getByRole("button", { name: /Story actions/i })
		.first();
	await expect(kebabBtn).toBeVisible({ timeout: 3000 });
	await kebabBtn.click();

	// Wait for the dropdown menu
	await expect(page.getByRole("menu")).toBeVisible();
}

// ---------------------------------------------------------------------------
// Task 7.1 — Single re-push / re-pull confirmation dialogs
// ---------------------------------------------------------------------------

test.describe("7.1: Single re-push and re-pull confirmation dialogs", () => {
	test.beforeEach(async () => {
		skipIfNoData(TEST_DATA.projectId);
	});

	test("push on synced feature shows confirmation dialog; confirming succeeds", async ({
		page,
	}) => {
		await installStoriesMock(page);
		await installPMCapabilitiesMock(page);

		// Track whether sync mutation fires
		let syncFired = false;
		await page.route(
			"**/api/rpc/projects/stories/sync**",
			async (route) => {
				syncFired = true;
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: orpcJsonResponse({ success: true }),
				});
			},
		);

		await gotoRoadmap(page, TEST_DATA.projectId);

		// Open kebab for the synced story
		await openKebabMenu(page, SYNCED_STORY.title);

		// Click "Push to PM"
		await page
			.getByRole("menuitem", {
				name: new RegExp(`Push to ${PM_TOOL_NAME}`, "i"),
			})
			.click();

		// AlertDialog should appear (Radix AlertDialog renders role="alertdialog")
		const alertDialog = page.getByRole("alertdialog");
		await expect(alertDialog).toBeVisible();
		await expect(alertDialog).toContainText(/Re-push/i);
		await expect(alertDialog).toContainText(/already synced/i);

		// Confirm
		await alertDialog.getByRole("button", { name: /Re-push/i }).click();

		// Dialog closes and mutation fires
		await expect(alertDialog).not.toBeVisible();
		expect(syncFired).toBe(true);
	});

	test("push on unsynced feature does not show a confirmation dialog", async ({
		page,
	}) => {
		await installStoriesMock(page);
		await installPMCapabilitiesMock(page);

		let syncFired = false;
		await page.route(
			"**/api/rpc/projects/stories/sync**",
			async (route) => {
				syncFired = true;
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: orpcJsonResponse({ success: true }),
				});
			},
		);

		await gotoRoadmap(page, TEST_DATA.projectId);

		await openKebabMenu(page, UNSYNCED_STORY.title);

		// Click "Push to PM"
		await page
			.getByRole("menuitem", {
				name: new RegExp(`Push to ${PM_TOOL_NAME}`, "i"),
			})
			.click();

		// No AlertDialog should appear — mutation fires directly
		await expect(page.getByRole("alertdialog")).not.toBeVisible();
		expect(syncFired).toBe(true);
	});

	test("pull on synced feature shows confirmation dialog; confirming succeeds", async ({
		page,
	}) => {
		await installStoriesMock(page);
		await installPMCapabilitiesMock(page);

		let syncFired = false;
		await page.route(
			"**/api/rpc/projects/stories/sync**",
			async (route) => {
				syncFired = true;
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: orpcJsonResponse({ success: true }),
				});
			},
		);

		await gotoRoadmap(page, TEST_DATA.projectId);

		await openKebabMenu(page, SYNCED_STORY.title);

		// "Pull from PM" only shows for synced stories
		await page
			.getByRole("menuitem", {
				name: new RegExp(`Pull from ${PM_TOOL_NAME}`, "i"),
			})
			.click();

		const alertDialog = page.getByRole("alertdialog");
		await expect(alertDialog).toBeVisible();
		await expect(alertDialog).toContainText(/Pull latest/i);
		await expect(alertDialog).toContainText(/overwrite/i);

		// Confirm
		await alertDialog.getByRole("button", { name: /^Pull$/i }).click();

		await expect(alertDialog).not.toBeVisible();
		expect(syncFired).toBe(true);
	});

	test("cancelling either confirmation dialog fires no mutation", async ({
		page,
	}) => {
		await installStoriesMock(page);
		await installPMCapabilitiesMock(page);

		let syncFired = false;
		await page.route(
			"**/api/rpc/projects/stories/sync**",
			async (route) => {
				syncFired = true;
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: orpcJsonResponse({ success: true }),
				});
			},
		);

		await gotoRoadmap(page, TEST_DATA.projectId);

		// Test push cancel
		await openKebabMenu(page, SYNCED_STORY.title);
		await page
			.getByRole("menuitem", {
				name: new RegExp(`Push to ${PM_TOOL_NAME}`, "i"),
			})
			.click();

		const alertDialog = page.getByRole("alertdialog");
		await expect(alertDialog).toBeVisible();
		await alertDialog.getByRole("button", { name: /Cancel/i }).click();
		await expect(alertDialog).not.toBeVisible();
		expect(syncFired).toBe(false);

		// Test pull cancel
		await openKebabMenu(page, SYNCED_STORY.title);
		await page
			.getByRole("menuitem", {
				name: new RegExp(`Pull from ${PM_TOOL_NAME}`, "i"),
			})
			.click();

		await expect(alertDialog).toBeVisible();
		await alertDialog.getByRole("button", { name: /Cancel/i }).click();
		await expect(alertDialog).not.toBeVisible();
		expect(syncFired).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Task 7.2 — Bulk push breakdown dialog + pull dialog toggle
// ---------------------------------------------------------------------------

test.describe("7.2: Bulk push breakdown and pull dialog toggle", () => {
	test.beforeEach(async () => {
		skipIfNoData(TEST_DATA.projectId);
	});

	test("bulk push with mixed selection shows new/update breakdown in dialog", async ({
		page,
	}) => {
		await installStoriesMock(page);
		await installPMCapabilitiesMock(page);

		// Mock syncBulk
		await page.route(
			"**/api/rpc/projects/stories/syncBulk**",
			async (route) => {
				await route.fulfill({
					status: 200,
					contentType: "application/json",
					body: orpcJsonResponse({ workflowId: "wf-mock-123" }),
				});
			},
		);

		await gotoRoadmap(page, TEST_DATA.projectId);

		// Select both stories via their checkboxes
		const syncedCheckbox = page.getByRole("checkbox", {
			name: `Select ${SYNCED_STORY.identifier}`,
		});
		const unsyncedCheckbox = page.getByRole("checkbox", {
			name: `Select ${UNSYNCED_STORY.identifier}`,
		});

		await syncedCheckbox.click({ force: true });
		await unsyncedCheckbox.click({ force: true });

		// The bulk action bar should appear with a "Push to PM" button
		const pushBtn = page.getByRole("button", {
			name: new RegExp(`Push.*${PM_TOOL_NAME}|Sync.*selected`, "i"),
		});
		await expect(pushBtn).toBeVisible({ timeout: 5000 });
		await pushBtn.click();

		// The SyncSelectedDialog (role="dialog") should show
		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();

		// Should show breakdown: "1 new" and "1 existing" (or "update 1")
		await expect(dialog).toContainText(/1 new/i);
		await expect(dialog).toContainText(/update 1/i);

		// The amber overwrite warning should be visible (since we have updates)
		await expect(dialog.locator("text=overwrite").first()).toBeVisible();

		// Cancel to clean up
		await dialog.getByRole("button", { name: /Cancel/i }).click();
		await expect(dialog).not.toBeVisible();
	});

	test("pull dialog toggle shows/hides already-imported tickets", async ({
		page,
	}) => {
		await installStoriesMock(page);
		await installPMCapabilitiesMock(page);
		await installPMListMock(page);

		await gotoRoadmap(page, TEST_DATA.projectId);

		// Open the Pull from PM dialog
		const pullBtn = page
			.getByRole("button", {
				name: new RegExp(`Pull from ${PM_TOOL_NAME}`, "i"),
			})
			.first();
		await expect(pullBtn).toBeVisible({ timeout: 5000 });
		await pullBtn.click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		// Wait for board stats to load
		await expect(dialog.getByText(/on board/i)).toBeVisible();

		// Enter ticket IDs to trigger the query (dialog requires search or IDs)
		await dialog.getByLabel(/Ticket IDs/i).fill("417, 418, 419");
		await dialog.getByRole("button", { name: /^Apply$/ }).click();

		// With toggle OFF (default): already-imported ticket 418 should be hidden
		await expect(dialog.getByText("New ticket A")).toBeVisible();
		await expect(dialog.getByText("New ticket B")).toBeVisible();
		await expect(
			dialog.getByText("Already imported ticket"),
		).not.toBeVisible();

		// The toggle should be visible since alreadySynced > 0
		const toggle = dialog.getByRole("checkbox", {
			name: /Include already-imported/i,
		});
		await expect(toggle).toBeVisible();

		// Enable the toggle
		await toggle.click();

		// Now the already-imported ticket should appear
		await expect(dialog.getByText("Already imported ticket")).toBeVisible({
			timeout: 5000,
		});
	});

	test("selecting already-imported tickets shows amber warning", async ({
		page,
	}) => {
		await installStoriesMock(page);
		await installPMCapabilitiesMock(page);
		await installPMListMock(page);

		await gotoRoadmap(page, TEST_DATA.projectId);

		// Open the Pull from PM dialog
		const pullBtn = page
			.getByRole("button", {
				name: new RegExp(`Pull from ${PM_TOOL_NAME}`, "i"),
			})
			.first();
		await pullBtn.click();

		const dialog = page.getByRole("dialog");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByText(/on board/i)).toBeVisible();

		// Enter IDs and apply
		await dialog.getByLabel(/Ticket IDs/i).fill("417, 418, 419");
		await dialog.getByRole("button", { name: /^Apply$/ }).click();

		// Enable include-already-synced toggle
		const toggle = dialog.getByRole("checkbox", {
			name: /Include already-imported/i,
		});
		await toggle.click();

		// Wait for the already-imported ticket to appear
		await expect(dialog.getByText("Already imported ticket")).toBeVisible({
			timeout: 5000,
		});

		// Select the already-synced ticket (418)
		const ticketCheckbox = dialog.getByRole("checkbox", {
			name: /Select ticket 418/i,
		});
		await ticketCheckbox.click();

		// The amber overwrite warning should appear
		await expect(
			dialog
				.locator("[class*='highlight']")
				.filter({ hasText: /overwrite/i }),
		).toBeVisible();
	});
});
