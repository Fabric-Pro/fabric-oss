/**
 * AI Assistant reasoning trace — E2E (Task 9).
 *
 * Spec: `docs/superpowers/plans/2026-05-15-ai-assistant-reasoning-trace.md`
 *
 * What this spec locks in:
 *   - When the agent's AG-UI state stream carries `reasoningByTurn`, the
 *     `<ReasoningCollapsible>` row renders inside both Document- and Feature-
 *     scoped AI Assistant surfaces (CopilotAssistantMessage shared renderer).
 *   - The collapsible header reports the turn duration as "Thinking · Xs",
 *     starts collapsed (`aria-expanded="false"`), and toggles to reveal the
 *     reasoning text when activated.
 *   - When the snapshot omits `reasoningByTurn`, no Thinking row mounts and
 *     the assistant message renders normally without console errors.
 *
 * Mock approach:
 *   - Heavy oRPC mock chain inherited from
 *     `ai-feature-assistant-attachments.spec.ts` via copy-paste (constants
 *     renamed to avoid cross-test contamination, follow-up extracts both
 *     specs into `tests/fixtures/copilot-fixtures.ts`).
 *   - `/api/copilotkit` returns an AG-UI SSE stream in the **data-only** wire
 *     format (`data: ${JSON.stringify(event)}\n\n`) — verified at
 *     `packages/agent-core/src/unified-server.ts` and
 *     `packages/agent-core/__tests__/unified-server.test.ts:31-40`.
 *
 * Selectors per `fabric/standards/testing/test-writing.md`: `getByRole`,
 * `getByPlaceholder`, `getByText`.
 *
 * Runtime note:
 *   Like the reference attachments spec, these tests require the Aspire-managed
 *   dev server on `http://localhost:3001` (started by `playwright.config.ts`'s
 *   `webServer` directive). All backend calls are mocked via `page.route` so
 *   the assertions are deterministic regardless of Aspire/agent state.
 */

import { expect, type Page, type Route, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Constants — fake but URL-shaped IDs (the test never hits real DB).
// Renamed from the reference spec to avoid cross-test contamination if both
// specs ever run in the same browser context.
// ---------------------------------------------------------------------------

const PROJECT_ID = "test-reasoning-project-id";
const STORY_ID = "test-reasoning-story-id";
const DOCUMENT_ID = "test-reasoning-document-id";
const STORY_DESCRIPTION = "<p>AI Assistant reasoning trace regression.</p>";

const STUB_AI_CHAT_ID = "test-ai-chat-id";
const STUB_DOCUMENT_ID = "test-ai-document-id";
const STUB_S3_KEY = `chat-documents/${STUB_AI_CHAT_ID}/${STUB_DOCUMENT_ID}/sample.pdf`;
const STUB_SIGNED_UPLOAD_URL = "https://stub-bucket.local/upload?signed=1";
const STUB_EXTRACTED_CONTENT = "Extracted text from sample PDF.";

const REASONING_FIXTURE_TEXT = "Let me think about what the user needs here.";
const REASONING_DURATION_MS = 4200;

// ---------------------------------------------------------------------------
// oRPC wire helpers (same envelope used by every `**/api/rpc/**` mock).
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Fixture builders shaped like the real API responses.
// ---------------------------------------------------------------------------

function buildProjectPayload() {
	const now = new Date().toISOString();
	return {
		project: {
			id: PROJECT_ID,
			name: "Reasoning Trace Project",
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
			title: "Reasoning Trace Story",
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
				name: "Reasoning Trace Project",
				userId: "test-user-id",
				organizationId: null,
			},
		},
	};
}

function buildDocumentPayload() {
	const now = new Date().toISOString();
	return {
		// `projects.documents.get` returns `{ document }` (wrapped) — verified
		// at packages/api/modules/projects/procedures/get-document.ts:56.
		document: {
			id: DOCUMENT_ID,
			projectId: PROJECT_ID,
			title: "Reasoning Test Document",
			content: "# Reasoning Test Document\n\nInitial content.",
			// Prisma schema field is `type` (NOT `documentType`) and the
			// ProjectDocumentType enum values are UPPERCASE (schema.prisma).
			type: "GENERAL",
			version: 1,
			createdAt: now,
			updatedAt: now,
		},
	};
}

// ---------------------------------------------------------------------------
// Mock state + installer for the upload pipeline.
//
// The factory exercises four oRPC procedures during a chip lifecycle:
//   - ai.documents.createUploadUrl  (signed URL + chatId)
//   - PUT to signedUploadUrl         (S3-style)
//   - ai.documents.process           (kick off Temporal processing)
//   - ai.documents.getStatus         (poll until READY)
//   - ai.documents.getContent        (fetch extracted text for binary docs)
//
// The reasoning spec doesn't exercise uploads, but `installStoryWorkspaceMocks`
// installs the full chain unconditionally — call `createDefaultUploadState()`
// before each invocation.
// ---------------------------------------------------------------------------

interface UploadState {
	createUploadUrlCalls: number;
	s3PutCalls: number;
	processCalls: number;
	getStatusCalls: number;
	getContentCalls: number;
	/** Set to "fail-network" to abort the upload-url call. */
	mode: "happy" | "fail-network";
}

function createDefaultUploadState(): UploadState {
	return {
		createUploadUrlCalls: 0,
		s3PutCalls: 0,
		processCalls: 0,
		getStatusCalls: 0,
		getContentCalls: 0,
		mode: "happy",
	};
}

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

	await page.route(`${STUB_SIGNED_UPLOAD_URL}*`, async (route) => {
		uploadState.s3PutCalls += 1;
		await route.fulfill({ status: 200, body: "" });
	});

	await page.route("**/api/rpc/ai/documents/process**", async (route) => {
		uploadState.processCalls += 1;
		await fulfillJson(route, { status: "PROCESSING" });
	});

	await page.route("**/api/rpc/ai/documents/getStatus**", async (route) => {
		uploadState.getStatusCalls += 1;
		await fulfillJson(route, { status: "READY" });
	});

	await page.route("**/api/rpc/ai/documents/getContent**", async (route) => {
		uploadState.getContentCalls += 1;
		await fulfillJson(route, { content: STUB_EXTRACTED_CONTENT });
	});
}

// ---------------------------------------------------------------------------
// Document-path mock installer — Document editor fires both
// `projects.documents.get` AND `projects.documents.listAssets` on mount
// (verified at apps/web/modules/saas/projects/components/DocumentEditor.tsx:598-605).
// Both must be mocked or the test will hit the real backend.
// ---------------------------------------------------------------------------

async function installDocumentMocks(page: Page): Promise<void> {
	await page.route("**/api/rpc/projects/documents/get**", (route) =>
		fulfillJson(route, buildDocumentPayload()),
	);
	await page.route("**/api/rpc/projects/documents/listAssets**", (route) =>
		fulfillJson(route, { assets: [] }),
	);
}

// ---------------------------------------------------------------------------
// AG-UI SSE response builder — data-only frames (no `event: agent\n` prefix).
//
// Format verified at:
//   - packages/agent-core/src/unified-server.ts:2493-2505
//   - packages/agent-core/__tests__/unified-server.test.ts:31-40
//
// Each event is JSON-encoded and emitted as `data: ${JSON}\n\n`.
// ---------------------------------------------------------------------------

function buildAgUiSseResponse(opts: {
	includeReasoning: boolean;
	runId: string;
	threadId: string;
}): string {
	const events: Array<Record<string, unknown>> = [
		{ type: "RUN_STARTED", runId: opts.runId, threadId: opts.threadId },
	];

	const snapshot: Record<string, unknown> = {
		messages: [
			{ type: "human", content: "How does this work?", id: "u1" },
			{ type: "ai", content: "Here is the answer.", id: "a1" },
		],
		document: "",
	};
	if (opts.includeReasoning) {
		snapshot.reasoningByTurn = {
			1: {
				text: REASONING_FIXTURE_TEXT,
				durationMs: REASONING_DURATION_MS,
				startedAt: 1000,
				completedAt: 1000 + REASONING_DURATION_MS,
			},
		};
	}

	events.push({ type: "STATE_SNAPSHOT", snapshot });
	events.push({
		type: "TEXT_MESSAGE_START",
		messageId: "a1",
		role: "assistant",
	});
	events.push({
		type: "TEXT_MESSAGE_CONTENT",
		messageId: "a1",
		delta: "Here is the answer.",
	});
	events.push({ type: "TEXT_MESSAGE_END", messageId: "a1" });
	events.push({ type: "RUN_FINISHED", runId: opts.runId });

	// AG-UI wire format: data-only frames, no `event: agent` prefix.
	return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

// ---------------------------------------------------------------------------
// Specs.
// ---------------------------------------------------------------------------

test.describe("AI Assistant reasoning trace", () => {
	test("Documents AI Assistant: reasoning collapsible visible and expandable", async ({
		page,
	}) => {
		const uploadState = createDefaultUploadState();
		await installStoryWorkspaceMocks(page, uploadState);
		await installDocumentMocks(page);

		await page.route("**/api/copilotkit**", async (route) => {
			await route.fulfill({
				status: 200,
				headers: { "content-type": "text/event-stream" },
				body: buildAgUiSseResponse({
					includeReasoning: true,
					runId: "r1",
					threadId: "t1",
				}),
			});
		});

		// Documents route — apps/web/app/(saas)/app/(account)/projects/[id]/documents/[documentId]/page.tsx.
		await page.goto(`/app/projects/${PROJECT_ID}/documents/${DOCUMENT_ID}`);

		// Open AI Assistant sidebar. CopilotSidebar starts collapsed
		// (`defaultOpen={false}` on DocumentEditor), so click the toggle button.
		// CopilotKit renders the toggle with `aria-label="Open Chat"` (verified at
		// node_modules/@copilotkit/react-ui/dist/index.cjs:440-456); the
		// `labels.title = "AI Assistant"` only appears as a non-button div inside
		// the sidebar header once it's already open.
		await page.getByRole("button", { name: /Open Chat/i }).click();

		await page.getByPlaceholder(/Ask|Type/i).fill("How does this work?");
		await page.keyboard.press("Enter");

		const collapsible = page.getByRole("button", {
			name: /Thinking · 4\.2s/,
		});
		await expect(collapsible).toBeVisible();
		await expect(collapsible).toHaveAttribute("aria-expanded", "false");
		await collapsible.click();
		await expect(collapsible).toHaveAttribute("aria-expanded", "true");
		await expect(page.getByText(REASONING_FIXTURE_TEXT)).toBeVisible();
	});

	test("AI Feature Assistant (Stories): reasoning collapsible visible", async ({
		page,
	}) => {
		const uploadState = createDefaultUploadState();
		await installStoryWorkspaceMocks(page, uploadState);

		await page.route("**/api/copilotkit**", async (route) => {
			await route.fulfill({
				status: 200,
				headers: { "content-type": "text/event-stream" },
				body: buildAgUiSseResponse({
					includeReasoning: true,
					runId: "r2",
					threadId: "t2",
				}),
			});
		});

		// Stories route — sidebar is `defaultOpen: true`, so AI Feature
		// Assistant is already visible on load.
		await page.goto(`/app/projects/${PROJECT_ID}/stories/${STORY_ID}`);

		await page.getByPlaceholder(/Ask|Type/i).fill("Help me here.");
		await page.keyboard.press("Enter");

		const collapsible = page.getByRole("button", {
			name: /Thinking · 4\.2s/,
		});
		await expect(collapsible).toBeVisible();
	});

	test("Graceful absence: no reasoningByTurn → no Thinking row, no console errors", async ({
		page,
	}) => {
		const consoleErrors: string[] = [];
		page.on("console", (msg) => {
			if (msg.type() === "error") {
				consoleErrors.push(msg.text());
			}
		});

		const uploadState = createDefaultUploadState();
		await installStoryWorkspaceMocks(page, uploadState);

		await page.route("**/api/copilotkit**", async (route) => {
			await route.fulfill({
				status: 200,
				headers: { "content-type": "text/event-stream" },
				body: buildAgUiSseResponse({
					includeReasoning: false,
					runId: "r3",
					threadId: "t3",
				}),
			});
		});

		await page.goto(`/app/projects/${PROJECT_ID}/stories/${STORY_ID}`);
		await page.getByPlaceholder(/Ask|Type/i).fill("Question.");
		await page.keyboard.press("Enter");

		await expect(page.getByText("Here is the answer.")).toBeVisible();
		await expect(page.getByText(/Thinking/i)).not.toBeVisible();
		// Only assert against errors from the reasoning code paths. A blanket
		// `toEqual([])` would fail on unrelated dev-mode noise (Next.js hydration
		// warnings, optional-endpoint 404s, React strict-mode double-mount, etc.)
		// while still catching real regressions in the reasoning surface.
		const reasoningErrors = consoleErrors.filter(
			(err) =>
				err.includes("reasoning") ||
				err.includes("ReasoningCollapsible") ||
				err.includes("reasoningByTurn"),
		);
		expect(reasoningErrors).toEqual([]);
	});
});
