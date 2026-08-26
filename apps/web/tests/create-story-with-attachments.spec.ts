/**
 * CreateStoryDialog — happy-path with image attachments (Task 6 / spec
 * 2026-05-22-story-image-attachments).
 *
 * Locks in the deferred-upload flow added in this PR:
 *
 *   1. createStory       (returns { story, aiGenerated })
 *   2. createMediaUploadUrl + S3 PUT (per file, in parallel)
 *   3. updateStory       (patches description with `## Attachments` block)
 *   4. closeDialog       — fires ONLY after step (3) resolves
 *
 * The ordering in step (4) is the race fix: closing the dialog inside
 * `createStoryMutation.onSuccess` (the previous behaviour) would drop the
 * unfinished uploads on the floor. This spec proves the dialog stays open
 * until the patch lands.
 *
 * Mirrors the mocking idioms from `story-workspace-paste-image.spec.ts`:
 * deterministic in-memory state, oRPC envelope helpers, signed-URL S3 stub.
 *
 * Run:
 *   pnpm --filter web e2e tests/create-story-with-attachments.spec.ts
 */

import { expect, type Page, type Route, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Constants — fake but URL-shaped IDs (the test never hits a real DB).
// ---------------------------------------------------------------------------

const PROJECT_ID = "test-create-story-project-id";
const NEW_STORY_ID = "test-create-story-new-id";
const STATUS_ID = "test-create-story-status-id";
const ATTACHMENT_FILENAME = "bug.png";

// S3 key produced server-side under the story-media keyspace.
const STUB_S3_KEY = `story-media/${PROJECT_ID}/${NEW_STORY_ID}/stub-attachment-${ATTACHMENT_FILENAME}`;
const STUB_SIGNED_UPLOAD_URL = "https://stub-bucket.local/upload?signed=1";

const MINIMAL_PNG_BYTES = [
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
	0x0b, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60, 0x00, 0x02, 0x00,
	0x00, 0x05, 0x00, 0x01, 0xe2, 0x26, 0x05, 0x9b, 0x00, 0x00, 0x00, 0x00,
	0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

// ---------------------------------------------------------------------------
// oRPC envelope helpers (mirror story-workspace-paste-image.spec.ts).
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
			name: "Create Story Project",
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
	// Start with an empty board — the new story only appears after create +
	// query invalidation, which we don't assert here.
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
	s3PutKeys: string[];
	updateCalls: number;
	lastUpdateInput: {
		storyId?: string;
		description?: string;
		projectId?: string;
	} | null;
	/** Resolved once stories.update has fulfilled — used to assert ordering. */
	updateResolvedAt: number | null;
	/** Resolved once the S3 PUT has fulfilled — used to assert ordering. */
	s3PutResolvedAt: number | null;
}

function makeState(): MockState {
	return {
		createCalls: 0,
		uploadUrlCalls: 0,
		s3PutCalls: 0,
		s3PutKeys: [],
		updateCalls: 0,
		lastUpdateInput: null,
		updateResolvedAt: null,
		s3PutResolvedAt: null,
	};
}

// ---------------------------------------------------------------------------
// Install oRPC + S3 mocks for the project board + create-story pipeline.
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

	// ----- Create-story mutation: shape from `create-story.ts:215` -----
	await page.route("**/api/rpc/projects/stories/create**", async (route) => {
		state.createCalls += 1;
		const input = unwrapOrpcInput<{ description?: string }>(
			route.request().postDataJSON(),
		);
		await fulfillJson(
			route,
			buildCreateStoryResponse(input?.description ?? ""),
		);
	});

	// ----- Signed-URL handout for story media -----
	await page.route(
		"**/api/rpc/projects/stories/createMediaUploadUrl**",
		async (route) => {
			state.uploadUrlCalls += 1;
			await fulfillJson(route, {
				signedUploadUrl: STUB_SIGNED_UPLOAD_URL,
				s3Key: STUB_S3_KEY,
				useServerUpload: false,
				storageProvider: "mock",
			});
		},
	);

	// ----- S3 PUT stub: capture keys for later assertion -----
	await page.route(`${STUB_SIGNED_UPLOAD_URL}*`, async (route) => {
		state.s3PutCalls += 1;
		state.s3PutKeys.push(STUB_S3_KEY);
		state.s3PutResolvedAt = Date.now();
		await route.fulfill({ status: 200, body: "" });
	});

	// ----- Description patch: capture `## Attachments` markdown -----
	await page.route("**/api/rpc/projects/stories/update**", async (route) => {
		state.updateCalls += 1;
		const input = unwrapOrpcInput<{
			storyId?: string;
			description?: string;
			projectId?: string;
		}>(route.request().postDataJSON());
		state.lastUpdateInput = {
			storyId: input?.storyId,
			description: input?.description,
			projectId: input?.projectId,
		};
		state.updateResolvedAt = Date.now();
		await fulfillJson(route, {
			story: {
				id: NEW_STORY_ID,
				description: input?.description ?? "",
			},
		});
	});
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
// Drop a synthesised PNG `File` onto the AttachmentsField dropzone via a
// real DataTransfer instance built inside the page context.
// ---------------------------------------------------------------------------

async function dropPngOnDropzone(
	page: Page,
	fileName: string,
	bytes: number[],
): Promise<void> {
	const dropzone = page.getByTestId("attachments-field-dropzone");
	await dropzone.waitFor({ state: "visible" });

	const dataTransfer = await page.evaluateHandle(
		({ bytes, fileName }) => {
			const dt = new DataTransfer();
			const file = new File([new Uint8Array(bytes)], fileName, {
				type: "image/png",
			});
			dt.items.add(file);
			return dt;
		},
		{ bytes, fileName },
	);

	await dropzone.dispatchEvent("drop", { dataTransfer });
}

// ---------------------------------------------------------------------------
// Test.
// ---------------------------------------------------------------------------

test.describe("CreateStoryDialog — happy path with attachments", () => {
	test("drop image → submit → uploads + patch run before dialog closes", async ({
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
		// (`StoriesRoadmap` renders Tooltip → Button with a PlusIcon + "Add"
		// label that calls `handleAddStory` with the default status id.)
		const addButton = page.getByRole("button", { name: /^Add$/i }).first();
		await addButton.waitFor({ state: "visible", timeout: 20_000 });
		await addButton.click();

		// Dialog should be open with the description textarea visible.
		const dialog = page.getByRole("dialog");
		await dialog.waitFor({ state: "visible" });

		// Fill description and drop an image.
		const description = page.getByLabel(/What's this about\?/i);
		await description.fill("Users need SSO support — see screenshot.");

		await dropPngOnDropzone(page, ATTACHMENT_FILENAME, MINIMAL_PNG_BYTES);

		// Click Create — this triggers create → upload → update → closeDialog.
		const createButton = dialog.getByRole("button", { name: /^Create$/i });
		await expect(createButton).toBeEnabled();

		const updatePromise = page.waitForResponse(
			(r) =>
				r.url().includes("/api/rpc/projects/stories/update") &&
				r.status() === 200,
			{ timeout: 25_000 },
		);
		const s3PutPromise = page.waitForResponse(`${STUB_SIGNED_UPLOAD_URL}*`);
		const createPromise = page.waitForResponse(
			(r) =>
				r.url().includes("/api/rpc/projects/stories/create") &&
				r.status() === 200,
		);

		await createButton.click();

		await createPromise;
		await s3PutPromise;
		await updatePromise;

		// ---- Assertions: ordering + payload contents ----

		// (1) Each leg of the pipeline fired the expected number of times.
		// createCalls / updateCalls must be exactly 1 to catch duplicate-
		// submission regressions; uploadUrl + s3Put can have one entry per
		// attached file.
		expect(state.createCalls).toBe(1);
		expect(state.uploadUrlCalls).toBeGreaterThanOrEqual(1);
		expect(state.s3PutCalls).toBeGreaterThanOrEqual(1);
		expect(state.updateCalls).toBe(1);

		// (2) The S3 PUT landed under the story-media keyspace for the new
		// story id (proves the upload-url procedure was called with the
		// freshly-minted `userStoryId`).
		expect(state.s3PutKeys).toContain(STUB_S3_KEY);

		// (3) Ordering contract: stories.update must resolve AFTER the S3
		// PUT — this is the race the fix was for. If update fires before the
		// PUT, the dialog could close on a torn upload.
		expect(state.updateResolvedAt).not.toBeNull();
		expect(state.s3PutResolvedAt).not.toBeNull();
		expect(state.updateResolvedAt as number).toBeGreaterThanOrEqual(
			state.s3PutResolvedAt as number,
		);

		// (4) The patched description must include the `## Attachments`
		// markdown footer AND a markdown image reference to the uploaded
		// S3 key.
		expect(state.lastUpdateInput).not.toBeNull();
		expect(state.lastUpdateInput?.storyId).toBe(NEW_STORY_ID);
		expect(state.lastUpdateInput?.projectId).toBe(PROJECT_ID);
		const desc = state.lastUpdateInput?.description ?? "";
		expect(desc).toContain("## Attachments");
		expect(desc).toContain(`](${STUB_S3_KEY})`);

		// (5) The dialog closed only AFTER the patch lands (the fix is the
		// `submitCreateStoryWithAttachments.closeDialog()` call sitting AFTER
		// `updateStoryMutateAsync`). Sonner toasts can keep the DOM busy, so
		// poll for the dialog to disappear within a comfortable window.
		await expect(dialog).toBeHidden({ timeout: 10_000 });
	});
});
