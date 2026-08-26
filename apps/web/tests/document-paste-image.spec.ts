/**
 * Documents — paste-image regression lock (Group 4 / T-4.1).
 *
 * What this guards:
 *   The Documents surface is the ONE TipTap surface that already supports
 *   pasting / dropping image files (see DocumentEditor.tsx:850-895 and the
 *   `imageUploadRef` plumbing at 767-770). The "paste-image-everywhere" PR
 *   intentionally does NOT touch Documents — it only extends the same
 *   capability to Features / Nexus / Loom and refactors a shared hook around
 *   it. This spec locks the Documents behavior in so a future refactor of the
 *   shared hook (or a casual edit to `editorProps`) cannot silently break the
 *   one path that already works in production.
 *
 * What it asserts (the chain — every link must hold):
 *   1. Synthesised `ClipboardEvent` with a real PNG triggers the editor's
 *      `handlePaste` and routes to the S3-upload pipeline (NOT TipTap's
 *      default base64 inline behavior).
 *   2. `projects.documents.createMediaUploadUrl` is called → proves the paste
 *      handler intercepted the binary image and asked the server for a key.
 *   3. The signed-URL S3 PUT happens → proves the upload pipeline ran.
 *   4. `projects.documents.resolveMediaUrls` is called to swap the s3 key
 *      for a renderable signed URL → proves the placeholder→image swap.
 *   5. The image node lands in the editor with a `data-s3-key` attribute
 *      (the marker the server-side code uses to identify uploaded media).
 *   6. Autosave fires (`projects.documents.update`) with content containing
 *      the `data-s3-key` and NO base64 `data:image/...` payload.
 *   7. After a hard reload, `documents/get` returns the persisted content,
 *      `resolveMediaUrls` is called again on mount, and the image renders
 *      with the same `data-s3-key`.
 *
 * Determinism:
 *   - Every backend call is intercepted via `page.route` and answered from a
 *     shared in-memory store. No real DB / S3 contact, no flaky network.
 *   - All `waitFor*` waits target named requests/responses, never a fixed
 *     timer (except the deliberate ~10 s autosave-debounce wait, for which
 *     we still wait on the response, not on the clock).
 *   - The PNG is materialised inside the page via `Uint8Array` so the
 *     synthetic `File` is byte-accurate.
 *
 * Run:
 *   pnpm --filter web e2e tests/document-paste-image.spec.ts
 */

import { expect, type Page, type Route, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Constants — fake but URL-shaped IDs (the test never hits real DB).
// ---------------------------------------------------------------------------

const PROJECT_ID = "test-paste-project-id";
const DOCUMENT_ID = "test-paste-document-id";
const INITIAL_CONTENT = "# Paste Regression\n\nInitial document body.\n";

/**
 * S3 key the server "issues" for the pasted image. Stable so we can assert on
 * it after the round-trip without mining it out of a request body.
 */
const STUB_S3_KEY = `document-media/${PROJECT_ID}/${DOCUMENT_ID}/stub-paste-image.png`;

/**
 * The mocked signed upload URL. Routed below so the XHR PUT inside
 * `uploadToS3` resolves to a 200 deterministically.
 */
const STUB_SIGNED_UPLOAD_URL = "https://stub-bucket.local/upload?signed=1";

/**
 * The mocked signed download URL the editor renders. The path MUST contain
 * `/document-media/` because DocumentEditor's reload-time resolver effect
 * only scans `img[src]` whose URL matches `/(document-media\/[^?"]+)/` — that
 * is the exact regex production S3 presigned URLs satisfy (the key is in the
 * path, query string carries the signature). If we used a path without
 * `document-media/`, the post-reload `resolveMediaUrls` call would never
 * fire and step (7) of the regression chain would silently pass for the
 * wrong reason. See `DocumentEditor.tsx:1724`.
 */
const STUB_SIGNED_DOWNLOAD_URL = `https://stub-bucket.local/${STUB_S3_KEY}?signed=1`;

/**
 * Smallest valid PNG: 1×1 transparent pixel, 68 bytes. Bytes are checked
 * client-side (`file.type.startsWith("image/")`) and used to reach
 * `validateImageFile` → `compressImage` → `uploadToS3`. Compression treats
 * files ≤ MAX_FILE_SIZE/2 as pass-through, so this 68-byte buffer is sent
 * verbatim. Source: PngSuite-style minimal PNG.
 */
const MINIMAL_PNG_BYTES = [
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
	0x0b, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60, 0x00, 0x02, 0x00,
	0x00, 0x05, 0x00, 0x01, 0xe2, 0x26, 0x05, 0x9b, 0x00, 0x00, 0x00, 0x00,
	0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

// ---------------------------------------------------------------------------
// oRPC wire helpers — match the format the production RPCLink encodes.
// ---------------------------------------------------------------------------

/** Wrap a payload as the oRPC RPCLink JSON envelope: `{ json: <payload> }`. */
function orpcJsonResponse(payload: unknown): string {
	return JSON.stringify({ json: payload });
}

/** Strip the `{ json: <payload> }` envelope from an inbound request body. */
function unwrapOrpcInput<T>(body: unknown): T {
	if (body && typeof body === "object" && "json" in body) {
		return (body as { json: T }).json;
	}
	return body as T;
}

// ---------------------------------------------------------------------------
// Project / document fixtures shaped like the real API responses.
// ---------------------------------------------------------------------------

function buildProjectPayload() {
	const now = new Date().toISOString();
	return {
		project: {
			id: PROJECT_ID,
			name: "Paste Regression Project",
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

function buildDocumentPayload(content: string) {
	const now = new Date().toISOString();
	return {
		document: {
			id: DOCUMENT_ID,
			projectId: PROJECT_ID,
			type: "PRD",
			title: "Paste Regression Document",
			content,
			status: "DRAFT",
			version: 1,
			pendingRegeneration: false,
			isActive: true,
			lastEditedBy: "test-user-id",
			isLocked: false,
			lockedAt: null,
			lockedBy: null,
			deletedAt: null,
			createdAt: now,
			updatedAt: now,
			project: {
				id: PROJECT_ID,
				name: "Paste Regression Project",
				userId: "test-user-id",
				organizationId: null,
			},
			versions: [],
		},
	};
}

// ---------------------------------------------------------------------------
// Fulfilment helpers — keep route handlers terse and self-explanatory.
// ---------------------------------------------------------------------------

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
// Mock installer — wires every endpoint the editor touches.
// ---------------------------------------------------------------------------

interface MockState {
	/** Server-side document content the next `documents/get` returns. */
	currentContent: string;
	/** Number of times `createMediaUploadUrl` was hit (asserted post-paste). */
	uploadUrlCalls: number;
	/** Number of times `resolveMediaUrls` was hit (asserted on mount + reload). */
	resolveCalls: number;
	/** Number of times the S3 PUT was hit (asserted post-paste). */
	s3PutCalls: number;
	/** Number of times `documents/update` was hit (autosave indicator). */
	updateCalls: number;
	/** Last content the autosave persisted (asserted contains `data-s3-key`). */
	lastSavedContent: string | null;
}

async function installDocumentMocks(
	page: Page,
	state: MockState,
): Promise<void> {
	// --- Project & document reads -------------------------------------------
	await page.route("**/api/rpc/projects/get**", async (route) => {
		await fulfillJson(route, buildProjectPayload());
	});

	await page.route("**/api/rpc/projects/documents/get**", async (route) => {
		await fulfillJson(route, buildDocumentPayload(state.currentContent));
	});

	// --- Non-blocking ancillary queries the editor fires on mount ----------
	// The editor's render isn't gated on these, but they fire on mount and
	// are noisy in the test report when they 404 against the fake projectId.
	// Stub them as empty so the network log stays clean.
	await page.route(
		"**/api/rpc/projects/documents/listAssets**",
		async (route) => fulfillJson(route, { assets: [] }),
	);
	await page.route(
		"**/api/rpc/projects/documents/versions/list**",
		async (route) => fulfillJson(route, { versions: [] }),
	);
	await page.route("**/api/rpc/projects/ragSettings/get**", async (route) =>
		fulfillJson(route, { ragSettings: null }),
	);
	await page.route(
		"**/api/rpc/integrations/teams/getRecentMessages**",
		async (route) => fulfillJson(route, { messages: [] }),
	);
	await page.route(
		"**/api/rpc/integrations/slack/getRecentMessages**",
		async (route) => fulfillJson(route, { messages: [] }),
	);
	await page.route(
		"**/api/rpc/projects/meetingTranscriptSync/getContext**",
		async (route) => fulfillEmpty(route),
	);

	// --- Image-upload pipeline ---------------------------------------------
	await page.route(
		"**/api/rpc/projects/documents/createMediaUploadUrl**",
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

	// XHR PUT to the (mocked) S3 endpoint. `uploadToS3` checks
	// 200 ≤ status < 300 and has no body assertions — an empty 200 is enough.
	await page.route(`${STUB_SIGNED_UPLOAD_URL}*`, async (route) => {
		state.s3PutCalls += 1;
		await route.fulfill({ status: 200, body: "" });
	});

	await page.route(
		"**/api/rpc/projects/documents/resolveMediaUrls**",
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

	// Pre-empt the actual <img src="https://stub-bucket.local/..."> fetch so
	// the test doesn't hit a real (404) host. A 1×1 PNG keeps the browser's
	// image decoder happy if anything inspects `naturalWidth` later. We
	// match by hostname + key prefix (the query string carries the
	// "signature" and varies, so we glob it).
	const PNG_BYTES = Buffer.from(MINIMAL_PNG_BYTES);
	await page.route(
		"https://stub-bucket.local/document-media/**",
		async (route) => {
			await route.fulfill({
				status: 200,
				contentType: "image/png",
				body: PNG_BYTES,
			});
		},
	);

	// --- Autosave path ------------------------------------------------------
	await page.route(
		"**/api/rpc/projects/documents/update**",
		async (route) => {
			state.updateCalls += 1;
			const input = unwrapOrpcInput<{ content?: string }>(
				route.request().postDataJSON(),
			);
			if (typeof input.content === "string") {
				state.lastSavedContent = input.content;
				state.currentContent = input.content;
			}
			await fulfillJson(route, {
				document: buildDocumentPayload(state.currentContent).document,
			});
		},
	);
}

// ---------------------------------------------------------------------------
// Synthetic clipboard paste — runs inside the browser context.
// ---------------------------------------------------------------------------

/**
 * Construct a real `File` from a byte array, pack it into a `DataTransfer`,
 * and dispatch a `ClipboardEvent('paste', { clipboardData })` on the editor's
 * ProseMirror DOM node. This is the same shape Chrome produces for a real
 * Cmd-V of an image — TipTap's `editorProps.handlePaste` reads
 * `event.clipboardData.files` exactly as it would for a user paste.
 */
async function pastePngIntoEditor(
	page: Page,
	bytes: number[],
	filename: string,
): Promise<void> {
	await page.evaluate(
		({ bytes, filename }) => {
			const editorEl = document.querySelector(".tiptap");
			if (!editorEl) {
				throw new Error(
					"[document-paste-image] .tiptap editor element not found",
				);
			}
			const arr = new Uint8Array(bytes);
			const file = new File([arr], filename, { type: "image/png" });
			const dt = new DataTransfer();
			dt.items.add(file);
			const event = new ClipboardEvent("paste", {
				clipboardData: dt,
				bubbles: true,
				cancelable: true,
			});
			editorEl.dispatchEvent(event);
		},
		{ bytes, filename },
	);
}

// ---------------------------------------------------------------------------
// The spec.
// ---------------------------------------------------------------------------

test.describe("Documents — paste image (regression lock)", () => {
	test("paste flows through S3 pipeline, autosaves with data-s3-key, and round-trips on reload", async ({
		page,
	}) => {
		// Slack the timeout: the editor's autosave debounces 10 s after the
		// `insertContent` from the upload pipeline. We still `waitForResponse`
		// on `update` (no fixed sleep), but the budget needs headroom.
		test.setTimeout(60_000);

		const state: MockState = {
			currentContent: INITIAL_CONTENT,
			uploadUrlCalls: 0,
			resolveCalls: 0,
			s3PutCalls: 0,
			updateCalls: 0,
			lastSavedContent: null,
		};

		await installDocumentMocks(page, state);

		// Navigate to the editor (personal context — no org slug).
		const editorPath = `/app/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}`;
		await page.goto(editorPath);

		// The editor element is what TipTap renders the .tiptap class onto. We
		// rely on its visibility (not networkidle) because CopilotKit keeps a
		// background EventSource open and "networkidle" never settles.
		const editor = page.locator(".tiptap").first();
		await editor.waitFor({ state: "visible", timeout: 20_000 });
		// Give TipTap one extra microtask to wire `imageUploadRef.current`
		// before we synthesise the paste — see DocumentEditor.tsx:1839.
		await expect
			.poll(
				async () =>
					page.evaluate(() => !!document.querySelector(".tiptap")),
				{ timeout: 5_000 },
			)
			.toBe(true);

		// --- (1) Paste a small PNG ------------------------------------------
		// Race-free chain: arm the network waiters BEFORE dispatching paste.
		const uploadUrlResponsePromise = page.waitForResponse(
			(r) =>
				r
					.url()
					.includes(
						"/api/rpc/projects/documents/createMediaUploadUrl",
					) && r.status() === 200,
			{ timeout: 15_000 },
		);
		const s3PutResponsePromise = page.waitForResponse(
			(r) =>
				r.url().startsWith(STUB_SIGNED_UPLOAD_URL) &&
				r.request().method() === "PUT" &&
				r.status() === 200,
			{ timeout: 15_000 },
		);

		await pastePngIntoEditor(page, MINIMAL_PNG_BYTES, "regression.png");

		// --- (2) Upload-URL request fires (paste handler intercepted) ------
		await uploadUrlResponsePromise;
		expect(state.uploadUrlCalls).toBeGreaterThanOrEqual(1);

		// --- (3) S3 PUT happens (upload pipeline ran) ----------------------
		await s3PutResponsePromise;
		expect(state.s3PutCalls).toBeGreaterThanOrEqual(1);

		// --- (4) Image node materialises in the editor with data-s3-key ----
		const insertedImage = page.locator(
			`.tiptap img[data-s3-key="${STUB_S3_KEY}"]`,
		);
		await expect(insertedImage).toBeVisible({ timeout: 10_000 });
		// `resolveMediaUrls` was called inside handleImageUpload too — so the
		// editor's <img src> points at the signed download URL, not base64.
		await expect(insertedImage).toHaveAttribute(
			"src",
			STUB_SIGNED_DOWNLOAD_URL,
		);
		expect(state.resolveCalls).toBeGreaterThanOrEqual(1);

		// --- (5) Autosave fires within the debounce window -----------------
		// The editor schedules an autosave 10 s after insertContent fires
		// onUpdate (DocumentEditor.tsx:1006). We wait on the response, not
		// on a wall clock, so the assertion is timing-tolerant.
		const updateResponse = await page.waitForResponse(
			(r) =>
				r.url().includes("/api/rpc/projects/documents/update") &&
				r.status() === 200,
			{ timeout: 25_000 },
		);
		expect(updateResponse.status()).toBe(200);
		expect(state.updateCalls).toBeGreaterThanOrEqual(1);

		// --- (6) Persisted content references the s3 key, not base64 -------
		expect(state.lastSavedContent).not.toBeNull();
		const saved = state.lastSavedContent ?? "";
		expect(saved).toContain(`data-s3-key="${STUB_S3_KEY}"`);
		// Hard guarantee: nothing about this image is inlined as base64. This
		// is the whole reason the paste handler exists — TipTap's default
		// would have written `<img src="data:image/png;base64,...">`.
		expect(saved).not.toMatch(/data:image\/[a-z0-9+]+;base64,/i);

		// --- (7) Reload — persisted content round-trips via the resolver ---
		const resolveBefore = state.resolveCalls;
		await page.reload();
		await editor.waitFor({ state: "visible", timeout: 20_000 });

		// On reload the editor's mount effect calls resolveMediaUrls for any
		// img[src] containing a `document-media/` key (DocumentEditor.tsx:1717).
		await expect
			.poll(() => state.resolveCalls, { timeout: 10_000 })
			.toBeGreaterThan(resolveBefore);

		// And the saved image is back in the editor with the same s3 key.
		const reloadedImage = page.locator(
			`.tiptap img[data-s3-key="${STUB_S3_KEY}"]`,
		);
		await expect(reloadedImage).toBeVisible({ timeout: 10_000 });
		await expect(reloadedImage).toHaveAttribute(
			"src",
			STUB_SIGNED_DOWNLOAD_URL,
		);
	});
});
