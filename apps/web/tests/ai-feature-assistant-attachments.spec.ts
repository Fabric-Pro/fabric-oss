/**
 * AI Feature Assistant — attachments E2E (Group 5 / Tasks 5.7 + 5.9).
 *
 * Spec: `.claude/specs/2026-05-02-ai-feature-assistant-attachments/spec.md`
 * AC mapping per spec §7:
 *   - AC-1 Upload (paperclip → file picker → chip)
 *   - AC-3 Paste image
 *   - AC-5 Visibility (chip status flow)
 *   - AC-6 Remove (X button before send)
 *   - AC-7 Use as context (outbound payload carries the rag-context envelope)
 *   - AC-9 Upload error (chip turns red, hover surfaces tooltip; no retry button per §1 Non-Goals)
 *
 * Also covers Excel attachment (plan 2026-07-16-001, U8): R1 / AE1 (a
 * multi-sheet workbook is read whole, with no sheet-selection prompt) and AE3
 * (a legacy `.xls` is refused at selection).
 *
 * What this spec locks in:
 *   - The factory wired into `<CopilotSidebar>` on StoryWorkspace (Task 2.1)
 *     surfaces the paperclip + chip + drop overlay.
 *   - Paste of a binary File payload routes through `addFiles()` → the chip
 *     status state machine (`pending → uploading → processing → ready`).
 *   - Attachment content reaches the agent over the rag-context channel as
 *     `[Uploaded Document: <name>]` / `[Uploaded Image: <name>]` entries inside
 *     a `<fabric_attachment>` wrapper — see the envelope note below.
 *   - Failed uploads surface as the error chip variant with an accessible
 *     tooltip — no retry affordance (out of scope per spec §1).
 *
 * Envelope note (2026-07-16, plan U8):
 *   This spec previously asserted an `<attached_documents>` /
 *   `<document_content filename="…">` wrapper around the user message. That
 *   wrapper was removed in PR #722 / #723 when attachment content moved to the
 *   rag-context channel, and the spec was never updated — so it asserted an
 *   envelope no source built, and a unit test
 *   (`CopilotSidebarInput.test.tsx`, "ships only the typed prompt to onSend")
 *   asserts its *absence*. The assertions below were repointed at what the code
 *   actually emits:
 *     - the user message carries the typed prompt plus a lightweight
 *       `[Attached: <name>]` hint (CopilotSidebarInput.tsx), and
 *     - the content rides `input.context` as
 *       `[Uploaded Document: <name>]\n<text>` entries, built by
 *       `buildAttachmentContextEntry` in `use-copilot-document-upload.ts` and
 *       pushed into the `rag context` readable by StoryWorkspace.
 *       It also rode `input.state.ragContexts` until Fizzy #2167: the agent
 *       reads only one of the two, and sending an image on both doubled the
 *       body past the platform's request-size cap. The assertions below are
 *       substring checks on the whole POST body, so single delivery satisfies
 *       them exactly as dual delivery did.
 *   Both live in the same POST body to `/api/copilotkit`, which is what the
 *   `outboundMessages` capture below inspects.
 *
 * Envelope note (2026-07-21, attachment parity plan U3):
 *   Those `[Uploaded …]` entries are now wrapped in a `<fabric_attachment>`
 *   tag, and occurrences of that tag — plus the prompt builder's own section
 *   headings and upload prefix — are neutralized inside the document body. The
 *   markdown envelope was forgeable: a file whose *text* carried a newline and
 *   a heading could invent an attachment section the model is told to trust.
 *
 *   The `not.toContain("<attached_documents>")` assertions below still hold and
 *   still matter, but for a sharper reason than when they were written. That
 *   tag was not merely obsolete: the document-generator system prompt went on
 *   instructing the model to treat such blocks as authoritative material long
 *   after anything stopped producing them, which left it reachable only by an
 *   attacker. The prompt no longer names any tag; these assertions pin that the
 *   producer does not resurrect this one.
 *
 *   The `toContain("[Uploaded Document: …]")` assertions are unchanged on
 *   purpose — the prefix still identifies the entry, it just sits one line
 *   inside the wrapper now.
 *
 * Selectors:
 *   Per `fabric/standards/testing/test-writing.md`, primary queries are
 *   `getByRole` / `getByLabel` / `getByText`. Tooltip text comes from the
 *   `tooltips.copilot.*` i18n keys (see `packages/i18n/translations/en.json`).
 *
 * Runtime note (2026-05-02):
 *   The Aspire stack is not running in the authoring session — these specs
 *   are written for runtime verification deferred to Group 6.4 (the user runs
 *   `pnpm --filter web e2e tests/ai-feature-assistant-attachments.spec.ts`
 *   after starting the local Aspire stack and the dev server). All backend
 *   calls are mocked via `page.route` for determinism.
 */

import { Buffer } from "node:buffer";
import * as path from "node:path";
import { expect, type Page, type Route, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Constants — fake but URL-shaped IDs (the test never hits real DB).
// ---------------------------------------------------------------------------

const PROJECT_ID = "test-copilot-attach-project-id";
const STORY_ID = "test-copilot-attach-story-id";
const STORY_DESCRIPTION = "<p>AI Feature Assistant attachments regression.</p>";

const PDF_FIXTURE = path.join(__dirname, "fixtures", "sample.pdf");
const PNG_FIXTURE = path.join(__dirname, "fixtures", "sample.png");
/**
 * Real two-sheet workbook. It must be a real file, not a stub: the client
 * classifier (`classifyAiChatWorkbook`, U4) reads the leading bytes and admits
 * a `.xlsx` only on the `PK` zip signature, so a fake would be refused before a
 * chip ever appeared and the test would pass against the rejection path.
 * See `fixtures/README.md` for the generator.
 */
const XLSX_FIXTURE = path.join(__dirname, "fixtures", "sample.xlsx");

const STUB_AI_CHAT_ID = "test-ai-chat-id";
const STUB_DOCUMENT_ID = "test-ai-document-id";
const STUB_S3_KEY = `chat-documents/${STUB_AI_CHAT_ID}/${STUB_DOCUMENT_ID}/sample.pdf`;
const STUB_SIGNED_UPLOAD_URL = "https://stub-bucket.local/upload?signed=1";
const STUB_EXTRACTED_CONTENT = "Extracted text from sample PDF.";

/** Mirrors the real sheets in `fixtures/sample.xlsx` — keep the two in step. */
const WORKBOOK_SHEET_NAMES = ["Summary", "Q1 Detail"] as const;
const STUB_WORKBOOK_CONTENT =
	"## Summary\nMetric\tQ1\tQ2\nSignups\t1200\t1810\n\n## Q1 Detail\nItem\tOwner\tStatus\nOnboarding revamp\tAda\tShipped";

/**
 * Leading bytes of an OLE compound file (`D0 CF 11 E0`) — the container a real
 * legacy `.xls` uses, and exactly what `classifyAiChatWorkbook` branches on to
 * return `legacy-unsupported` (AE3).
 *
 * Inlined rather than committed as a fixture because the classifier reads only
 * the first four bytes, so the rest of a real `.xls` would buy the test nothing.
 * That is the same reasoning that makes `sample.xlsx` a real file and this a
 * byte array: the zip signature sits at the head of a structure that cannot be
 * hand-written, and this one does not.
 */
const MINIMAL_XLS_OLE_BYTES = [
	0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00, 0x00, 0x00,
	0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
	0x3e, 0x00, 0x03, 0x00, 0xfe, 0xff, 0x09, 0x00,
];

// 1x1 transparent PNG bytes (matches `apps/web/tests/fixtures/sample.png`).
// Inlined here so the in-page paste handler does not need to read the disk —
// it constructs a real `File` from a `Uint8Array` inside the browser context.
const MINIMAL_PNG_BYTES = [
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
	0x0b, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0x60, 0x00, 0x02, 0x00,
	0x00, 0x05, 0x00, 0x01, 0xe2, 0x26, 0x05, 0x9b, 0x00, 0x00, 0x00, 0x00,
	0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
];

// ---------------------------------------------------------------------------
// oRPC wire helpers (same envelope used by every `**/api/rpc/**` mock).
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
// Fixture builders shaped like the real API responses.
// ---------------------------------------------------------------------------

function buildProjectPayload() {
	const now = new Date().toISOString();
	return {
		project: {
			id: PROJECT_ID,
			name: "Copilot Attachment Project",
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

function buildStoryPayload() {
	const now = new Date().toISOString();
	return {
		story: {
			id: STORY_ID,
			projectId: PROJECT_ID,
			title: "Copilot Attachment Story",
			description: STORY_DESCRIPTION,
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
				name: "Copilot Attachment Project",
				userId: "test-user-id",
				organizationId: null,
			},
		},
	};
}

// ---------------------------------------------------------------------------
// Mock state + installer for the upload pipeline.
//
// The factory exercises these oRPC procedures during a chip lifecycle:
//   - ai.documents.createUploadUrl  (signed URL + chatId)
//   - PUT to signedUploadUrl         (S3-style)
//   - ai.documents.process           (extracts inline AND kicks off chunking)
//   - ai.documents.getStatus         (legacy poll — see note below)
//   - ai.documents.getContent        (legacy fetch — see note below)
//
// `process` is the load-bearing one: the hook awaits it and reads
// `extractedContent` + `extraction` straight off the response, which is what
// builds both the chip's extraction notice and the rag-context entry. The
// getStatus / getContent routes are kept only so a stray call cannot reach the
// network; the hook no longer polls them.
// ---------------------------------------------------------------------------

interface UploadState {
	createUploadUrlCalls: number;
	s3PutCalls: number;
	processCalls: number;
	getStatusCalls: number;
	getContentCalls: number;
	/** Set to "fail-network" to abort the upload-url call (AC-9). */
	mode: "happy" | "fail-network";
	/**
	 * What `ai.documents.process` reports it read. Defaults to the PDF shape;
	 * the workbook tests override it with a multi-sheet `extracted` outcome.
	 * Shaped as `AiChatExtractionOutcome` (see `@repo/utils/ai-chat-attachment`)
	 * but typed loosely here — this is wire JSON, not a typed client call.
	 */
	processResult?: {
		extractedContent: string;
		extraction: Record<string, unknown>;
	};
}

const DEFAULT_PROCESS_RESULT = {
	extractedContent: STUB_EXTRACTED_CONTENT,
	// A PDF carries no sheets — `sheets: []` is the non-workbook shape.
	extraction: { status: "extracted", sheets: [] as unknown[] },
};

async function installStoryWorkspaceMocks(
	page: Page,
	uploadState: UploadState,
): Promise<void> {
	// --- Story / project reads ---------------------------------------------
	await page.route("**/api/rpc/projects/get**", (route) =>
		fulfillJson(route, buildProjectPayload()),
	);
	await page.route("**/api/rpc/projects/stories/get**", (route) =>
		fulfillJson(route, buildStoryPayload()),
	);

	// Quiet ancillary reads the page fires on mount.
	await page.route("**/api/rpc/projects/documents/list**", (route) =>
		fulfillJson(route, { documents: [] }),
	);
	await page.route("**/api/rpc/projects/stories/versions/list**", (route) =>
		fulfillJson(route, { versions: [] }),
	);
	await page.route("**/api/rpc/projects/stories/list**", (route) =>
		fulfillJson(route, { stories: [] }),
	);
	await page.route("**/api/rpc/projects/stories/statuses/list**", (route) =>
		fulfillJson(route, { statuses: [] }),
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

	// --- Upload pipeline ---------------------------------------------------
	await page.route(
		"**/api/rpc/ai/documents/createUploadUrl**",
		async (route) => {
			uploadState.createUploadUrlCalls += 1;
			if (uploadState.mode === "fail-network") {
				// AC-9: simulate the upload-URL call failing with a 500. The
				// factory's catch block flips the chip to `error` with a
				// tooltip surfacing the message text.
				await route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify({
						defined: false,
						code: "INTERNAL_SERVER_ERROR",
						status: 500,
						message: "Upload service unavailable",
						data: {},
					}),
				});
				return;
			}
			await fulfillJson(route, {
				documentId: STUB_DOCUMENT_ID,
				signedUploadUrl: STUB_SIGNED_UPLOAD_URL,
				useServerUpload: false,
				chatId: STUB_AI_CHAT_ID,
				s3Key: STUB_S3_KEY,
				storageProvider: "stub",
			});
		},
	);

	// S3 PUT — the bucket is mocked locally so the upload always succeeds.
	await page.route(`${STUB_SIGNED_UPLOAD_URL}*`, async (route) => {
		uploadState.s3PutCalls += 1;
		await route.fulfill({ status: 200, body: "" });
	});

	// Inline extraction + background chunking. The hook awaits this and reads
	// `extractedContent` / `extraction` off the response — they drive the chip's
	// extraction notice and the rag-context entry, so this mock (not getContent)
	// is what the content assertions ultimately test against.
	await page.route("**/api/rpc/ai/documents/process**", async (route) => {
		uploadState.processCalls += 1;
		const result = uploadState.processResult ?? DEFAULT_PROCESS_RESULT;
		await fulfillJson(route, {
			status: "PROCESSING",
			extractedContent: result.extractedContent,
			extraction: result.extraction,
		});
	});

	// Legacy poll route — the hook awaits `process` instead. Kept so a stray
	// call cannot escape to the network.
	await page.route("**/api/rpc/ai/documents/getStatus**", async (route) => {
		uploadState.getStatusCalls += 1;
		await fulfillJson(route, { status: "READY" });
	});

	// Legacy content route — superseded by `process`'s inline `extractedContent`.
	await page.route("**/api/rpc/ai/documents/getContent**", async (route) => {
		uploadState.getContentCalls += 1;
		await fulfillJson(route, { content: STUB_EXTRACTED_CONTENT });
	});

	// CopilotKit AG-UI runtime — return an empty 200 so the React tree mounts
	// without throwing. The agent stream is not exercised in this spec; we only
	// assert the OUTBOUND POST body (AC-7), which carries both the user message
	// and the rag-context entries the client assembles before the stream runs.
	await page.route("**/api/copilotkit**", async (route) => {
		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({}),
		});
	});
}

// ---------------------------------------------------------------------------
// In-browser paste helper — synthesises a real `ClipboardEvent` carrying a
// PNG `File` and dispatches it on the textarea (the factory wires onPaste on
// `<textarea>`, see CopilotSidebarInput.tsx:352).
// ---------------------------------------------------------------------------

async function pastePngIntoChat(
	page: Page,
	bytes: number[],
	filename = "pasted.png",
): Promise<void> {
	await page.evaluate(
		({ bytes, filename }) => {
			const textarea = document.querySelector<HTMLTextAreaElement>(
				".copilot-sidebar-input-wrapper textarea",
			);
			if (!textarea) {
				throw new Error(
					"[ai-feature-assistant] copilot textarea not found",
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
			textarea.dispatchEvent(event);
		},
		{ bytes, filename },
	);
}

// ---------------------------------------------------------------------------
// Locator helpers — keep the test bodies focused on intent.
// ---------------------------------------------------------------------------

function copilotInputWrapper(page: Page) {
	return page.locator(".copilot-sidebar-input-wrapper");
}

function attachmentChipFor(page: Page, fileName: string) {
	// The chip is the parent flex row of the filename text node.
	return copilotInputWrapper(page)
		.locator(`div:has(> span:text-is("${fileName}"))`)
		.first();
}

/**
 * Anything that would ask the user which sheets to include. No such UI exists —
 * a workbook is read whole (AE1) — so this is a guard against one appearing,
 * not a probe of something that is there.
 *
 * Matched on copy rather than a test id for that reason: a future prompt would
 * arrive with its own markup but would have to say something along these lines.
 * Deliberately narrow enough to let the chip's own "Sheets read: …" disclosure
 * through, which is a report of what happened, not a question.
 */
const SHEET_SELECTION_PROMPT_PATTERN =
	/which sheets?|select (a |the |which )?sheets?|choose (a |the |which )?sheets?|sheets? to (include|import|read)/i;

async function expectNoSheetSelectionPrompt(page: Page): Promise<void> {
	await expect(page.getByText(SHEET_SELECTION_PROMPT_PATTERN)).toHaveCount(0);
	await expect(page.getByRole("combobox", { name: /sheet/i })).toHaveCount(0);
	await expect(page.getByRole("listbox", { name: /sheet/i })).toHaveCount(0);
}

// ---------------------------------------------------------------------------
// Specs.
// ---------------------------------------------------------------------------

test.describe("AI Feature Assistant — attachments happy path", () => {
	test("paperclip → upload PDF → chip lifecycle → send ships the rag-context envelope", async ({
		page,
	}, testInfo) => {
		// Binary docs await server-side extraction, so the test budget needs
		// headroom over the default 30s.
		testInfo.setTimeout(90_000);

		const uploadState: UploadState = {
			createUploadUrlCalls: 0,
			s3PutCalls: 0,
			processCalls: 0,
			getStatusCalls: 0,
			getContentCalls: 0,
			mode: "happy",
		};
		await installStoryWorkspaceMocks(page, uploadState);

		// Capture the outbound message that the factory PUTs to the
		// CopilotKit runtime. We assert against the body in step (4).
		const outboundMessages: string[] = [];
		await page.route("**/api/copilotkit**", async (route) => {
			const post = route.request().postData();
			if (post) {
				outboundMessages.push(post);
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({}),
			});
		});

		await page.goto(`/app/projects/${PROJECT_ID}/stories/${STORY_ID}`);

		// AC-1 / Visibility: paperclip is rendered and accessible by label
		// (i18n key `tooltips.copilot.attachDocument` →
		// "Attach a file (PDF, DOCX, TXT, MD, or image).").
		const paperclipButton = page.getByRole("button", {
			name: /Attach a file/i,
		});
		await expect(paperclipButton).toBeVisible({ timeout: 20_000 });

		// AC-1: trigger the hidden file input directly via setInputFiles.
		// The factory wires the `<input type="file" hidden multiple>` inside
		// the wrapper (CopilotSidebarInput.tsx:454) — Playwright lifts the
		// `hidden` styling and uploads the fixture.
		const fileInput =
			copilotInputWrapper(page).locator('input[type="file"]');
		await fileInput.setInputFiles(PDF_FIXTURE);

		// AC-5: chip with the filename appears.
		const pdfChip = attachmentChipFor(page, "sample.pdf");
		await expect(pdfChip).toBeVisible({ timeout: 10_000 });

		// AC-5: chip walks the lifecycle and lands in `ready`. The remove
		// button is hidden during `uploading` / `processing` and re-rendered
		// once the chip reaches `ready` (CopilotSidebarAttachments.tsx:173) —
		// asserting the remove button is back is a clean, accessible-name
		// based proxy for the terminal state.
		await expect(
			pdfChip.getByRole("button", { name: /Remove sample\.pdf/i }),
		).toBeVisible({ timeout: 60_000 });

		// AC-7: send and assert the outbound payload carries the rag-context
		// envelope. Type a small message so the send is a normal prompt+file.
		const textarea =
			copilotInputWrapper(page).getByPlaceholder(/Type a message/i);
		await textarea.fill("Please review the attached PDF.");

		const sendButton = page.getByRole("button", {
			name: /Send this message to the assistant/i,
		});
		await sendButton.click();

		// We poll because the POST happens asynchronously after
		// `uploadAttachments()` resolves inside `handleSend`.
		await expect
			.poll(
				() => outboundMessages.find((m) => m.includes("sample.pdf")),
				{ timeout: 20_000 },
			)
			.toBeTruthy();

		const matchingMessage =
			outboundMessages.find((m) => m.includes("sample.pdf")) ?? "";

		// AC-7: content reaches the agent as a rag-context entry built by
		// `buildAttachmentContextEntry` — filename prefix plus the extracted
		// text the mocked `process` returned.
		expect(matchingMessage).toContain("[Uploaded Document: sample.pdf]");
		expect(matchingMessage).toContain(STUB_EXTRACTED_CONTENT);

		// The user message itself stays clean: typed prompt + the lightweight
		// `[Attached: …]` hint that `CopilotUserMessage` renders as chips.
		expect(matchingMessage).toContain("[Attached: sample.pdf]");

		// The `<attached_documents>` wrapper is gone (PR #722 / #723). Asserting
		// its absence keeps this spec honest about which envelope is live, and
		// mirrors the unit test in `CopilotSidebarInput.test.tsx`.
		expect(matchingMessage).not.toContain("<attached_documents>");
		expect(matchingMessage).not.toContain("<document_content");
	});

	test("paste image → chip status flow → outbound message references it", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(60_000);

		const uploadState: UploadState = {
			createUploadUrlCalls: 0,
			s3PutCalls: 0,
			processCalls: 0,
			getStatusCalls: 0,
			getContentCalls: 0,
			mode: "happy",
		};
		await installStoryWorkspaceMocks(page, uploadState);

		const outboundMessages: string[] = [];
		await page.route("**/api/copilotkit**", async (route) => {
			const post = route.request().postData();
			if (post) {
				outboundMessages.push(post);
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({}),
			});
		});

		await page.goto(`/app/projects/${PROJECT_ID}/stories/${STORY_ID}`);

		// Wait for the wrapper to mount (the paste handler is wired on the
		// textarea inside it — see CopilotSidebarInput.tsx:352).
		await expect(copilotInputWrapper(page)).toBeVisible({
			timeout: 20_000,
		});
		await copilotInputWrapper(page)
			.getByPlaceholder(/Type a message/i)
			.waitFor({ state: "visible" });

		// AC-3: paste a real PNG `File` payload.
		await pastePngIntoChat(page, MINIMAL_PNG_BYTES, "screenshot.png");

		// AC-5: chip materialises with the pasted filename.
		const pngChip = attachmentChipFor(page, "screenshot.png");
		await expect(pngChip).toBeVisible({ timeout: 10_000 });

		// AC-5: chip walks `pending → uploading → processing → ready`.
		// Images skip the binary-document polling branch (they go straight
		// from `processing` to `ready` once `process()` resolves).
		await expect(
			pngChip.getByRole("button", { name: /Remove screenshot\.png/i }),
		).toBeVisible({ timeout: 30_000 });

		// AC-7: send and assert the outbound payload references the image.
		// Images ride the same rag-context channel as documents, but
		// `buildAttachmentContextEntry` gives them the markdown-image envelope
		// so vision-capable models get a picture rather than base64 under a
		// "Document" label.
		const textarea =
			copilotInputWrapper(page).getByPlaceholder(/Type a message/i);
		await textarea.fill("What does this screenshot show?");
		await page
			.getByRole("button", {
				name: /Send this message to the assistant/i,
			})
			.click();

		await expect
			.poll(
				() =>
					outboundMessages.find((m) => m.includes("screenshot.png")),
				{ timeout: 20_000 },
			)
			.toBeTruthy();

		const matchingMessage =
			outboundMessages.find((m) => m.includes("screenshot.png")) ?? "";
		expect(matchingMessage).toContain("[Uploaded Image: screenshot.png]");
		// The markdown image link carrying the data URL — the "Image" branch of
		// the envelope builder, not the "Document" one.
		expect(matchingMessage).toContain("![screenshot.png](data:image/");
		expect(matchingMessage).toContain("[Attached: screenshot.png]");
		expect(matchingMessage).not.toContain("<attached_documents>");
	});

	test("AC-6: clicking the chip X removes the attachment before send", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(60_000);

		const uploadState: UploadState = {
			createUploadUrlCalls: 0,
			s3PutCalls: 0,
			processCalls: 0,
			getStatusCalls: 0,
			getContentCalls: 0,
			mode: "happy",
		};
		await installStoryWorkspaceMocks(page, uploadState);

		await page.goto(`/app/projects/${PROJECT_ID}/stories/${STORY_ID}`);
		await expect(copilotInputWrapper(page)).toBeVisible({
			timeout: 20_000,
		});

		// Use the small PNG fixture — paperclip path keeps the chip in
		// `pending` long enough to remove it without a race against `ready`.
		// (The image path skips the polling branch and reaches `ready`
		// almost immediately under the mocked pipeline.)
		const fileInput =
			copilotInputWrapper(page).locator('input[type="file"]');
		await fileInput.setInputFiles(PNG_FIXTURE);

		const pngChip = attachmentChipFor(page, "sample.png");
		await expect(pngChip).toBeVisible({ timeout: 10_000 });

		// AC-6: click the X (accessible name `Remove sample.png` from
		// CopilotSidebarAttachments.tsx:190) — the chip is removed.
		await pngChip
			.getByRole("button", { name: /Remove sample\.png/i })
			.click();
		await expect(pngChip).toHaveCount(0, { timeout: 5_000 });

		// And no upload was sent to the runtime (the chip never reached
		// `ready` because we removed it first).
		expect(uploadState.s3PutCalls).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Excel attachment (plan 2026-07-16-001, U8).
//
// Chip-lifecycle note: `uploadAttachments()` runs inside `handleSend`, and the
// factory calls `clearAttachments()` synchronously once it resolves. The
// `ready` state therefore lands and is cleared in the same React batch and is
// not reliably paintable, so these tests assert the *outcome* of reaching ready
// — the content arrived over the rag-context channel and the chip cleared —
// rather than racing the transient painted state. (A failed upload returns
// early and leaves its chip behind, which is what the AC-9 test below observes;
// so a cleared chip is the observable inverse: the upload succeeded.)
//
// The chip's own "Sheets read: …" disclosure is unit-tested in
// `apps/web/__tests__/copilot/copilot-attachment-extraction-notice.test.tsx`
// and is not re-proved here.
// ---------------------------------------------------------------------------

test.describe("AI Feature Assistant — Excel attachment", () => {
	test("R1 / AE1: a multi-sheet workbook attaches and is read whole, with no sheet-selection prompt", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(90_000);

		const uploadState: UploadState = {
			createUploadUrlCalls: 0,
			s3PutCalls: 0,
			processCalls: 0,
			getStatusCalls: 0,
			getContentCalls: 0,
			mode: "happy",
			processResult: {
				extractedContent: STUB_WORKBOOK_CONTENT,
				extraction: {
					status: "extracted",
					sheets: WORKBOOK_SHEET_NAMES.map((name) => ({
						name,
						hidden: false,
					})),
				},
			},
		};
		await installStoryWorkspaceMocks(page, uploadState);

		const outboundMessages: string[] = [];
		await page.route("**/api/copilotkit**", async (route) => {
			const post = route.request().postData();
			if (post) {
				outboundMessages.push(post);
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({}),
			});
		});

		await page.goto(`/app/projects/${PROJECT_ID}/stories/${STORY_ID}`);
		await expect(copilotInputWrapper(page)).toBeVisible({
			timeout: 20_000,
		});

		// R1: attach the real workbook. The chip appearing is the meaningful
		// assertion here — `addFiles` reads the file's leading bytes and runs
		// `classifyAiChatWorkbook` BEFORE creating a chip, so a chip exists only
		// if the real `PK` zip signature was read off the real file and
		// accepted. This is the path the fixture exists to exercise.
		const fileInput =
			copilotInputWrapper(page).locator('input[type="file"]');
		await fileInput.setInputFiles(XLSX_FIXTURE);

		const xlsxChip = attachmentChipFor(page, "sample.xlsx");
		await expect(xlsxChip).toBeVisible({ timeout: 10_000 });

		// AE1: no prompt at selection — the point in the flow where a
		// sheet-picker would have to appear.
		await expectNoSheetSelectionPrompt(page);

		const textarea =
			copilotInputWrapper(page).getByPlaceholder(/Type a message/i);
		await textarea.fill("Summarise the attached workbook.");
		await page
			.getByRole("button", {
				name: /Send this message to the assistant/i,
			})
			.click();

		await expect
			.poll(
				() => outboundMessages.find((m) => m.includes("sample.xlsx")),
				{ timeout: 30_000 },
			)
			.toBeTruthy();

		const matchingMessage =
			outboundMessages.find((m) => m.includes("sample.xlsx")) ?? "";

		// R1: the workbook's text reached the agent through the same
		// rag-context envelope every other format uses.
		expect(matchingMessage).toContain("[Uploaded Document: sample.xlsx]");
		expect(matchingMessage).toContain("[Attached: sample.xlsx]");

		// AE1: cell content unique to EACH sheet arrives in one turn — the
		// workbook was read whole. Asserted on cell values rather than the sheet
		// names, which are common enough words to pass against unrelated text
		// elsewhere in the payload.
		expect(matchingMessage).toContain("Signups"); // Summary sheet
		expect(matchingMessage).toContain("Onboarding revamp"); // Q1 Detail sheet

		// AE1: still no prompt after the round-trip.
		await expectNoSheetSelectionPrompt(page);

		// The upload actually happened, and the chip cleared — the factory only
		// clears once the file reached the agent (see the note above).
		expect(uploadState.s3PutCalls).toBe(1);
		expect(uploadState.processCalls).toBe(1);
		await expect(xlsxChip).toHaveCount(0, { timeout: 10_000 });
	});

	test("removing an attached workbook clears its chip and its content", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(60_000);

		const uploadState: UploadState = {
			createUploadUrlCalls: 0,
			s3PutCalls: 0,
			processCalls: 0,
			getStatusCalls: 0,
			getContentCalls: 0,
			mode: "happy",
			processResult: {
				extractedContent: STUB_WORKBOOK_CONTENT,
				extraction: {
					status: "extracted",
					sheets: WORKBOOK_SHEET_NAMES.map((name) => ({
						name,
						hidden: false,
					})),
				},
			},
		};
		await installStoryWorkspaceMocks(page, uploadState);

		const outboundMessages: string[] = [];
		await page.route("**/api/copilotkit**", async (route) => {
			const post = route.request().postData();
			if (post) {
				outboundMessages.push(post);
			}
			await route.fulfill({
				status: 200,
				contentType: "application/json",
				body: JSON.stringify({}),
			});
		});

		await page.goto(`/app/projects/${PROJECT_ID}/stories/${STORY_ID}`);
		await expect(copilotInputWrapper(page)).toBeVisible({
			timeout: 20_000,
		});

		const fileInput =
			copilotInputWrapper(page).locator('input[type="file"]');
		await fileInput.setInputFiles(XLSX_FIXTURE);

		const xlsxChip = attachmentChipFor(page, "sample.xlsx");
		await expect(xlsxChip).toBeVisible({ timeout: 10_000 });

		// The chip goes.
		await xlsxChip
			.getByRole("button", { name: /Remove sample\.xlsx/i })
			.click();
		await expect(xlsxChip).toHaveCount(0, { timeout: 5_000 });

		// And so does its content: a send after the removal carries no trace of
		// the workbook. Uploads only run from `handleSend`, so a file removed
		// beforehand is never read — this asserts that staged-but-removed files
		// cannot leak into the next turn's context.
		const textarea =
			copilotInputWrapper(page).getByPlaceholder(/Type a message/i);
		await textarea.fill("Never mind the workbook — what is this story?");
		await page
			.getByRole("button", {
				name: /Send this message to the assistant/i,
			})
			.click();

		await expect
			.poll(
				() =>
					outboundMessages.find((m) =>
						m.includes("what is this story"),
					),
				{ timeout: 20_000 },
			)
			.toBeTruthy();

		for (const message of outboundMessages) {
			expect(message).not.toContain("sample.xlsx");
			expect(message).not.toContain("Onboarding revamp");
		}
		expect(uploadState.s3PutCalls).toBe(0);
		expect(uploadState.processCalls).toBe(0);
	});

	test("AE3: a legacy .xls is refused at selection with a save-as-xlsx hint", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(60_000);

		const uploadState: UploadState = {
			createUploadUrlCalls: 0,
			s3PutCalls: 0,
			processCalls: 0,
			getStatusCalls: 0,
			getContentCalls: 0,
			mode: "happy",
		};
		await installStoryWorkspaceMocks(page, uploadState);

		await page.goto(`/app/projects/${PROJECT_ID}/stories/${STORY_ID}`);
		await expect(copilotInputWrapper(page)).toBeVisible({
			timeout: 20_000,
		});

		// `setInputFiles` bypasses the picker's `accept` hint exactly as
		// paste/drop do, so this reaches the hook's own classifier rather than
		// being filtered by the browser — which is the code path AE3 is about.
		// The OLE signature is what makes it a genuine `.xls` to the classifier.
		const fileInput =
			copilotInputWrapper(page).locator('input[type="file"]');
		await fileInput.setInputFiles({
			name: "legacy-budget.xls",
			mimeType: "application/vnd.ms-excel",
			buffer: Buffer.from(MINIMAL_XLS_OLE_BYTES),
		});

		// AE3: refused at selection. Located by text rather than `getByRole` —
		// sonner renders a toast as a bare `<li data-sonner-toast>` with no
		// role, inside an `aria-live` section, so there is no "status" role to
		// query. `getByText` is the accessible-first query that actually
		// resolves here (per `fabric/standards/testing/test-writing.md`).
		// Error toasts are configured to persist until dismissed
		// (`installPersistentErrorToastDefaults`), so this cannot race a
		// timeout.
		const refusalToast = page.getByText(/legacy Excel format/i).first();
		await expect(refusalToast).toBeVisible({ timeout: 10_000 });
		// The refusal names the way out (save as .xlsx) rather than the generic
		// "File type not supported" the extension guard would have produced —
		// which is the whole point of classifying ahead of that guard.
		await expect(refusalToast).toContainText(/save it as \.xlsx/i);

		// No chip, and nothing was uploaded — the refusal is at selection, not
		// after a round-trip.
		await expect(attachmentChipFor(page, "legacy-budget.xls")).toHaveCount(
			0,
		);
		expect(uploadState.createUploadUrlCalls).toBe(0);
		expect(uploadState.s3PutCalls).toBe(0);
	});
});

test.describe("AI Feature Assistant — upload error path (AC-9)", () => {
	test("upload network failure flips chip to error with hover tooltip; no retry button", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(60_000);

		const uploadState: UploadState = {
			createUploadUrlCalls: 0,
			s3PutCalls: 0,
			processCalls: 0,
			getStatusCalls: 0,
			getContentCalls: 0,
			mode: "fail-network",
		};
		await installStoryWorkspaceMocks(page, uploadState);

		await page.goto(`/app/projects/${PROJECT_ID}/stories/${STORY_ID}`);
		await expect(copilotInputWrapper(page)).toBeVisible({
			timeout: 20_000,
		});

		// Start an upload — `createUploadUrl` will return 500, the factory's
		// catch block flips the chip to `error`.
		const fileInput =
			copilotInputWrapper(page).locator('input[type="file"]');
		await fileInput.setInputFiles(PDF_FIXTURE);

		const pdfChip = attachmentChipFor(page, "sample.pdf");
		await expect(pdfChip).toBeVisible({ timeout: 10_000 });

		// Trigger the upload by clicking Send — the factory only calls
		// `uploadAttachments()` from inside `handleSend` (line 234), so the
		// upload only fires once the user explicitly tries to send.
		const textarea =
			copilotInputWrapper(page).getByPlaceholder(/Type a message/i);
		await textarea.fill("Trigger the failing upload.");
		await page
			.getByRole("button", {
				name: /Send this message to the assistant/i,
			})
			.click();

		// AC-9: chip flips to the error state. The error icon (lucide
		// `XCircle`) is wrapped in a `<TooltipTrigger>` with the error
		// message as `<TooltipContent>` (CopilotSidebarAttachments.tsx:149).
		// Wait for the chip to enter error state — proxy via the remove
		// button being visible again (only present when not uploading or
		// processing) AND the error tooltip trigger being present in the
		// chip's children.
		await expect(
			pdfChip.getByRole("button", { name: /Remove sample\.pdf/i }),
		).toBeVisible({ timeout: 30_000 });

		// Hover the chip's status icon — the tooltip should reveal an error
		// message (the exact text comes from the catch block; we assert on
		// "fail" so the test does not bind to the specific copy).
		await pdfChip.hover();
		await expect(
			page
				.getByRole("tooltip")
				.filter({ hasText: /fail|unavailable|error/i })
				.first(),
		).toBeVisible({ timeout: 5_000 });

		// Out of scope per spec §1 Non-Goals + AC-9: there is no retry
		// button. Asserting absence proves the chip's error variant did
		// not introduce one inadvertently.
		await expect(
			pdfChip.getByRole("button", { name: /retry/i }),
		).toHaveCount(0);
	});
});
