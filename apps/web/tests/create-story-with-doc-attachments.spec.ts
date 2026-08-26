/**
 * CreateStoryDialog — happy-path with text-file (doc) attachments
 * (#1702 v1 — attach .docx/.md/.txt at feature creation).
 *
 * Locks in the deferred-upload flow for the FIRST-CLASS attachment pipeline
 * (distinct from the inline image path):
 *
 *   1. createStory                 (returns { story, aiGenerated })
 *   2. createAttachmentUploadUrl + S3 PUT (per file)  → temp key
 *   3. createAttachment            (persists a StoryAttachment row, designation)
 *   4. closeDialog                 — fires ONLY after uploads settle
 *
 * Unlike the image path, doc attachments are NEVER patched into the description
 * (they live as rows surfaced by listAttachments), so `stories/update` must NOT
 * fire. Detail-view surfacing is covered by the AttachmentsTab unit tests.
 *
 * Run:
 *   pnpm --filter web e2e tests/create-story-with-doc-attachments.spec.ts
 */

import { expect, type Page, type Route, test } from "@playwright/test";

const PROJECT_ID = "test-create-doc-project-id";
const NEW_STORY_ID = "test-create-doc-new-id";
const STATUS_ID = "test-create-doc-status-id";
const DOC_FILENAME = "spec.txt";

const STUB_TEMP_KEY = `story-attachments-tmp/${PROJECT_ID}/${NEW_STORY_ID}/stub-${DOC_FILENAME}`;
const STUB_SIGNED_UPLOAD_URL = "https://stub-bucket.local/attach?signed=1";

// ---------------------------------------------------------------------------
// oRPC envelope helpers.
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
			name: "Create Doc Project",
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
	createAttachmentCalls: number;
	capturedDesignation: string | undefined;
	capturedFilename: string | undefined;
	updateCalls: number;
	s3PutResolvedAt: number | null;
	createAttachmentResolvedAt: number | null;
}

function makeState(): MockState {
	return {
		createCalls: 0,
		uploadUrlCalls: 0,
		s3PutCalls: 0,
		createAttachmentCalls: 0,
		capturedDesignation: undefined,
		capturedFilename: undefined,
		updateCalls: 0,
		s3PutResolvedAt: null,
		createAttachmentResolvedAt: null,
	};
}

// ---------------------------------------------------------------------------
// Install oRPC + S3 mocks for the board + first-class attachment pipeline.
// ---------------------------------------------------------------------------

async function installMocks(page: Page, state: MockState): Promise<void> {
	await page.route("**/api/rpc/projects/get**", (route) =>
		fulfillJson(route, buildProjectPayload()),
	);
	await page.route("**/api/rpc/projects/stories/statuses/list**", (route) =>
		fulfillJson(route, buildStatusesPayload()),
	);
	await page.route("**/api/rpc/projects/stories/list**", (route) =>
		fulfillJson(route, { stories: [] }),
	);
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
	// listAttachments — empty on the board; the detail view would query it.
	await page.route("**/api/rpc/projects/stories/listAttachments**", (route) =>
		fulfillJson(route, { attachments: [] }),
	);

	// ----- Create-story mutation -----
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

	// ----- Presigned PUT handout (temp key) -----
	await page.route(
		"**/api/rpc/projects/stories/createAttachmentUploadUrl**",
		async (route) => {
			state.uploadUrlCalls += 1;
			await fulfillJson(route, {
				signedUploadUrl: STUB_SIGNED_UPLOAD_URL,
				storageKey: STUB_TEMP_KEY,
				contentType: "text/plain",
			});
		},
	);

	// ----- S3 PUT stub -----
	await page.route(`${STUB_SIGNED_UPLOAD_URL}*`, async (route) => {
		state.s3PutCalls += 1;
		state.s3PutResolvedAt = Date.now();
		await route.fulfill({ status: 200, body: "" });
	});

	// ----- Persist StoryAttachment row (captures designation) -----
	await page.route(
		"**/api/rpc/projects/stories/createAttachment**",
		async (route) => {
			state.createAttachmentCalls += 1;
			const input = unwrapOrpcInput<{
				designation?: string;
				filename?: string;
			}>(route.request().postDataJSON());
			state.capturedDesignation = input?.designation;
			state.capturedFilename = input?.filename;
			state.createAttachmentResolvedAt = Date.now();
			await fulfillJson(route, {
				attachment: {
					id: "att-1",
					filename: input?.filename ?? DOC_FILENAME,
					mimeType: "text/plain",
					sizeBytes: 12,
					designation: input?.designation ?? "LOCKED",
					createdAt: new Date().toISOString(),
				},
			});
		},
	);

	// Doc attachments must NEVER patch the description — fail loudly if they do.
	await page.route("**/api/rpc/projects/stories/update**", async (route) => {
		state.updateCalls += 1;
		await fulfillJson(route, {
			story: { id: NEW_STORY_ID, description: "" },
		});
	});
}

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
				// Storage may be unavailable — fall through to the tab click.
			}
		},
		{ projectId: PROJECT_ID },
	);
}

async function dropDocOnDropzone(page: Page, fileName: string): Promise<void> {
	const dropzone = page.getByTestId("doc-attachments-field-dropzone");
	await dropzone.waitFor({ state: "visible" });

	const dataTransfer = await page.evaluateHandle(
		({ fileName }) => {
			const dt = new DataTransfer();
			const file = new File(["hello world\n"], fileName, {
				type: "text/plain",
			});
			dt.items.add(file);
			return dt;
		},
		{ fileName },
	);

	await dropzone.dispatchEvent("drop", { dataTransfer });
}

// ---------------------------------------------------------------------------
// Test.
// ---------------------------------------------------------------------------

test.describe("CreateStoryDialog — happy path with doc attachments", () => {
	test("attach .txt → submit → create + presign + PUT + createAttachment, no description patch", async ({
		page,
	}) => {
		const state = makeState();
		await installMocks(page, state);
		await seedActiveTab(page);

		await page.goto(`/app/projects/${PROJECT_ID}`);

		const roadmapTab = page.getByRole("button", { name: /^Roadmap$/i });
		if (await roadmapTab.isVisible().catch(() => false)) {
			await roadmapTab.click();
		}

		const addButton = page.getByRole("button", { name: /^Add$/i }).first();
		await addButton.waitFor({ state: "visible", timeout: 20_000 });
		await addButton.click();

		const dialog = page.getByRole("dialog");
		await dialog.waitFor({ state: "visible" });

		const description = page.getByLabel(/What's this about\?/i);
		await description.fill("Attach the requirements doc.");

		await dropDocOnDropzone(page, DOC_FILENAME);

		const createButton = dialog.getByRole("button", { name: /^Create$/i });
		await expect(createButton).toBeEnabled();

		const createPromise = page.waitForResponse(
			(r) =>
				r.url().includes("/api/rpc/projects/stories/create") &&
				!r.url().includes("createAttachment") &&
				r.status() === 200,
		);
		const s3PutPromise = page.waitForResponse(`${STUB_SIGNED_UPLOAD_URL}*`);
		const createAttachmentPromise = page.waitForResponse(
			(r) =>
				r
					.url()
					.includes("/api/rpc/projects/stories/createAttachment") &&
				// exclude the presign call — its path contains "createAttachment"
				// as a substring, which would resolve this predicate early.
				!r.url().includes("createAttachmentUploadUrl") &&
				r.status() === 200,
		);

		await createButton.click();

		await createPromise;
		await s3PutPromise;
		await createAttachmentPromise;

		// (1) Pipeline legs fired as expected.
		expect(state.createCalls).toBe(1);
		expect(state.uploadUrlCalls).toBeGreaterThanOrEqual(1);
		expect(state.s3PutCalls).toBeGreaterThanOrEqual(1);
		expect(state.createAttachmentCalls).toBeGreaterThanOrEqual(1);

		// (2) createAttachment persisted with the default Context only (UNLOCKED)
		// designation and the picked filename.
		expect(state.capturedDesignation).toBe("UNLOCKED");
		expect(state.capturedFilename).toBe(DOC_FILENAME);

		// (3) Doc attachments never patch the description.
		expect(state.updateCalls).toBe(0);

		// (4) Ordering: createAttachment resolves after the S3 PUT.
		expect(state.s3PutResolvedAt).not.toBeNull();
		expect(state.createAttachmentResolvedAt).not.toBeNull();
		expect(
			state.createAttachmentResolvedAt as number,
		).toBeGreaterThanOrEqual(state.s3PutResolvedAt as number);

		// (5) Dialog closes only after the pipeline settles.
		await expect(dialog).toBeHidden({ timeout: 10_000 });
	});
});
