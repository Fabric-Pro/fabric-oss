/**
 * StoryWorkspace — paste-image happy path (Group 5 / T-5.4).
 *
 * Locks in the NEW wiring added in this PR: pasting a PNG into the StoryWorkspace
 * TipTap editor uploads via `projects.stories.createMediaUploadUrl`, persists
 * via the description autosave, and re-renders via `projects.stories.resolveMediaUrls`
 * after reload. Also asserts the >5MB size toast (validates the friendly-error
 * surface — PR #692 lesson).
 *
 * Mirrors `document-paste-image.spec.ts` patterns: deterministic in-memory mock
 * state, oRPC envelope helpers, signed-URL S3 stub.
 *
 * Run:
 *   pnpm --filter web e2e tests/story-workspace-paste-image.spec.ts
 */

import { expect, type Page, type Route, test } from "@playwright/test";

const PROJECT_ID = "test-paste-project-id";
const STORY_ID = "test-paste-story-id";
const INITIAL_DESCRIPTION = "<p>Initial story description.</p>";

const STUB_S3_KEY = `story-media/${PROJECT_ID}/${STORY_ID}/stub-paste-image.png`;
const STUB_SIGNED_UPLOAD_URL = "https://stub-bucket.local/upload?signed=1";
// Path MUST contain `story-media/` so the resolver effect picks it up on reload.
const STUB_SIGNED_DOWNLOAD_URL = `https://stub-bucket.local/${STUB_S3_KEY}?signed=1`;

const MINIMAL_PNG_BYTES = [
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
	0x0b, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60, 0x00, 0x02, 0x00,
	0x00, 0x05, 0x00, 0x01, 0xe2, 0x26, 0x05, 0x9b, 0x00, 0x00, 0x00, 0x00,
	0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

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

function buildProjectPayload() {
	const now = new Date().toISOString();
	return {
		project: {
			id: PROJECT_ID,
			name: "Paste Story Project",
			description: null,
			status: "ACTIVE",
			projectType: "GENERAL",
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
		},
	};
}

function buildStoryPayload(description: string) {
	const now = new Date().toISOString();
	return {
		story: {
			id: STORY_ID,
			projectId: PROJECT_ID,
			title: "Paste Regression Story",
			description,
			acceptanceCriteria: "<p>Given/When/Then placeholder.</p>",
			status: "TODO",
			priority: "MEDIUM",
			size: "M",
			kind: "FEATURE",
			featureNumber: 1,
			draftingStage: null,
			version: 1,
			projectStoryStatusId: null,
			parentStoryId: null,
			isActive: true,
			deletedAt: null,
			createdAt: now,
			updatedAt: now,
			tasks: [],
			project: {
				id: PROJECT_ID,
				name: "Paste Story Project",
				userId: "test-user-id",
				organizationId: null,
			},
		},
	};
}

interface MockState {
	currentDescription: string;
	uploadUrlCalls: number;
	resolveCalls: number;
	s3PutCalls: number;
	updateCalls: number;
	lastSavedDescription: string | null;
}

async function installStoryMocks(page: Page, state: MockState): Promise<void> {
	await page.route("**/api/rpc/projects/get**", (route) =>
		fulfillJson(route, buildProjectPayload()),
	);

	await page.route("**/api/rpc/projects/stories/get**", (route) =>
		fulfillJson(route, buildStoryPayload(state.currentDescription)),
	);

	// Ancillary queries — non-blocking; stub empty.
	await page.route("**/api/rpc/projects/documents/list**", (route) =>
		fulfillJson(route, { documents: [] }),
	);
	await page.route("**/api/rpc/projects/stories/versions/list**", (route) =>
		fulfillJson(route, { versions: [] }),
	);
	await page.route("**/api/rpc/projects/ragSettings/get**", (route) =>
		fulfillJson(route, { ragSettings: null }),
	);
	await page.route(
		"**/api/rpc/integrations/teams/getRecentMessages**",
		(route) => fulfillJson(route, { messages: [] }),
	);
	await page.route(
		"**/api/rpc/integrations/slack/getRecentMessages**",
		(route) => fulfillJson(route, { messages: [] }),
	);
	await page.route(
		"**/api/rpc/projects/meetingTranscriptSync/getContext**",
		(route) => fulfillEmpty(route),
	);

	// Story media upload pipeline
	await page.route(
		"**/api/rpc/projects/stories/createMediaUploadUrl**",
		async (route) => {
			state.uploadUrlCalls += 1;
			await fulfillJson(route, {
				signedUploadUrl: STUB_SIGNED_UPLOAD_URL,
				s3Key: STUB_S3_KEY,
				useServerUpload: false,
				storageProvider: "stub",
			});
		},
	);

	await page.route(`${STUB_SIGNED_UPLOAD_URL}*`, async (route) => {
		state.s3PutCalls += 1;
		await route.fulfill({ status: 200, body: "" });
	});

	await page.route(
		"**/api/rpc/projects/stories/resolveMediaUrls**",
		async (route) => {
			state.resolveCalls += 1;
			const input = unwrapOrpcInput<{ s3Keys?: string[] }>(
				route.request().postDataJSON(),
			);
			const urls: Record<string, string> = {};
			for (const key of input?.s3Keys ?? []) {
				urls[key] = STUB_SIGNED_DOWNLOAD_URL;
			}
			await fulfillJson(route, { urls });
		},
	);

	// Autosave
	await page.route("**/api/rpc/projects/stories/update**", async (route) => {
		state.updateCalls += 1;
		const input = unwrapOrpcInput<{ description?: string }>(
			route.request().postDataJSON(),
		);
		if (typeof input?.description === "string") {
			state.lastSavedDescription = input.description;
			state.currentDescription = input.description;
		}
		await fulfillJson(route, buildStoryPayload(state.currentDescription));
	});
}

/**
 * Synthesise a clipboard `paste` event with a real PNG file against the
 * StoryWorkspace TipTap editor.
 */
async function pastePngIntoEditor(
	page: Page,
	bytes: number[],
	mime = "image/png",
	fileName = "paste.png",
): Promise<void> {
	await page.evaluate(
		({ bytes, mime, fileName }) => {
			const editor = document.querySelector(".tiptap");
			if (!editor) {
				throw new Error("TipTap editor not found");
			}
			const file = new File([new Uint8Array(bytes)], fileName, {
				type: mime,
			});
			const dt = new DataTransfer();
			dt.items.add(file);
			const event = new ClipboardEvent("paste", {
				clipboardData: dt,
				bubbles: true,
				cancelable: true,
			});
			editor.dispatchEvent(event);
		},
		{ bytes, mime, fileName },
	);
}

test.describe("StoryWorkspace — paste image", () => {
	test("paste PNG → uploads to story-media/ → autosaves → reload renders via resolver", async ({
		page,
	}) => {
		const state: MockState = {
			currentDescription: INITIAL_DESCRIPTION,
			uploadUrlCalls: 0,
			resolveCalls: 0,
			s3PutCalls: 0,
			updateCalls: 0,
			lastSavedDescription: null,
		};
		await installStoryMocks(page, state);

		await page.goto(`/app/projects/${PROJECT_ID}/stories/${STORY_ID}`);
		await page.locator(".tiptap").first().waitFor({ state: "visible" });

		// (1) Paste, (2) wait on upload-url, (3) wait on S3 PUT
		const uploadUrlPromise = page.waitForResponse(
			"**/api/rpc/projects/stories/createMediaUploadUrl**",
		);
		const s3PutPromise = page.waitForResponse(`${STUB_SIGNED_UPLOAD_URL}*`);
		await pastePngIntoEditor(page, MINIMAL_PNG_BYTES);
		await uploadUrlPromise;
		await s3PutPromise;

		expect(state.uploadUrlCalls).toBeGreaterThanOrEqual(1);
		expect(state.s3PutCalls).toBeGreaterThanOrEqual(1);

		// (4) Image lands in editor with data-s3-key marker
		const inserted = page.locator(
			`.tiptap img[data-s3-key="${STUB_S3_KEY}"]`,
		);
		await expect(inserted).toBeVisible({ timeout: 10_000 });
		await expect(inserted).toHaveAttribute("src", STUB_SIGNED_DOWNLOAD_URL);

		// (5) Autosave fires (the editor debounces; 25 s budget covers that)
		await page.waitForResponse(
			(response) =>
				response.url().includes("/api/rpc/projects/stories/update") &&
				response.status() === 200,
			{ timeout: 25_000 },
		);
		expect(state.lastSavedDescription).toBeTruthy();
		expect(state.lastSavedDescription).toContain(
			`data-s3-key="${STUB_S3_KEY}"`,
		);
		// Critical: never persist base64 inline — that's the regression we're locking out.
		expect(state.lastSavedDescription).not.toMatch(
			/data:image\/[a-z0-9+]+;base64,/i,
		);

		// (6) Reload — resolver must fire again on mount and image renders
		const resolveBefore = state.resolveCalls;
		await page.reload();
		await page.locator(".tiptap").first().waitFor({ state: "visible" });
		await expect
			.poll(() => state.resolveCalls, { timeout: 15_000 })
			.toBeGreaterThan(resolveBefore);
		await expect(
			page.locator(`.tiptap img[data-s3-key="${STUB_S3_KEY}"]`),
		).toBeVisible({ timeout: 10_000 });
	});

	test("pasting >5MB image triggers size toast and does NOT upload", async ({
		page,
	}) => {
		const state: MockState = {
			currentDescription: INITIAL_DESCRIPTION,
			uploadUrlCalls: 0,
			resolveCalls: 0,
			s3PutCalls: 0,
			updateCalls: 0,
			lastSavedDescription: null,
		};
		await installStoryMocks(page, state);

		await page.goto(`/app/projects/${PROJECT_ID}/stories/${STORY_ID}`);
		await page.locator(".tiptap").first().waitFor({ state: "visible" });

		// 6 MB of PNG-ish bytes — magic number is correct so MIME sniff passes,
		// the size guard rejects on byteLength.
		const oversizedBytes = [
			...MINIMAL_PNG_BYTES,
			...new Array(6 * 1024 * 1024).fill(0),
		];
		await pastePngIntoEditor(page, oversizedBytes, "image/png", "huge.png");

		// Toast copy from spec §7 / §8.6 — must match character-for-character.
		await expect(
			page.getByText(
				"Image is too large (max 5MB). Try compressing it first.",
			),
		).toBeVisible({ timeout: 10_000 });

		// No upload-url call should have fired.
		expect(state.uploadUrlCalls).toBe(0);
		expect(state.s3PutCalls).toBe(0);
	});
});
