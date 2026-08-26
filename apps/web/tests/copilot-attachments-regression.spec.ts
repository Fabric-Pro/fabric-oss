/**
 * Copilot attachments regression — existing surfaces still work
 * (Group 5 / Task 5.8).
 *
 * Spec: `.claude/specs/2026-05-02-ai-feature-assistant-attachments/spec.md`
 *   - Spec §2 / §10 step 5: "E2E regression: Nexus paperclip still works;
 *     Loom paste-image still works; DocumentEditor and DocumentGeneratorEditor
 *     paperclip still work."
 *
 * Why this spec exists:
 *   The AI Feature Assistant work extends the shared `createCopilotSidebarInput`
 *   factory and the `useCopilotDocumentUpload` hook. Spec §2 is explicit: every
 *   change lands in the shared module, no per-surface forks. This spec locks
 *   the four other consumers in so any future refactor of the factory cannot
 *   silently regress the production paperclip / paste paths that were already
 *   shipping.
 *
 * What this spec does NOT do:
 *   - It does not re-prove the upload-pipeline assertions (those live on each
 *     surface's own spec file, e.g. `document-paste-image.spec.ts` for
 *     Documents). It only proves the wrappers still mount, the paperclip is
 *     visible and accessible, and a `setInputFiles` produces a chip. That is
 *     the minimal smoke surface for "no regression".
 *
 * Selectors:
 *   Per `fabric/standards/testing/test-writing.md`, primary queries are
 *   accessible (`getByRole`, `getByLabel`, `getByText`). Each surface's
 *   accessible name comes from its own component (see comments per `describe`).
 *
 * Runtime note (2026-05-02):
 *   The Aspire stack is not running in the authoring session — these specs are
 *   written for runtime verification deferred to Group 6.4 (the user runs
 *   `pnpm --filter web e2e tests/copilot-attachments-regression.spec.ts`
 *   after starting the local Aspire stack and the dev server). Backend RPC
 *   calls are mocked via `page.route` for determinism.
 */

import * as path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Shared constants and helpers.
// ---------------------------------------------------------------------------

const PROJECT_ID = "test-regression-project-id";
const DOCUMENT_ID = "test-regression-document-id";

const PDF_FIXTURE = path.join(__dirname, "fixtures", "sample.pdf");
const PNG_FIXTURE = path.join(__dirname, "fixtures", "sample.png");
/**
 * Real two-sheet workbook — see `fixtures/README.md`. A stub would not do: the
 * shared hook classifies a `.xlsx` by its leading bytes before creating a chip,
 * so only a genuine zip container reaches the chip path.
 */
const XLSX_FIXTURE = path.join(__dirname, "fixtures", "sample.xlsx");

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

/**
 * Minimal upload-pipeline mocks — every surface that consumes
 * `useCopilotDocumentUpload` (DocumentEditor / DocumentGeneratorEditor / Nexus)
 * funnels through the same four oRPC procedures. Stubbing them once here
 * keeps the per-surface tests focused on selector-level smoke assertions.
 */
async function installAiDocumentUploadMocks(page: Page): Promise<void> {
	await page.route(
		"**/api/rpc/ai/documents/createUploadUrl**",
		async (route) => {
			await fulfillJson(route, {
				documentId: "test-doc-id",
				signedUploadUrl: "https://stub-bucket.local/upload?signed=1",
				useServerUpload: false,
				chatId: "test-chat-id",
				s3Key: "chat-documents/test-chat-id/test-doc-id/sample",
				storageProvider: "stub",
			});
		},
	);
	await page.route("https://stub-bucket.local/upload*", async (route) =>
		route.fulfill({ status: 200, body: "" }),
	);
	await page.route("**/api/rpc/ai/documents/process**", (route) =>
		fulfillJson(route, { status: "PROCESSING" }),
	);
	await page.route("**/api/rpc/ai/documents/getStatus**", (route) =>
		fulfillJson(route, { status: "READY" }),
	);
	await page.route("**/api/rpc/ai/documents/getContent**", (route) =>
		fulfillJson(route, { content: "Stubbed extracted content." }),
	);
	// CopilotKit AG-UI runtime — kept inert so the React tree mounts.
	await page.route("**/api/copilotkit**", (route) =>
		route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({}),
		}),
	);
}

function buildProjectPayload(name: string) {
	const now = new Date().toISOString();
	return {
		project: {
			id: PROJECT_ID,
			name,
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

function buildDocumentPayload() {
	const now = new Date().toISOString();
	return {
		document: {
			id: DOCUMENT_ID,
			projectId: PROJECT_ID,
			type: "PRD",
			title: "Regression Document",
			content: "# Regression\n\nBaseline content.\n",
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
				name: "Regression Project",
				userId: "test-user-id",
				organizationId: null,
			},
			versions: [],
		},
	};
}

function copilotInputWrapper(page: Page) {
	return page.locator(".copilot-sidebar-input-wrapper");
}

function attachmentChipFor(page: Page, fileName: string) {
	return copilotInputWrapper(page)
		.locator(`div:has(> span:text-is("${fileName}"))`)
		.first();
}

// ---------------------------------------------------------------------------
// DocumentEditor — paperclip still attaches a file (`surface: "document"`).
// ---------------------------------------------------------------------------

/** Document-page reads the DocumentEditor fires on mount. */
async function installDocumentEditorReads(page: Page): Promise<void> {
	await page.route("**/api/rpc/projects/get**", (route) =>
		fulfillJson(route, buildProjectPayload("Regression Project")),
	);
	await page.route("**/api/rpc/projects/documents/get**", (route) =>
		fulfillJson(route, buildDocumentPayload()),
	);
	await page.route("**/api/rpc/projects/documents/listAssets**", (route) =>
		fulfillJson(route, { assets: [] }),
	);
	await page.route("**/api/rpc/projects/documents/versions/list**", (route) =>
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
}

test.describe("DocumentEditor — paperclip regression", () => {
	test("paperclip attaches a PDF and the chip appears", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(60_000);

		await installAiDocumentUploadMocks(page);
		await installDocumentEditorReads(page);

		await page.goto(`/app/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}`);

		// The DocumentEditor mounts the shared factory with `surface: "document"`
		// (DocumentEditor.tsx:730), so the same accessible names apply.
		await expect(copilotInputWrapper(page)).toBeVisible({
			timeout: 20_000,
		});
		await expect(
			page.getByRole("button", { name: /Attach a file/i }),
		).toBeVisible();

		const fileInput =
			copilotInputWrapper(page).locator('input[type="file"]');
		await fileInput.setInputFiles(PDF_FIXTURE);

		// Smoke: chip with the filename appears. The point of this regression
		// spec is the chip lifecycle and upload pipeline are NOT separately
		// validated here (that lives in `document-paste-image.spec.ts`); we
		// only need to know the factory still wires `addFiles → chip`.
		await expect(attachmentChipFor(page, "sample.pdf")).toBeVisible({
			timeout: 10_000,
		});

		// The picker advertises the formats the shared vocabulary admits.
		// Asserted here because the accept string is now COMPOSED from that
		// vocabulary (`buildAiChatAcceptAttribute`) rather than hardcoded — a
		// surface silently losing a format is exactly what this regression spec
		// exists to catch. Membership only: the ordering is incidental.
		const accept = await fileInput.getAttribute("accept");
		expect(accept).toContain(".pdf");
		expect(accept).toContain(".docx");
		expect(accept).toContain(".xlsx");
		expect(accept).toContain(
			"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
		);
	});

	// Excel rides the same shared hook as every other binary document, so the
	// workbook path must work on the document surfaces too — not only on the AI
	// Feature Assistant that motivated it. Chip-only smoke, in keeping with the
	// rest of this file; the end-to-end workbook flow is asserted in
	// `ai-feature-assistant-attachments.spec.ts`.
	test("paperclip attaches a multi-sheet XLSX and the chip appears", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(60_000);

		await installAiDocumentUploadMocks(page);
		await installDocumentEditorReads(page);

		await page.goto(`/app/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}`);

		await expect(copilotInputWrapper(page)).toBeVisible({
			timeout: 20_000,
		});

		const fileInput =
			copilotInputWrapper(page).locator('input[type="file"]');
		await fileInput.setInputFiles(XLSX_FIXTURE);

		// A chip exists only if the hook read the real `PK` signature off the
		// fixture and accepted it.
		await expect(attachmentChipFor(page, "sample.xlsx")).toBeVisible({
			timeout: 10_000,
		});
	});
});

// ---------------------------------------------------------------------------
// DocumentGeneratorEditor — paperclip still attaches a file
// (`surface: "document-generator"`).
// ---------------------------------------------------------------------------

test.describe("DocumentGeneratorEditor — paperclip regression", () => {
	test("paperclip attaches a PDF and the chip appears", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(60_000);

		await installAiDocumentUploadMocks(page);

		// The agents/document-generator page does not need the
		// projects/documents fixtures — it stands alone with the CopilotKit
		// provider inside the page (see `apps/web/app/(saas)/app/agents/document-generator/page.tsx`).

		await page.goto("/app/agents/document-generator");

		await expect(copilotInputWrapper(page)).toBeVisible({
			timeout: 20_000,
		});
		await expect(
			page.getByRole("button", { name: /Attach a file/i }),
		).toBeVisible();

		const fileInput =
			copilotInputWrapper(page).locator('input[type="file"]');
		await fileInput.setInputFiles(PDF_FIXTURE);

		await expect(attachmentChipFor(page, "sample.pdf")).toBeVisible({
			timeout: 10_000,
		});
	});
});

// ---------------------------------------------------------------------------
// Nexus — paperclip still uploads.
//
// Nexus does NOT use `createCopilotSidebarInput` (it owns its own
// `<CopilotPage>` with a bespoke `PaperclipIcon` button + file input) — but
// it consumes the same `ai.documents.*` upload pipeline that the shared hook
// uses. We assert the `aria-label="Attach file"` button is visible and a
// `setInputFiles` produces the visible "pending file" chip strip Nexus
// renders below its textarea (per `CopilotPage.tsx:2185`).
// ---------------------------------------------------------------------------

test.describe("Nexus — paperclip regression", () => {
	test("paperclip is visible and accepts a file", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(60_000);

		await installAiDocumentUploadMocks(page);

		await page.goto("/app/nexus");

		// Nexus's paperclip carries a literal `aria-label="Attach file"`
		// (CopilotPage.tsx:2187) — distinct from the copilot factory's
		// "Attach a file (PDF, DOCX, …)" copy.
		const paperclip = page.getByRole("button", { name: /Attach file/i });
		await expect(paperclip).toBeVisible({ timeout: 30_000 });

		// Nexus renders its own hidden file input next to the button. We
		// accept any visible chip / pending-file pill that surfaces the
		// filename. The existing `pendingFiles` chip strip lives below the
		// textarea (CopilotPage.tsx:2150-2170).
		const fileInput = page.locator('input[type="file"][accept*=".pdf"]');
		await fileInput.first().setInputFiles(PDF_FIXTURE);

		// Soft assertion: Nexus surfaces the filename somewhere in the page
		// once the paperclip pipeline has queued the file. We do not bind
		// to Nexus's internal chip selectors because they are independent of
		// the copilot factory — this spec only needs to prove the paperclip
		// is reachable and ingests a file without a console-level regression.
		await expect(page.getByText("sample.pdf").first()).toBeVisible({
			timeout: 10_000,
		});
	});
});

// ---------------------------------------------------------------------------
// Loom (FabricChat / fabric-ai) — paste image still works.
//
// Loom's paperclip and paste flow live in
// `apps/web/modules/saas/agents/components/FabricChat/shared/ChatInput.tsx`
// — the paperclip there has no `aria-label` (just a `<Tooltip>`), so we
// reach the textarea by placeholder and assert that pasting an image fires
// the `useClipboardImagePaste` upload path.
//
// Loom's pipeline depends on a logged-in dev user with the fabric-ai agent
// initialised. If that fixture is not stable in the local Aspire dev env at
// test time, the user may flip this test to `test.skip` until the dev seed
// is available. Marked as a single-test describe so the surface is documented
// and trivially un-skippable later.
// ---------------------------------------------------------------------------

test.describe("Loom (fabric-ai) — paste-image regression", () => {
	test("pasting an image into the Loom chat input fires the upload pipeline", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(60_000);

		await installAiDocumentUploadMocks(page);

		// Track whether the paste path triggered an upload — Loom's
		// `useClipboardImagePaste` ultimately routes pasted images through
		// the same `ai.documents.createUploadUrl` procedure as the paperclip,
		// so a hit here proves the paste path is alive end-to-end.
		let createUploadUrlHits = 0;
		await page.route(
			"**/api/rpc/ai/documents/createUploadUrl**",
			async (route) => {
				createUploadUrlHits += 1;
				await fulfillJson(route, {
					documentId: "test-doc-id",
					signedUploadUrl:
						"https://stub-bucket.local/upload?signed=1",
					useServerUpload: false,
					chatId: "test-chat-id",
					s3Key: "chat-documents/test-chat-id/test-doc-id/loom.png",
					storageProvider: "stub",
				});
			},
		);

		await page.goto("/app/agents/fabric-ai");

		// Loom uses an unlabelled paperclip + a textarea with placeholder text
		// "Message Fabric AI…" or similar. Reach the textarea by the
		// placeholder and dispatch a synthetic paste with a real PNG `File`.
		const textarea = page
			.getByRole("textbox")
			.filter({ hasNotText: /search/i })
			.first();
		await textarea.waitFor({ state: "visible", timeout: 30_000 });

		await page.evaluate(
			({ bytes }) => {
				const ta = document.activeElement as HTMLTextAreaElement | null;
				const target =
					ta && ta.tagName === "TEXTAREA"
						? ta
						: document.querySelector<HTMLTextAreaElement>(
								"textarea",
							);
				if (!target) {
					throw new Error(
						"[loom-regression] textarea not found for paste",
					);
				}
				const file = new File(
					[new Uint8Array(bytes)],
					"loom-paste.png",
					{ type: "image/png" },
				);
				const dt = new DataTransfer();
				dt.items.add(file);
				const event = new ClipboardEvent("paste", {
					clipboardData: dt,
					bubbles: true,
					cancelable: true,
				});
				target.dispatchEvent(event);
			},
			{ bytes: MINIMAL_PNG_BYTES },
		);

		// Smoke: the upload-URL RPC is hit at least once after the paste —
		// proving `useClipboardImagePaste` still routes pastes to the upload
		// pipeline despite the shared-factory refactor.
		await expect
			.poll(() => createUploadUrlHits, { timeout: 15_000 })
			.toBeGreaterThanOrEqual(1);
	});
});
