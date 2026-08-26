/**
 * PM Import Filtering E2E Tests (F-1035, §9.3)
 *
 * Verifies the `PullFromPMDialog` filter surface for the ADO-backed "Pull from
 * {PM Tool}" flow:
 *   - AC-1         Enter `417, 419-425` → exactly those rows render.
 *   - AC-9         Enter an already-imported ID → row absent from list, note
 *                  `#<id> is already imported` present in the notes region.
 *   - AC-7 / AC-13 Enter `abc` → Apply disabled, inline error visible.
 *   - Clear filters resets the ID field and drops the applied filter.
 *
 * Strategy
 * --------
 * These scenarios are exercised against a real authenticated roadmap page, but
 * the oRPC PM procedures (`pmCapabilities`, `listPMTickets`) are intercepted
 * via `page.route` so the test is fully deterministic and does not require an
 * ADO connection or project with PM integration configured. The interceptors
 * drive the filter state the dialog renders.
 *
 * Prerequisites
 * -------------
 * - Dev server on :3001 (playwright.config webServer handles this).
 * - `TEST_PERSONAL_PROJECT_ID` env var set to a real project the seeded user
 *   can access. Without it the suite skips (mirrors roadmap-ticket-interaction).
 *
 * Run with:
 *   pnpm --filter web e2e tests/pm-import-filtering.spec.ts
 */

import { expect, type Page, type Route, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const TEST_DATA = {
	projectId: process.env.TEST_PERSONAL_PROJECT_ID || "<personal-project-id>",
};

const PM_TOOL_NAME = "FabricOnE2E";

// Ticket fixture: the full "board" the mocked adapter returns.
// IDs cover 417..425 so the `417, 419-425` grammar expansion maps cleanly and
// `418` exists for the already-imported scenario.
interface TicketFixture {
	id: string;
	displayId: string;
	title: string;
}

const BOARD_TICKETS: TicketFixture[] = [
	{ id: "417", displayId: "417", title: "Wire filter grammar parser" },
	{ id: "418", displayId: "418", title: "Already-imported sentinel" },
	{ id: "419", displayId: "419", title: "Adapter routing skeleton" },
	{ id: "420", displayId: "420", title: "In-memory type/state filter" },
	{ id: "421", displayId: "421", title: "ADO batch-get push-down" },
	{ id: "422", displayId: "422", title: "Dialog filter shell" },
	{ id: "423", displayId: "423", title: "Notes + issues regions" },
	{ id: "424", displayId: "424", title: "Telemetry + metrics" },
	{ id: "425", displayId: "425", title: "E2E spec" },
	{ id: "500", displayId: "500", title: "Retired milestone" },
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
	filters?: {
		ids?: number[];
	};
}

interface ListPMTicketsResponse {
	tickets: { id: string; displayId: string; title: string }[];
	total: number;
	totalOnBoard: number;
	alreadySynced: number;
	page: number;
	pageSize: number;
	hasNextPage: boolean;
	notes: { kind: "already_imported"; id: number }[];
	errors: { kind: "not_found" | "wrong_board"; id: number }[];
}

/**
 * Build a `listPMTickets` response that emulates the server-side filter
 * semantics (ID match, already-imported hide + note, search-by-title).
 */
function buildListResponse(
	input: ListPMTicketsInput,
	alreadyImportedIds: Set<number>,
): ListPMTicketsResponse {
	const pageSize = input.pageSize ?? 20;
	const filters = input.filters ?? {};
	const idSet = filters.ids ? new Set(filters.ids) : null;

	let filtered = BOARD_TICKETS.slice();

	if (idSet) {
		filtered = filtered.filter((t) => idSet.has(Number(t.id)));
	}

	// Search matches against title + displayId (mirrors server §5.3).
	const q = input.search?.trim().toLowerCase();
	if (q) {
		filtered = filtered.filter(
			(t) =>
				t.displayId.toLowerCase().includes(q) ||
				t.title.toLowerCase().includes(q),
		);
	}

	// Hide already-imported IDs; surface them as notes (AC-9).
	const notes: { kind: "already_imported"; id: number }[] = [];
	filtered = filtered.filter((t) => {
		const n = Number(t.id);
		if (alreadyImportedIds.has(n)) {
			notes.push({ kind: "already_imported", id: n });
			return false;
		}
		return true;
	});

	// Requested IDs not on board → not_found.
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
		})),
		total: filtered.length,
		totalOnBoard: BOARD_TICKETS.length,
		alreadySynced: alreadyImportedIds.size,
		page,
		pageSize,
		hasNextPage: start + pageSize < filtered.length,
		notes,
		errors,
	};
}

/**
 * oRPC RPCLink wraps inputs as `{ json: <input> }` — the same wrapper is used
 * on responses. We tolerate either shape to stay robust across serializer
 * updates.
 */
function unwrapOrpcInput<T>(body: unknown): T {
	if (body && typeof body === "object" && "json" in body) {
		return (body as { json: T }).json;
	}
	return body as T;
}

function orpcJsonResponse(payload: unknown): string {
	// RPCLink's JSON serializer expects `{ json: <payload> }` envelope.
	return JSON.stringify({ json: payload });
}

/** Install PM-related oRPC interceptors for the dialog flow. */
async function installPMMocks(
	page: Page,
	options: { alreadyImportedIds?: number[] } = {},
): Promise<void> {
	const alreadyImportedIds = new Set(options.alreadyImportedIds ?? []);

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

	await page.route(
		"**/api/rpc/projects/stories/listPMTickets**",
		async (route: Route) => {
			const req = route.request();
			let input: ListPMTicketsInput = { projectId: TEST_DATA.projectId };
			try {
				const parsed = req.postDataJSON() as unknown;
				input = unwrapOrpcInput<ListPMTicketsInput>(parsed);
			} catch {
				// Fall through with default input — keeps the mock resilient to
				// empty bodies during hot-reload fetches.
			}
			const payload = buildListResponse(input, alreadyImportedIds);
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

async function openPullDialog(page: Page): Promise<void> {
	await page
		.getByRole("button", {
			name: new RegExp(`Pull from ${PM_TOOL_NAME}`, "i"),
		})
		.first()
		.click();
	await expect(page.getByRole("dialog")).toBeVisible();
	// Wait for initial listPMTickets fetch to resolve (board stats visible).
	await expect(page.getByRole("dialog").getByText(/on board/i)).toBeVisible();
}

function dialog(page: Page) {
	return page.getByRole("dialog");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("PM import filtering", () => {
	test.beforeEach(async () => {
		skipIfNoData(TEST_DATA.projectId);
	});

	test("IDs filter: `417, 419-425` shows exactly those rows (AC-1)", async ({
		page,
	}) => {
		await installPMMocks(page);
		await gotoRoadmap(page, TEST_DATA.projectId);
		await openPullDialog(page);

		const d = dialog(page);

		await d.getByLabel(/Ticket IDs/i).fill("417, 419-425");
		await d.getByRole("button", { name: /^Apply$/ }).click();

		// Exactly IDs 417, 419..425 render (eight rows). 418 is omitted (gap),
		// 500 is off the requested set.
		for (const id of [417, 419, 420, 421, 422, 423, 424, 425]) {
			await expect(d.getByText(`#${id}`, { exact: true })).toBeVisible();
		}
		await expect(d.getByText("#418", { exact: true })).not.toBeVisible();
		await expect(d.getByText("#500", { exact: true })).not.toBeVisible();
	});

	test("Already-imported ID: row hidden, note surfaced (AC-9)", async ({
		page,
	}) => {
		await installPMMocks(page, { alreadyImportedIds: [418] });
		await gotoRoadmap(page, TEST_DATA.projectId);
		await openPullDialog(page);

		const d = dialog(page);

		await d.getByLabel(/Ticket IDs/i).fill("418");
		await d.getByRole("button", { name: /^Apply$/ }).click();

		// Row absent.
		await expect(d.getByText("#418", { exact: true })).not.toBeVisible();

		// Notes region present with the exact copy.
		await expect(d.getByText(/#418 is already imported/i)).toBeVisible();
	});

	test("Invalid ID `abc`: Apply disabled, inline error visible (AC-7, AC-13)", async ({
		page,
	}) => {
		await installPMMocks(page);
		await gotoRoadmap(page, TEST_DATA.projectId);
		await openPullDialog(page);

		const d = dialog(page);

		await d.getByLabel(/Ticket IDs/i).fill("abc");

		const applyBtn = d.getByRole("button", { name: /^Apply$/ });
		await expect(applyBtn).toBeDisabled();

		// Inline error uses role="alert" inside TicketIdsField.
		await expect(
			d.getByRole("alert").filter({ hasText: /IDs must be numeric/i }),
		).toBeVisible();
	});

	test("Clear filters resets the ID field", async ({ page }) => {
		await installPMMocks(page);
		await gotoRoadmap(page, TEST_DATA.projectId);
		await openPullDialog(page);

		const d = dialog(page);

		// Enter an ID, apply, then clear.
		await d.getByLabel(/Ticket IDs/i).fill("417");
		await d.getByRole("button", { name: /^Apply$/ }).click();

		// Confirm only 417 shows.
		await expect(d.getByText("#417", { exact: true })).toBeVisible();
		await expect(d.getByText("#419", { exact: true })).not.toBeVisible();

		await d.getByRole("button", { name: /Clear filters/i }).click();

		// IDs textarea is cleared.
		await expect(d.getByLabel(/Ticket IDs/i)).toHaveValue("");
		// Other tickets reappear.
		await expect(d.getByText("#419", { exact: true })).toBeVisible();
	});
});
