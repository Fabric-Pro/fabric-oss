/**
 * CreateStoryDialog — partial-upload-failure path (Task 8 / spec
 * 2026-05-22-story-image-attachments).
 *
 * Pins the "some uploads fail" branch of `submitCreateStoryWithAttachments`:
 *
 *   1. createStory                          (succeeds)
 *   2. createMediaUploadUrl × 2             (one OK signed URL, one failing)
 *   3. S3 PUT × 2                           (200 for ok.png, 500 for broken.png)
 *   4. updateStory                          (called exactly once, with a
 *                                            description that contains ONLY
 *                                            the ok.png s3Key — NOT broken.png)
 *   5. toast.warning                        (text: /1 of 2 attachments uploaded/i)
 *
 * Mirrors the canonical pattern in `create-story-with-attachments.spec.ts`
 * (commit 4bf673a43) verbatim, with two distinct stub signed URLs so the S3
 * PUT route handler can decide per-URL whether to fulfill 200 or 500.
 *
 * Run:
 *   pnpm --filter web e2e tests/create-story-partial-upload-failure.spec.ts
 */

import { expect, type Page, type Route, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Constants — fake but URL-shaped IDs (the test never hits a real DB).
// ---------------------------------------------------------------------------

const PROJECT_ID = "test-create-story-project-id";
const NEW_STORY_ID = "test-create-story-new-id";
const STATUS_ID = "test-create-story-status-id";

const OK_FILENAME = "ok.png";
const BROKEN_FILENAME = "broken.png";

// Two distinct S3 keys + signed URLs — one will 200, the other 500. The
// `createMediaUploadUrl` mock picks per-filename, and the S3 PUT route
// handlers match the URL path to decide the status.
const STUB_OK_S3_KEY = `story-media/${PROJECT_ID}/${NEW_STORY_ID}/stub-attachment-${OK_FILENAME}`;
const STUB_BROKEN_S3_KEY = `story-media/${PROJECT_ID}/${NEW_STORY_ID}/stub-attachment-${BROKEN_FILENAME}`;
const STUB_OK_UPLOAD_URL = "https://stub-bucket.local/upload?signed=ok";
const STUB_FAILING_UPLOAD_URL =
	"https://stub-bucket.local/upload?signed=broken";

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
	uploadUrlFilenames: string[];
	s3PutOkCalls: number;
	s3PutFailCalls: number;
	updateCalls: number;
	lastUpdateInput: {
		storyId?: string;
		description?: string;
		projectId?: string;
	} | null;
}

function makeState(): MockState {
	return {
		createCalls: 0,
		uploadUrlCalls: 0,
		uploadUrlFilenames: [],
		s3PutOkCalls: 0,
		s3PutFailCalls: 0,
		updateCalls: 0,
		lastUpdateInput: null,
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

	// ----- Signed-URL handout: per-filename routing -----
	// `ok.png` → STUB_OK_UPLOAD_URL (S3 PUT 200)
	// `broken.png` → STUB_FAILING_UPLOAD_URL (S3 PUT 500)
	await page.route(
		"**/api/rpc/projects/stories/createMediaUploadUrl**",
		async (route) => {
			state.uploadUrlCalls += 1;
			const input = unwrapOrpcInput<{
				filename?: string;
				projectId?: string;
				userStoryId?: string;
			}>(route.request().postDataJSON());
			const filename = input?.filename ?? "";
			state.uploadUrlFilenames.push(filename);

			const isBroken = filename === BROKEN_FILENAME;
			await fulfillJson(route, {
				signedUploadUrl: isBroken
					? STUB_FAILING_UPLOAD_URL
					: STUB_OK_UPLOAD_URL,
				s3Key: isBroken ? STUB_BROKEN_S3_KEY : STUB_OK_S3_KEY,
				useServerUpload: false,
				storageProvider: "mock",
			});
		},
	);

	// ----- S3 PUT stubs: distinct URLs → distinct statuses -----
	await page.route(`${STUB_OK_UPLOAD_URL}*`, async (route) => {
		state.s3PutOkCalls += 1;
		await route.fulfill({ status: 200, body: "" });
	});
	await page.route(`${STUB_FAILING_UPLOAD_URL}*`, async (route) => {
		state.s3PutFailCalls += 1;
		await route.fulfill({ status: 500, body: "upload failed" });
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
// Drop TWO synthesised PNG `File`s onto the AttachmentsField dropzone in a
// single drop event via a real DataTransfer instance built inside the page
// context.
// ---------------------------------------------------------------------------

async function dropTwoPngsOnDropzone(
	page: Page,
	files: Array<{ name: string; bytes: number[] }>,
): Promise<void> {
	const dropzone = page.getByTestId("attachments-field-dropzone");
	await dropzone.waitFor({ state: "visible" });

	const dataTransfer = await page.evaluateHandle((items) => {
		const dt = new DataTransfer();
		for (const { name, bytes } of items) {
			const file = new File([new Uint8Array(bytes)], name, {
				type: "image/png",
			});
			dt.items.add(file);
		}
		return dt;
	}, files);

	await dropzone.dispatchEvent("drop", { dataTransfer });
}

// ---------------------------------------------------------------------------
// Test.
// ---------------------------------------------------------------------------

test.describe("CreateStoryDialog — partial upload failure", () => {
	test("one of two uploads fails → patch contains only the success, toast warns", async ({
		page,
	}) => {
		const state = makeState();
		await installMocks(page, state);
		await seedActiveTab(page);

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

		const dialog = page.getByRole("dialog");
		await dialog.waitFor({ state: "visible" });

		// Fill description and drop BOTH images in a single drop event.
		const description = page.getByLabel(/What's this about\?/i);
		await description.fill(
			"Two attachments — one will succeed, one will fail.",
		);

		await dropTwoPngsOnDropzone(page, [
			{ name: OK_FILENAME, bytes: MINIMAL_PNG_BYTES },
			{ name: BROKEN_FILENAME, bytes: MINIMAL_PNG_BYTES },
		]);

		// Click Create — triggers create → 2 uploads (1 ok, 1 fail) → update.
		const createButton = dialog.getByRole("button", { name: /^Create$/i });
		await expect(createButton).toBeEnabled();

		const updatePromise = page.waitForResponse(
			(r) =>
				r.url().includes("/api/rpc/projects/stories/update") &&
				r.status() === 200,
			{ timeout: 25_000 },
		);
		const createPromise = page.waitForResponse(
			(r) =>
				r.url().includes("/api/rpc/projects/stories/create") &&
				r.status() === 200,
		);

		await createButton.click();

		await createPromise;
		await updatePromise;

		// ---- Assertions: call counts + payload contents ----

		// (1) Exactly one create + exactly one update. Two signed-URL handouts
		// (one per file). Two S3 PUTs — one 200, one 500.
		expect(state.createCalls).toBe(1);
		expect(state.updateCalls).toBe(1);
		expect(state.uploadUrlCalls).toBe(2);
		expect(state.uploadUrlFilenames).toEqual(
			expect.arrayContaining([OK_FILENAME, BROKEN_FILENAME]),
		);
		expect(state.s3PutOkCalls).toBe(1);
		expect(state.s3PutFailCalls).toBe(1);

		// (2) The patched description must reference the OK s3Key but NOT the
		// failed one — proves the partial-failure branch filtered correctly.
		expect(state.lastUpdateInput).not.toBeNull();
		expect(state.lastUpdateInput?.storyId).toBe(NEW_STORY_ID);
		expect(state.lastUpdateInput?.projectId).toBe(PROJECT_ID);
		const desc = state.lastUpdateInput?.description ?? "";
		expect(desc).toContain("## Attachments");
		expect(desc).toContain(STUB_OK_S3_KEY);
		expect(desc).not.toContain(STUB_BROKEN_S3_KEY);

		// (3) Warning toast appears (Sonner): "1 of 2 attachments uploaded…".
		await expect(
			page.getByText(/1 of 2 attachments uploaded/i).first(),
		).toBeVisible({ timeout: 10_000 });

		// (4) Dialog closes once the patch lands (same ordering contract as
		// the happy-path test — closeDialog runs AFTER updateStoryMutateAsync).
		await expect(dialog).toBeHidden({ timeout: 10_000 });
	});
});
