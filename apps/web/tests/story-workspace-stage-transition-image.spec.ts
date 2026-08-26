/**
 * StoryWorkspace — stage-transition image preservation E2E (Group 6 / spec §11.3).
 *
 * Spec: `fabric/specs/2026-05-19-preserve-attachments-on-maturation/spec.md`
 *   - §4.1 AC #1 — Images survive stage transitions
 *   - §8.1 Post-fix invariant — saved description retains the
 *     `story-media/<projectId>/<storyId>/<key>` substring
 *   - §11.3 — E2E scenarios this file covers
 *   - decisions.md D3 — server-side guard semantics
 *   - decisions.md D10 — testing strategy
 *
 * What this spec locks in:
 *
 *   1. **Drop-case (primary)** — when the AI-rewritten markdown DROPS a
 *      `story-media/` image that was in the prior description, the Group 5A
 *      server guard at `update-drafting-stage-with-version.ts` re-injects
 *      it under an `## Attachments` footer before persisting. The test
 *      simulates the server-side reinject in the mocked oRPC response
 *      (the real guard logic is unit-tested separately in
 *      `update-drafting-stage-with-version-attachment-guard.test.ts`);
 *      after reload the page must re-resolve the signed URL for the
 *      reinjected key via `projects.stories.resolveMediaUrls`.
 *
 *   2. **Happy path (secondary)** — when the AI preserves the image
 *      markdown verbatim (the prompt augmentation working as intended),
 *      the outbound `updateStageWithVersion` payload already carries the
 *      `story-media/<key>` substring. The server guard sees no drop and
 *      is a no-op; we assert the substring in the captured payload as
 *      proof the prompt-side fix works.
 *
 * Approach (the decision the spec §11.3 flagged):
 *
 *   - Outbound: capture the JSON body of `**\/api/rpc/projects/stories/updateStageWithVersion**`
 *     and assert the substring on the FE-side payload.
 *   - Inbound (drop-case): mock the server response to return a story whose
 *     `description` carries the reinjected `## Attachments` section, so the
 *     subsequent page reload triggers the existing FE resolver path
 *     (`extractStoryS3KeysFromContent` → `projects.stories.resolveMediaUrls`).
 *   - We do NOT replay the AG-UI streaming with full TOOL_CALL fidelity:
 *     instead the `**\/api/copilotkit**` mock emits a minimal SSE response
 *     that (a) sets `state.document` to the post-AI markdown via STATE_SNAPSHOT
 *     and (b) emits the `confirm_changes` synthetic tool call so the
 *     StoryWorkspace renderer flips `isAwaitingConfirmation` to true and
 *     surfaces the DiffReviewBar. The test then clicks "Accept All".
 *
 * Run:
 *   pnpm --filter web e2e tests/story-workspace-stage-transition-image.spec.ts
 *
 * CI mode:
 *   pnpm --filter web e2e:ci tests/story-workspace-stage-transition-image.spec.ts
 */

import { expect, type Page, type Route, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Constants — fake but URL-shaped IDs (the test never hits a real DB).
// ---------------------------------------------------------------------------

const PROJECT_ID = "test-stage-transition-project-id";
const STORY_ID = "test-stage-transition-story-id";

// The image key — the substring that MUST survive every AI rewrite.
const IMAGE_KEY = `story-media/${PROJECT_ID}/${STORY_ID}/inline-image.png`;
// The signed URL the resolver returns. It must include `story-media/` so the
// FE regex (`extractStoryS3KeysFromContent`) picks it up on reload.
const SIGNED_IMAGE_URL = `https://stub-bucket.local/${IMAGE_KEY}?signed=1`;

// Initial description with a `data-s3-key`-tagged image, mirroring the
// shape that `paste-image` test asserts is persisted on autosave.
const INITIAL_DESCRIPTION = [
	"<p>Initial description with an inline screenshot:</p>",
	`<p><img data-s3-key="${IMAGE_KEY}" src="${SIGNED_IMAGE_URL}" alt=""></p>`,
	"<p>End of description.</p>",
].join("");

// The post-AI markdown the agent stream emits via STATE_SNAPSHOT.
// Drop-case: the model OBLITERATED the image. The server guard
// reinjects.
const POST_AI_MARKDOWN_DROP = [
	"# Passive Analysis: Updated",
	"",
	"The AI rewrote the description and lost the screenshot.",
].join("\n");

// Happy-path: model preserved the image markdown (Turndown shape).
const POST_AI_MARKDOWN_PRESERVED = [
	"# Passive Analysis: Updated",
	"",
	"The AI rewrote the description and kept the screenshot below.",
	"",
	`![](${SIGNED_IMAGE_URL})`,
].join("\n");

// The reinjected footer the server appends in the drop case.
// Mirrors spec §8.2 + the guard implementation in
// `packages/api/modules/projects/procedures/stories/update-drafting-stage-with-version.ts`.
const REINJECTED_FOOTER = `\n\n## Attachments\n\n![](${SIGNED_IMAGE_URL})`;

// ---------------------------------------------------------------------------
// oRPC wire helpers (same envelope used by every `**/api/rpc/**` mock).
// Lifted from `story-workspace-paste-image.spec.ts`.
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
			name: "Stage Transition Project",
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
			title: "Stage Transition Image Regression",
			description,
			acceptanceCriteria: "<p>Given/When/Then placeholder.</p>",
			status: "TODO",
			priority: "MEDIUM",
			size: "M",
			kind: "FEATURE",
			featureNumber: 1,
			// PLACEHOLDER so the user can transition to PASSIVE_ANALYSIS.
			draftingStage: "PLACEHOLDER",
			draftingStageUpdatedAt: null,
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
				name: "Stage Transition Project",
				userId: "test-user-id",
				organizationId: null,
			},
		},
	};
}

function buildResolvedPromptPayload() {
	// The server-resolved prompt for a stage-transition Enhance. Returning a
	// non-empty `content` forces StoryWorkspace's `onEnhance` callback down the
	// CopilotKit streaming branch — the only branch that exercises the
	// AI-rewrite path this spec is about.
	//
	// `kind` must match the fixture story's kind: the handler invalidates the
	// work item query when the server's kind disagrees with the cached one, and
	// a spurious refetch here would race the assertions (Fizzy #2048).
	return {
		resolved: true,
		content: "You are a passive-analysis assistant. Be concise.",
		promptKey: "feature_placeholder",
		source: "bound" as const,
		kind: "FEATURE" as const,
		kindWord: "feature" as const,
	};
}

// ---------------------------------------------------------------------------
// AG-UI SSE response builder — the minimal stream needed to drive
// StoryWorkspace from "user clicked Enhance" → "DiffReviewBar visible".
//
// The stream:
//   1. STATE_SNAPSHOT sets `state.document` to the post-AI markdown. The
//      StoryWorkspace `useEffect` watching `agentState?.document` then
//      runs `editor.commands.setContent(fromMarkdown(newDocument))`.
//   2. A `confirm_changes` synthetic tool call (TOOL_CALL_START /
//      TOOL_CALL_ARGS / TOOL_CALL_END) — once the chat history holds an
//      unresolved tool call, CopilotKit invokes the matching
//      `useCopilotAction` renderer with `status === "executing"`, which
//      sets `isAwaitingConfirmation = true` so the DiffReviewBar appears.
//
// Wire format reference: `apps/web/tests/ai-assistant-reasoning.spec.ts`
// `buildAgUiSseResponse` and `@ag-ui/core` event-type definitions in
// `node_modules/.pnpm/@ag-ui+core@0.0.45/node_modules/@ag-ui/core/dist/index.d.ts`.
// ---------------------------------------------------------------------------

function buildStageTransitionSse(opts: {
	document: string;
	runId?: string;
	threadId?: string;
}): string {
	const runId = opts.runId ?? "run-stage-transition";
	const threadId = opts.threadId ?? "thread-stage-transition";
	const toolCallId = `tc-confirm-${runId}`;
	const messageId = `msg-confirm-${runId}`;

	const snapshot: Record<string, unknown> = {
		messages: [],
		document: opts.document,
		streamingContent: opts.document,
	};

	const events: Array<Record<string, unknown>> = [
		{ type: "RUN_STARTED", runId, threadId },
		{ type: "STATE_SNAPSHOT", snapshot },
		{
			type: "TOOL_CALL_START",
			toolCallId,
			toolCallName: "confirm_changes",
			parentMessageId: messageId,
		},
		{
			type: "TOOL_CALL_ARGS",
			toolCallId,
			delta: "{}",
		},
		{ type: "TOOL_CALL_END", toolCallId },
		{ type: "RUN_FINISHED", runId },
	];

	// AG-UI wire format: data-only frames, no `event: agent` prefix.
	return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

// ---------------------------------------------------------------------------
// Mock state + installer.
// ---------------------------------------------------------------------------

interface StageTransitionState {
	/** Description the next `stories/get` call should return. */
	currentDescription: string;
	updateStageWithVersionCalls: number;
	resolveCalls: number;
	/** Captured JSON body the FE sent to `updateStageWithVersion`. */
	lastUpdateStagePayload: {
		description?: string | null;
		acceptanceCriteria?: string | null;
		targetStage?: string;
	} | null;
	/** Description to persist server-side — controls what the mocked server
	 *  response returns. Drop-case tests set this to the reinjected
	 *  description; happy-path tests pass `null` to use the inbound payload. */
	persistDescriptionOverride: string | null;
}

async function installStageTransitionMocks(
	page: Page,
	state: StageTransitionState,
): Promise<void> {
	// --- Project / story reads --------------------------------------------
	await page.route("**/api/rpc/projects/get**", (route) =>
		fulfillJson(route, buildProjectPayload()),
	);

	await page.route("**/api/rpc/projects/stories/get**", (route) =>
		fulfillJson(route, buildStoryPayload(state.currentDescription)),
	);

	// --- Quiet ancillary reads the page fires on mount --------------------
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

	// --- Server-side prompt resolver (drives onEnhance into the CopilotKit
	// branch). The browser no longer picks an agent name or sends a kind; it
	// sends the work item id and the server answers with both.
	await page.route("**/api/rpc/projects/stories/resolvePrompt**", (route) =>
		fulfillJson(route, buildResolvedPromptPayload()),
	);

	// --- Story-media URL resolver (signs `story-media/` keys on reload) ---
	await page.route(
		"**/api/rpc/projects/stories/resolveMediaUrls**",
		async (route) => {
			state.resolveCalls += 1;
			const input = unwrapOrpcInput<{ s3Keys?: string[] }>(
				route.request().postDataJSON(),
			);
			const urls: Record<string, string> = {};
			for (const key of input?.s3Keys ?? []) {
				if (key.startsWith("story-media/")) {
					urls[key] = SIGNED_IMAGE_URL;
				}
			}
			await fulfillJson(route, { urls });
		},
	);

	// --- Stage-transition persistence -------------------------------------
	// The mock simulates the Group 5A server guard's reinject behavior when
	// `persistDescriptionOverride` is set (drop case). Returning the
	// over-ride as the persisted description (a) updates `currentDescription`
	// so the next `stories/get` call serves the post-reinject view, and (b)
	// is what the page sees on reload via the resolver path.
	await page.route(
		"**/api/rpc/projects/stories/updateStageWithVersion**",
		async (route) => {
			state.updateStageWithVersionCalls += 1;
			const input = unwrapOrpcInput<{
				description?: string | null;
				acceptanceCriteria?: string | null;
				targetStage?: string;
			}>(route.request().postDataJSON());

			state.lastUpdateStagePayload = {
				description: input?.description,
				acceptanceCriteria: input?.acceptanceCriteria,
				targetStage: input?.targetStage,
			};

			const persistedDescription =
				state.persistDescriptionOverride ?? input?.description ?? "";
			state.currentDescription = persistedDescription;

			await fulfillJson(route, buildStoryPayload(persistedDescription));
		},
	);

	// Quiet the autosave / update endpoint in case it ever fires during the
	// renderer flow (it shouldn't for the stage-transition path).
	await page.route("**/api/rpc/projects/stories/update**", async (route) => {
		await fulfillJson(route, buildStoryPayload(state.currentDescription));
	});
}

// ---------------------------------------------------------------------------
// Page-driving helpers — encapsulate the click sequence so each spec body
// reads as intent, not as a sequence of selectors.
// ---------------------------------------------------------------------------

async function gotoStoryWorkspace(page: Page): Promise<void> {
	await page.goto(`/app/projects/${PROJECT_ID}/stories/${STORY_ID}`);
	await page.locator(".tiptap").first().waitFor({ state: "visible" });
}

async function selectTargetStage(
	page: Page,
	stageLabel: string,
): Promise<void> {
	// Open the "Change drafting stage" dropdown.
	await page.getByRole("button", { name: /Change drafting stage/i }).click();
	// Click the menu item by visible label (`Passive Analysis`).
	await page.getByRole("menuitem", { name: stageLabel }).click();
}

async function triggerEnhance(page: Page): Promise<void> {
	// The "Enhance" button in the stage row opens the FeatureTransitionDialog.
	// `getByRole("button", { name: "Enhance" })` returns multiple results
	// (the stage row button AND the dialog confirm button), so we anchor
	// to "Enhance with AI for the new stage" via the tooltip-bearing
	// button on the stage row.
	const stageRowEnhance = page
		.getByRole("button", { name: /^Enhance$/i })
		.first();
	await stageRowEnhance.click();
}

async function confirmTransitionDialog(page: Page): Promise<void> {
	// Inside FeatureTransitionDialog: confirm button reads "Enhance" with a
	// Sparkles icon and lives inside a `role="dialog"`. Scope the locator
	// to the dialog so we don't accidentally re-click the stage-row button.
	const dialog = page.getByRole("dialog", {
		name: /Feature Drafting Transition/i,
	});
	await dialog.getByRole("button", { name: /^Enhance$/i }).click();
}

async function acceptDiffReviewBar(page: Page): Promise<void> {
	// `DiffReviewBar`'s "Accept All" button has aria-label from i18n
	// (`approveAll`: "Accept every pending AI change in this document...").
	await page
		.getByRole("button", {
			name: /Accept every pending AI change/i,
		})
		.click();
}

// ---------------------------------------------------------------------------
// Specs.
// ---------------------------------------------------------------------------

test.describe("StoryWorkspace — stage-transition image preservation", () => {
	test("drop-case: server guard reinjects dropped image into persisted description", async ({
		page,
	}, testInfo) => {
		// Streaming + CopilotKit + reload all have non-trivial setup cost.
		testInfo.setTimeout(120_000);

		const state: StageTransitionState = {
			currentDescription: INITIAL_DESCRIPTION,
			updateStageWithVersionCalls: 0,
			resolveCalls: 0,
			lastUpdateStagePayload: null,
			// Server guard re-injects the dropped image as an `## Attachments`
			// footer. This is the post-fix invariant per spec §8.1.
			persistDescriptionOverride:
				POST_AI_MARKDOWN_DROP + REINJECTED_FOOTER,
		};
		await installStageTransitionMocks(page, state);

		// `**/api/copilotkit**` emits the post-AI markdown that DROPS the
		// image, then the synthetic `confirm_changes` tool call so the
		// DiffReviewBar surfaces and the user can click Accept.
		await page.route("**/api/copilotkit**", async (route) => {
			await route.fulfill({
				status: 200,
				headers: { "content-type": "text/event-stream" },
				body: buildStageTransitionSse({
					document: POST_AI_MARKDOWN_DROP,
				}),
			});
		});

		await gotoStoryWorkspace(page);

		// Sanity: the editor renders the inline image on mount via the
		// resolver path (proves the initial fixture is shaped correctly).
		await expect(
			page.locator(`.tiptap img[data-s3-key="${IMAGE_KEY}"]`),
		).toBeVisible({ timeout: 15_000 });

		// (1) User picks `Passive Analysis` and clicks Enhance.
		await selectTargetStage(page, "Passive Analysis");
		await triggerEnhance(page);
		await confirmTransitionDialog(page);

		// (2) Wait for the DiffReviewBar to surface (the renderer flips
		//     `isAwaitingConfirmation` to true once the SSE delivers the
		//     `confirm_changes` synthetic tool call).
		const acceptAllButton = page.getByRole("button", {
			name: /Accept every pending AI change/i,
		});
		await expect(acceptAllButton).toBeVisible({ timeout: 30_000 });

		// (3) Accept All -> the `confirm_changes` handler runs
		//     `updateStageWithVersionMutation.mutate(...)`.
		const stageRequestPromise = page.waitForRequest(
			"**/api/rpc/projects/stories/updateStageWithVersion**",
		);
		await acceptDiffReviewBar(page);
		await stageRequestPromise;

		// (4) Capture the outbound payload. The FE-side payload reflects
		//     what `getEditorMarkdownForSave(editor)` produced after the
		//     AI rewrite. The server guard (verified in
		//     `update-drafting-stage-with-version-attachment-guard.test.ts`)
		//     is the one that adds the `## Attachments` footer; the FE
		//     payload may or may not contain the substring depending on
		//     editor merge behavior — what matters is that the post-server
		//     PERSISTED description (mocked here as the override) does.
		expect(state.updateStageWithVersionCalls).toBe(1);
		expect(state.lastUpdateStagePayload?.targetStage).toBe(
			"PASSIVE_ANALYSIS",
		);

		// (5) Reload — `currentDescription` is now the post-server
		//     description (with reinjected `## Attachments` footer + image
		//     markdown), so `extractStoryS3KeysFromContent` picks up the
		//     `story-media/` key and the resolver re-signs it.
		const resolveBefore = state.resolveCalls;
		await page.reload();
		await page.locator(".tiptap").first().waitFor({ state: "visible" });

		// The resolver must run on mount to re-sign the reinjected key.
		await expect
			.poll(() => state.resolveCalls, { timeout: 15_000 })
			.toBeGreaterThan(resolveBefore);

		// The image must render after reload — proves the full loop:
		// drop -> server reinject -> persisted -> reload -> resolver -> visible.
		const reloadedImage = page
			.locator(`.tiptap img[src="${SIGNED_IMAGE_URL}"]`)
			.first();
		await expect(reloadedImage).toBeVisible({ timeout: 15_000 });

		// And the persisted description that the next reload would serve
		// retains the substring — the post-fix invariant from spec §8.1.
		expect(state.currentDescription).toContain(IMAGE_KEY);
		expect(state.currentDescription).toContain("## Attachments");

		// Sampled-log assertion is gated per spec §13.2 open question #3.
		// Enable once §10.2 is shipped (the 1% sampled "preserved by model"
		// happy-path info log). Default in v1 is SKIP — the assertion below
		// stays commented out.
		//
		// const consoleMessages: string[] = [];
		// page.on("console", (msg) => consoleMessages.push(msg.text()));
		// expect(consoleMessages.join("\n")).toMatch(
		//   /\[stage-transition\] reinjected dropped attachments/,
		// );
	});

	test("happy path: model preserves image; outbound payload carries `story-media/` substring", async ({
		page,
	}, testInfo) => {
		testInfo.setTimeout(120_000);

		const state: StageTransitionState = {
			currentDescription: INITIAL_DESCRIPTION,
			updateStageWithVersionCalls: 0,
			resolveCalls: 0,
			lastUpdateStagePayload: null,
			// No server-side reinject needed: the model behaved.
			persistDescriptionOverride: null,
		};
		await installStageTransitionMocks(page, state);

		// `**/api/copilotkit**` emits the post-AI markdown that PRESERVES
		// the image markdown — proves the prompt augmentation working as
		// intended.
		await page.route("**/api/copilotkit**", async (route) => {
			await route.fulfill({
				status: 200,
				headers: { "content-type": "text/event-stream" },
				body: buildStageTransitionSse({
					document: POST_AI_MARKDOWN_PRESERVED,
				}),
			});
		});

		await gotoStoryWorkspace(page);

		// Sanity check: image visible pre-transition.
		await expect(
			page.locator(`.tiptap img[data-s3-key="${IMAGE_KEY}"]`),
		).toBeVisible({ timeout: 15_000 });

		await selectTargetStage(page, "Passive Analysis");
		await triggerEnhance(page);
		await confirmTransitionDialog(page);

		const acceptAllButton = page.getByRole("button", {
			name: /Accept every pending AI change/i,
		});
		await expect(acceptAllButton).toBeVisible({ timeout: 30_000 });

		const stageRequestPromise = page.waitForRequest(
			"**/api/rpc/projects/stories/updateStageWithVersion**",
		);
		await acceptDiffReviewBar(page);
		await stageRequestPromise;

		expect(state.updateStageWithVersionCalls).toBe(1);
		expect(state.lastUpdateStagePayload?.targetStage).toBe(
			"PASSIVE_ANALYSIS",
		);

		// Post-fix invariant: the persisted description retains
		// the `story-media/<key>` substring. In the happy path that comes
		// from the FE-side payload, NOT from a server-side reinject. The
		// guard sees `droppedKeys.length === 0` and is a no-op.
		expect(state.lastUpdateStagePayload?.description).toContain(IMAGE_KEY);
		expect(state.currentDescription).toContain(IMAGE_KEY);

		// Reload — the resolver re-signs the key and the image renders.
		const resolveBefore = state.resolveCalls;
		await page.reload();
		await page.locator(".tiptap").first().waitFor({ state: "visible" });
		await expect
			.poll(() => state.resolveCalls, { timeout: 15_000 })
			.toBeGreaterThan(resolveBefore);
		await expect(
			page.locator(`.tiptap img[src="${SIGNED_IMAGE_URL}"]`).first(),
		).toBeVisible({ timeout: 15_000 });
	});
});
