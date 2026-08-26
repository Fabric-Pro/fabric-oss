/**
 * CreateStoryDialog — happy-path WITHOUT attachments (Task 7 / spec
 * 2026-05-22-story-image-attachments).
 *
 * Companion to `create-story-with-attachments.spec.ts`. Where that test proves
 * the deferred-upload pipeline fires in the correct order when files are
 * attached, this test proves the OPPOSITE invariant: when the user submits
 * without attaching anything, the upload-related procedures must NEVER run.
 *
 * Expected behaviour for a no-attachments submit:
 *
 *   1. createStory                 — called EXACTLY ONCE
 *   2. createMediaUploadUrl        — NEVER called (no files → no signed URL)
 *   3. S3 PUT                      — NEVER called
 *   4. updateStory                 — NEVER called (no `## Attachments` to append)
 *   5. dialog closes
 *
 * This guards against regressions where a future refactor accidentally fires
 * the upload/update legs of the pipeline on every submit (e.g. an empty-array
 * loop that still calls `createMediaUploadUrl` with zero items, or a "patch
 * description" call that runs unconditionally inside `onSuccess`).
 *
 * Mirrors the mocking idioms of `create-story-with-attachments.spec.ts`:
 * deterministic in-memory state, oRPC envelope helpers, identical fixture
 * payloads. The only behavioural difference is that we do NOT drop a file
 * into the dropzone before clicking Create.
 *
 * Run:
 *   pnpm --filter web e2e tests/create-story-no-attachments.spec.ts
 */

import { expect, type Page, type Route, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Constants — fake but URL-shaped IDs (the test never hits a real DB).
// ---------------------------------------------------------------------------

const PROJECT_ID = "test-create-story-no-attach-project-id";
const NEW_STORY_ID = "test-create-story-no-attach-new-id";
const STATUS_ID = "test-create-story-no-attach-status-id";

// ---------------------------------------------------------------------------
// oRPC envelope helpers (mirror create-story-with-attachments.spec.ts).
// ---------------------------------------------------------------------------

function orpcJsonResponse(payload: unknown): string {
	return JSON.stringify({ json: payload });
}

function unwrapOrpcInput<T>(body: unknown): T {
	if (body && typeof body === "object" && "json" in body) {
		return (body as { json: T }).json;
	}
	return body as T;
}

async function fulfillJson(route: Route, payload: unknown): Promise<void> {
	await route.fulfill({
		status: 200,
		contentType: "application/json",
		body: orpcJsonResponse(payload),
	});
}

async function fulfillEmpty(route: Route): Promise<void> {
	await route.fulfill({
		status: 200,
		contentType: "application/json",
		body: orpcJsonResponse({}),
	});
}

// ---------------------------------------------------------------------------
// Mock fixture payloads.
// ---------------------------------------------------------------------------

function buildProjectPayload() {
	const now = new Date().toISOString();
	return {
		project: {
			id: PROJECT_ID,
			name: "Create Story Project (no attachments)",
			description: null,
			status: "ACTIVE",
			projectType: "GENERAL",
			projectTypes: [],
			organizationId: null,
			userId: "test-user-id",
			settings: null,
			ragSettings: null,
			pinned: false,
			deletedAt: null,
			createdAt: now,
			updatedAt: now,
			userRole: "OWNER",
			canEditSettings: true,
			repositoryUrl: null,
			repositoryOwner: null,
			repositoryName: null,
			defaultBranch: null,
			implementationDefaultChannel: null,
			implementationDefaultProvider: null,
		},
	};
}

function buildStatusesPayload() {
	const now = new Date().toISOString();
	return {
		statuses: [
			{
				id: STATUS_ID,
				projectId: PROJECT_ID,
				name: "Todo",
				color: "#6B7280",
				order: 0,
				isDefault: true,
				createdAt: now,
				updatedAt: now,
			},
		],
	};
}

function buildStoriesPayload() {
	// Start with an empty board.
	return { stories: [] };
}

// Server returns this from `projects.stories.create` (see
// `packages/api/modules/projects/procedures/stories/create-story.ts:215`).
function buildCreateStoryResponse(description: string) {
	return {
		story: {
			id: NEW_STORY_ID,
			projectId: PROJECT_ID,
			titleSource: "AI",
			description,
		},
		aiGenerated: false,
	};
}

interface MockState {
	createCalls: number;
	uploadUrlCalls: number;
	s3PutCalls: number;
	updateCalls: number;
	lastCreateInput: { description?: string; projectId?: string } | null;
}

function makeState(): MockState {
	return {
		createCalls: 0,
		uploadUrlCalls: 0,
		s3PutCalls: 0,
		updateCalls: 0,
		lastCreateInput: null,
	};
}

// ---------------------------------------------------------------------------
// Install oRPC + S3 mocks for the project board + create-story pipeline.
// The createMediaUploadUrl / update / S3 PUT handlers increment counters that
// MUST remain 0 in this no-attachments test.
// ---------------------------------------------------------------------------

async function installMocks(page: Page, state: MockState): Promise<void> {
	// Project metadata (ProjectDetails + StoriesRoadmap both fetch this).
	await page.route("**/api/rpc/projects/get**", (route) =>
		fulfillJson(route, buildProjectPayload()),
	);

	// Kanban board data.
	await page.route("**/api/rpc/projects/stories/statuses/list**", (route) =>
		fulfillJson(route, buildStatusesPayload()),
	);
	await page.route("**/api/rpc/projects/stories/list**", (route) =>
		fulfillJson(route, buildStoriesPayload()),
	);

	// Ancillary queries — non-blocking; stub empty.
	await page.route("**/api/rpc/projects/stories/pmCapabilities**", (route) =>
		fulfillJson(route, {
			configured: false,
			capabilities: { canCreate: false, canList: false },
			containerName: null,
			containerId: null,
			mcpConfigId: null,
		}),
	);
	await page.route("**/api/rpc/projects/contexts/list**", (route) =>
		fulfillJson(route, { contexts: [] }),
	);
	await page.route("**/api/rpc/projects/members/list**", (route) =>
		fulfillJson(route, { members: [] }),
	);
	await page.route("**/api/rpc/mcp/configs/list**", (route) =>
		fulfillJson(route, []),
	);
	await page.route("**/api/rpc/projects/documents/list**", (route) =>
		fulfillJson(route, { documents: [] }),
	);
	await page.route("**/api/rpc/projects/ragSettings/get**", (route) =>
		fulfillEmpty(route),
	);

	// ----- Create-story mutation: capture the input so we can assert the
	// description was sent verbatim (no `## Attachments` block appended). -----
	await page.route("**/api/rpc/projects/stories/create**", async (route) => {
		state.createCalls += 1;
		const input = unwrapOrpcInput<{
			description?: string;
			projectId?: string;
		}>(route.request().postDataJSON());
		state.lastCreateInput = {
			description: input?.description,
			projectId: input?.projectId,
		};
		await fulfillJson(
			route,
			buildCreateStoryResponse(input?.description ?? ""),
		);
	});

	// ----- Tripwires: these procedures MUST NOT be called in this test. -----
	// We still register handlers (rather than letting them 404) so that if a
	// regression ever fires them we get a meaningful counter assertion failure
	// rather than a cryptic network error masking the real bug.
	await page.route(
		"**/api/rpc/projects/stories/createMediaUploadUrl**",
		async (route) => {
			state.uploadUrlCalls += 1;
			await fulfillJson(route, {
				signedUploadUrl: "https://should-never-be-called.local/upload",
				s3Key: "should-never-be-called",
				useServerUpload: false,
				storageProvider: "mock",
			});
		},
	);

	await page.route("**/api/rpc/projects/stories/update**", async (route) => {
		state.updateCalls += 1;
		await fulfillJson(route, {
			story: { id: NEW_STORY_ID, description: "" },
		});
	});

	// Catch-all for any signed S3 PUT — also a tripwire.
	await page.route(
		"https://should-never-be-called.local/**",
		async (route) => {
			state.s3PutCalls += 1;
			await route.fulfill({ status: 200, body: "" });
		},
	);
}

// ---------------------------------------------------------------------------
// Open the project's Roadmap (kanban) tab — `ProjectDetails` reads the active
// tab from localStorage, so seed it before navigation to land on the board
// without an extra user click.
// ---------------------------------------------------------------------------

async function seedActiveTab(page: Page): Promise<void> {
	await page.addInitScript(
		({ projectId }) => {
			try {
				window.localStorage.setItem(
					`project-tab-${projectId}`,
					"stories",
				);
				window.localStorage.setItem(
					`fabric-project-tab-${projectId}`,
					"stories",
				);
			} catch {
				// Storage may be unavailable in some sandboxes — fall through;
				// the test will fall back to clicking the Roadmap tab.
			}
		},
		{ projectId: PROJECT_ID },
	);
}

// ---------------------------------------------------------------------------
// Test.
// ---------------------------------------------------------------------------

test.describe("CreateStoryDialog — happy path WITHOUT attachments", () => {
	test("submit with no files → only create fires; no upload-url, no update", async ({
		page,
	}) => {
		const state = makeState();
		await installMocks(page, state);
		await seedActiveTab(page);

		// Navigate to the project page. The kanban (Roadmap) tab is seeded via
		// localStorage; if for any reason it doesn't take, click it manually.
		await page.goto(`/app/projects/${PROJECT_ID}`);

		// Best-effort: nudge the active tab if localStorage seeding didn't stick.
		const roadmapTab = page.getByRole("button", { name: /^Roadmap$/i });
		if (await roadmapTab.isVisible().catch(() => false)) {
			await roadmapTab.click();
		}

		// Open the Create Story dialog via the kanban toolbar "Add" button.
		const addButton = page.getByRole("button", { name: /^Add$/i }).first();
		await addButton.waitFor({ state: "visible", timeout: 20_000 });
		await addButton.click();

		// Dialog should be open with the description textarea visible.
		const dialog = page.getByRole("dialog");
		await dialog.waitFor({ state: "visible" });

		// Fill description ONLY — deliberately skip the dropzone interaction.
		const description = page.getByLabel(/What's this about\?/i);
		const submittedDescription =
			"Just a plain story, no screenshots needed.";
		await description.fill(submittedDescription);

		// Confirm the dropzone is rendered (i.e. the field exists) but we
		// intentionally do NOT interact with it. This makes the "no
		// attachments" condition explicit in the test, rather than a side
		// effect of the dropzone being absent.
		const dropzone = page.getByTestId("attachments-field-dropzone");
		await dropzone.waitFor({ state: "visible" });

		// Click Create.
		const createButton = dialog.getByRole("button", { name: /^Create$/i });
		await expect(createButton).toBeEnabled();

		const createPromise = page.waitForResponse(
			(r) =>
				r.url().includes("/api/rpc/projects/stories/create") &&
				r.status() === 200,
			{ timeout: 25_000 },
		);

		await createButton.click();

		await createPromise;

		// Give any (mistakenly fired) follow-up requests a chance to land
		// before we assert they didn't happen. Without this slack, the
		// "never called" assertions could pass simply because we checked
		// before the regression's network call completed. networkidle is
		// safer than a fixed sleep — it waits for genuine quiescence.
		await page.waitForLoadState("networkidle");

		// ---- Assertions ----

		// (1) Create fired exactly once.
		expect(state.createCalls).toBe(1);

		// (2) The description sent to the server is exactly what the user
		// typed — no `## Attachments` block, no markdown image refs. The
		// no-attachments path must NOT append anything.
		expect(state.lastCreateInput).not.toBeNull();
		expect(state.lastCreateInput?.projectId).toBe(PROJECT_ID);
		expect(state.lastCreateInput?.description).toBe(submittedDescription);
		expect(state.lastCreateInput?.description ?? "").not.toContain(
			"## Attachments",
		);

		// (3) The upload-related procedures were NEVER called. These are the
		// load-bearing invariants of Task 7 — a regression that fires
		// `createMediaUploadUrl` with an empty file list, or unconditionally
		// patches the description via `update`, would flip these to 1+.
		expect(state.uploadUrlCalls).toBe(0);
		expect(state.updateCalls).toBe(0);
		expect(state.s3PutCalls).toBe(0);

		// (4) Dialog closes on success. With no attachments, the close path
		// is the simple `onSuccess` branch (no awaiting uploads/patch).
		await expect(dialog).toBeHidden({ timeout: 10_000 });
	});
});
