/**
 * E2E tests for the PM-sync cloud toggle (Group 6, Tasks 6.5 + 6.6).
 *
 * Two scenarios:
 *
 *   6.5 — Happy-path: a Fabric-only feature with PM-tool integration
 *         configured renders the cloud icon in the OFF state, can be
 *         toggled ON, persists across reload, and shows up in the
 *         Synced state on the roadmap card too.
 *
 *   6.6 — Red-state: a project WITHOUT a PM-tool integration renders the
 *         cloud icon in the not-configured (Red) state on every surface.
 *         The tooltip body contains a real <Link> that navigates to the
 *         project's Settings > Integrations route.
 *
 * Strategy
 * --------
 * All oRPC calls are intercepted via `page.route` so the test is fully
 * deterministic — no real PM connection or live database state required.
 * The mocks return the server shapes the surfaces consume; the toggle's
 * mutation is observed via a `toggleUpdate` accumulator so we can assert
 * it carried `pmAutoSyncEnabled: true`.
 *
 * Prerequisites
 * -------------
 * - Dev server on :3001 (playwright.config webServer handles this).
 * - `TEST_PERSONAL_PROJECT_ID` env var set to a real project the seeded
 *   user can access. Without it the suite skips (mirrors the
 *   `re-sync-features.spec.ts` pattern).
 *
 * Run with:
 *   pnpm --filter web e2e tests/pm-sync-cloud-toggle.spec.ts
 */

import { expect, type Page, type Route, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Test data — same opt-in pattern as the other PM-sync E2E specs.
// ---------------------------------------------------------------------------

const TEST_DATA = {
	projectId: process.env.TEST_PERSONAL_PROJECT_ID || "<personal-project-id>",
};

const PM_TOOL_NAME = "FabricOnE2E";

// The story under test — Fabric-only (no externalId), pmAutoSyncEnabled
// flips between false and true depending on the test.
interface StoryFixture {
	id: string;
	identifier: string;
	title: string;
	pmAutoSyncEnabled: boolean;
}

const FABRIC_ONLY_STORY: StoryFixture = {
	id: "story-toggle-001",
	identifier: "F-201",
	title: "Auto-sync toggle smoke",
	pmAutoSyncEnabled: false,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skipIfNoData(projectId: string) {
	if (projectId.startsWith("<")) {
		test.skip();
	}
}

function orpcJsonResponse(payload: unknown): string {
	return JSON.stringify({ json: payload });
}

function unwrapOrpcInput<T>(body: unknown): T {
	if (body && typeof body === "object" && "json" in body) {
		return (body as { json: T }).json;
	}
	return body as T;
}

function buildStoryObject(
	fixture: StoryFixture,
	overrides: Partial<{ pmAutoSyncEnabled: boolean }> = {},
) {
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
		externalId: null,
		externalUrl: null,
		source: "manual",
		version: 1,
		draftingStage: "DRAFT",
		draftingStageUpdatedAt: null,
		externalSyncStatus: null,
		latestCodingRun: null,
		latestKanbanQueue: null,
		pmAutoSyncEnabled:
			overrides.pmAutoSyncEnabled ?? fixture.pmAutoSyncEnabled,
		lastPmSyncStatus: null,
		lastPmSyncError: null,
		lastPmSyncAttemptAt: null,
		lastSyncedAt: null,
	};
}

interface UpdateInput {
	storyId: string;
	pmAutoSyncEnabled?: boolean;
	title?: string;
}

interface MockState {
	story: StoryFixture;
	updates: UpdateInput[];
}

async function installStoriesMock(page: Page, state: MockState): Promise<void> {
	// stories.list — read by the roadmap.
	await page.route(
		"**/api/rpc/projects/stories/list**",
		async (route: Route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse([buildStoryObject(state.story)]),
			});
		},
	);

	// stories.get — read by the workspace editor.
	await page.route(
		"**/api/rpc/projects/stories/get**",
		async (route: Route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse({
					story: buildStoryObject(state.story),
				}),
			});
		},
	);

	// stories.update — the toggle's PATCH. Capture the input so the test
	// can assert what flipped, and reflect the change in the fixture so a
	// subsequent list/get reflects the new value (proves persistence).
	await page.route(
		"**/api/rpc/projects/stories/update**",
		async (route: Route) => {
			const req = route.request();
			let input: UpdateInput = { storyId: state.story.id };
			try {
				const parsed = req.postDataJSON() as unknown;
				input = unwrapOrpcInput<UpdateInput>(parsed);
			} catch {
				// fallback — treat as empty input
			}
			state.updates.push(input);
			if (typeof input.pmAutoSyncEnabled === "boolean") {
				state.story.pmAutoSyncEnabled = input.pmAutoSyncEnabled;
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse({
					story: buildStoryObject(state.story),
				}),
			});
		},
	);

	// statuses.list — required for the roadmap to render at all.
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

async function installPMCapabilitiesMock(
	page: Page,
	configured: boolean,
): Promise<void> {
	await page.route(
		"**/api/rpc/projects/stories/pmCapabilities**",
		async (route: Route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: orpcJsonResponse(
					configured
						? {
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
							}
						: {
								configured: false,
								capabilities: null,
								containerName: null,
								mcpConfigId: null,
								containerId: null,
								additionalContext: null,
								error: null,
							},
				),
			});
		},
	);
}

async function gotoEditor(
	page: Page,
	projectId: string,
	storyId: string,
): Promise<void> {
	await page.goto(`/app/projects/${projectId}/stories/${storyId}`);
	await page.waitForLoadState("networkidle");
}

async function gotoRoadmap(page: Page, projectId: string): Promise<void> {
	await page.goto(`/app/projects/${projectId}`);
	await page.getByRole("tab", { name: /Roadmap/i }).click();
	await page.waitForLoadState("networkidle");
}

// ---------------------------------------------------------------------------
// Task 6.5 — Happy path: toggle ON in editor, save, reload, parity on roadmap
// ---------------------------------------------------------------------------

test.describe("6.5: Cloud toggle happy path — toggle ON arms initial push", () => {
	test.beforeEach(async () => {
		skipIfNoData(TEST_DATA.projectId);
	});

	test("Off → click toggle → Synced (armed) → reload preserves state → roadmap shows same state", async ({
		page,
	}) => {
		const state: MockState = {
			story: { ...FABRIC_ONLY_STORY, pmAutoSyncEnabled: false },
			updates: [],
		};
		await installStoriesMock(page, state);
		await installPMCapabilitiesMock(page, true);

		// 1. Open the feature in the workspace editor.
		await gotoEditor(page, TEST_DATA.projectId, FABRIC_ONLY_STORY.id);

		// 2. Assert the cloud icon renders in the Off state. The icon is a
		//    button with aria-label "Auto-sync off. Click to enable."
		const offToggle = page.getByRole("button", {
			name: /Auto-sync off\. Click to enable\./i,
		});
		await expect(offToggle).toBeVisible();

		// 3. Click the toggle to flip it ON.
		await offToggle.click();

		// 4. Assert the toggle flipped to the Synced (armed) state. For a
		//    Fabric-only feature with no externalId, the armed sub-state
		//    uses the "Will push to {pmToolName} on next save" copy.
		const armedToggle = page.getByRole("button", {
			name: new RegExp(
				`Will push to ${PM_TOOL_NAME} on next save\\. Click to disable\\.`,
				"i",
			),
		});
		await expect(armedToggle).toBeVisible({ timeout: 5000 });

		// 5. Assert the PATCH carried pmAutoSyncEnabled: true.
		expect(state.updates).toHaveLength(1);
		expect(state.updates[0].pmAutoSyncEnabled).toBe(true);
		expect(state.updates[0].storyId).toBe(FABRIC_ONLY_STORY.id);

		// 6. Reload the page. The toggle should stay in the armed state
		//    because the mock now returns pmAutoSyncEnabled=true.
		await page.reload();
		await page.waitForLoadState("networkidle");
		await expect(
			page.getByRole("button", {
				name: new RegExp(
					`Will push to ${PM_TOOL_NAME} on next save`,
					"i",
				),
			}),
		).toBeVisible();

		// 7. Navigate to the roadmap. The story card's cloud icon should
		//    also be in the armed (display-only) state. The card surface
		//    renders the icon as a non-interactive span.
		await gotoRoadmap(page, TEST_DATA.projectId);
		const cardIcon = page
			.getByRole("img", {
				name: new RegExp(
					`Will push to ${PM_TOOL_NAME} on next save`,
					"i",
				),
			})
			.first();
		await expect(cardIcon).toBeVisible();
	});
});

// ---------------------------------------------------------------------------
// Task 6.6 — Red state: project without PM integration shows non-actionable
//             icon and a working Settings link inside the tooltip
// ---------------------------------------------------------------------------

test.describe("6.6: Cloud toggle Red state — no PM integration configured", () => {
	test.beforeEach(async () => {
		skipIfNoData(TEST_DATA.projectId);
	});

	test("editor + roadmap card both show the Red state and the tooltip Settings link navigates", async ({
		page,
	}) => {
		const state: MockState = {
			story: { ...FABRIC_ONLY_STORY, pmAutoSyncEnabled: false },
			updates: [],
		};
		await installStoriesMock(page, state);
		await installPMCapabilitiesMock(page, false);

		// 1. Open the feature in the editor.
		await gotoEditor(page, TEST_DATA.projectId, FABRIC_ONLY_STORY.id);

		// 2. Assert the Red icon renders. The Red state uses role="img" with
		//    aria-disabled and aria-label "No PM tool configured."
		const editorRedIcon = page.getByRole("img", {
			name: /No PM tool configured\./i,
		});
		await expect(editorRedIcon).toBeVisible();
		await expect(editorRedIcon).toHaveAttribute("aria-disabled", "true");

		// 3. The Red icon must NOT also surface as a button — that would
		//    indicate the wrong state-derivation branch ran.
		await expect(
			page.getByRole("button", { name: /No PM tool configured/i }),
		).toHaveCount(0);

		// 4. Hover the Red icon to open the tooltip and click the Settings
		//    link inside its body. We don't await the navigation strictly
		//    because the test's mocks don't extend to /settings/integrations
		//    — we only need to assert the link's href is correct.
		await editorRedIcon.hover();

		// The link target is "/app/settings/integrations" for personal
		// context. The tooltip is portaled so we look across the whole DOM.
		const settingsLink = page
			.getByRole("link", { name: /Settings.*Integrations/i })
			.first();
		await expect(settingsLink).toBeVisible({ timeout: 5000 });
		await expect(settingsLink).toHaveAttribute(
			"href",
			"/app/settings/integrations",
		);

		// 5. Navigate to the roadmap and confirm the StoryCard also shows
		//    the Red icon.
		await gotoRoadmap(page, TEST_DATA.projectId);
		await expect(
			page.getByRole("img", { name: /No PM tool configured\./i }).first(),
		).toBeVisible();
	});
});
