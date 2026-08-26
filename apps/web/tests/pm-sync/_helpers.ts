/**
 * Shared helpers and oRPC mock builders for the F-1166 PM-sync E2E suite.
 *
 * The three spec files (happy-path, conflict-path, failure-path) all need:
 *   - A `pmCapabilities` interceptor that reports a configured PM tool.
 *   - A `stories.list` interceptor that returns a single synced fixture story
 *     whose `lastPmSyncStatus` is driven by a mutable state object — the test
 *     mutates the state, then refetches via `queryClient.invalidateQueries`
 *     triggered by the badge click / mutation, and the next list response
 *     reflects the new status.
 *   - Conflict / retry / update mocks that flip the state.
 *
 * We share the fixture and helpers here to keep each spec file readable.
 */
import { expect, type Page, type Route } from "@playwright/test";

export const PM_TOOL_NAME = "FabricOnE2E";

export const TEST_DATA = {
	projectId: process.env.TEST_PERSONAL_PROJECT_ID || "<personal-project-id>",
};

type PmSyncStatus = "PENDING" | "SUCCESS" | "CONFLICT" | "FAILED" | null;

export interface SyncedStoryFixture {
	id: string;
	identifier: string;
	title: string;
	description: string | null;
	externalId: string;
	externalUrl: string;
	lastPmSyncStatus: PmSyncStatus;
	lastPmSyncError: string | null;
	lastPmSyncAttemptAt: string | null;
}

export const SYNCED_STORY: SyncedStoryFixture = {
	id: "story-pm-sync-1166-001",
	identifier: "F-1166",
	title: "Synced feature under PM sync test",
	description: "Original Fabric description.",
	externalId: "ext-1166-1",
	externalUrl: "https://example.com/ticket/1166-1",
	lastPmSyncStatus: null,
	lastPmSyncError: null,
	lastPmSyncAttemptAt: null,
};

export function skipIfNoData(projectId: string, test: { skip: () => void }) {
	if (projectId.startsWith("<")) {
		test.skip();
	}
}

export function orpcJsonResponse(payload: unknown): string {
	return JSON.stringify({ json: payload });
}

export function unwrapOrpcInput<T>(body: unknown): T {
	if (body && typeof body === "object" && "json" in body) {
		return (body as { json: T }).json;
	}
	return body as T;
}

/**
 * Snapshot the mutable story state into the shape the stories.list oRPC
 * procedure returns.
 */
function buildStoryRow(story: SyncedStoryFixture) {
	return {
		id: story.id,
		identifier: story.identifier,
		// `kind` drives ConflictResolveDialog's itemType ("story" vs "bug").
		// Default to a non-bug feature/story so the unified resolve dialog
		// reads itemType="story".
		kind: "FEATURE",
		title: story.title,
		description: story.description,
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
		createdAt: new Date("2026-04-01T00:00:00Z").toISOString(),
		updatedAt: new Date().toISOString(),
		externalId: story.externalId,
		externalUrl: story.externalUrl,
		version: 1,
		draftingStage: "PUBLISHED",
		draftingStageUpdatedAt: null,
		externalSyncStatus: null,
		latestCodingRun: null,
		latestKanbanQueue: null,
		// F-1166 fields:
		lastPmSyncStatus: story.lastPmSyncStatus,
		lastPmSyncError: story.lastPmSyncError,
		lastPmSyncAttemptAt: story.lastPmSyncAttemptAt,
		lastSyncedAt: null,
		lastSyncedPmHash: null,
	};
}

export async function installCapabilitiesAndStatuses(
	page: Page,
): Promise<void> {
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

/**
 * Install a stories.list interceptor that snapshots the current `state.story`
 * each time the route is hit. Tests mutate `state.story` directly; the next
 * query invalidation will pick up the mutation.
 */
export async function installStoriesListMock(
	page: Page,
	state: { story: SyncedStoryFixture },
): Promise<void> {
	await page.route(
		"**/api/rpc/projects/stories/list**",
		async (route: Route) => {
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				// stories.list returns a { statuses, stories } envelope —
				// StoriesRoadmap reads `storiesData?.stories`, so a bare
				// array renders zero cards.
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
					stories: [buildStoryRow(state.story)],
				}),
			});
		},
	);
}

export async function gotoRoadmap(
	page: Page,
	projectId: string,
): Promise<void> {
	await page.goto(`/app/projects/${projectId}`);
	// Wait for the stories.list fetch the roadmap mount triggers instead of
	// networkidle — the Fabric Agent panel polls continuously, so the network
	// never goes idle.
	const storiesListLoaded = page.waitForResponse((response) =>
		response.url().includes("/api/rpc/projects/stories/list"),
	);
	// The project view switcher renders as plain buttons; accept a tablist
	// implementation too so the helper survives either markup.
	await page
		.getByRole("tab", { name: /Roadmap/i })
		.or(page.getByRole("button", { name: /Roadmap/i }))
		.first()
		.click();
	await storiesListLoaded;
}

/** Open inline rename input for the given story. */
export async function startInlineRename(
	page: Page,
	storyTitle: string,
): Promise<void> {
	const titleBtn = page
		.getByRole("button", {
			name: new RegExp(
				`Open details for ${escapeRegex(storyTitle)}`,
				"i",
			),
		})
		.first();
	await expect(titleBtn).toBeVisible();
	await titleBtn.hover();

	const renameBtn = page
		.getByRole("button", { name: /Rename feature/i })
		.first();
	await expect(renameBtn).toBeVisible({ timeout: 3000 });
	await renameBtn.click();
}

function escapeRegex(input: string): string {
	return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
