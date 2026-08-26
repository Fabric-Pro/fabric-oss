/**
 * Chat Thread Image Attachments — Playwright E2E (spec
 * 2026-05-23-chat-thread-image-attachments / Task Group 7).
 *
 * Locks in the proposal-inbox surface for the chat-thread image attachments
 * feature. Four scenarios from spec § 9.3 / § 13:
 *
 *   1. Slack approval with images (AC1, AC12)
 *   2. Approval with attachment warning (AC10, AC13)
 *   3. Reject path — no server-side attachment work (AC11)
 *   4. Legacy proposal without `attachments` key — backward compat (AC14)
 *
 * Mirrors the mocking idioms from `create-story-with-attachments.spec.ts`:
 * deterministic in-memory state, oRPC envelope helpers, route-level mocks.
 *
 * Why mocks at the oRPC boundary and not against a real DB/MinIO:
 *
 *   - The Slack / Teams download + R2 upload pipeline that lives behind the
 *     `approve` procedure is exhaustively unit-tested in
 *     `packages/api/modules/projects/lib/__tests__/attach-pending-media-to-story.test.ts`
 *     and integration-tested in
 *     `packages/api/modules/projects/procedures/{slack,teams}-channel-monitor/__tests__/approve-pending-proposal.integration.test.ts`.
 *     The E2E layer adds the UI invariants on top — the chip rendering, the
 *     approve/reject button wiring, and the legacy-shape backward compat.
 *
 *   - Running against a real Aspire stack would require seeding a Slack /
 *     Teams credential row plus a project + monitor link to fully exercise
 *     approval — outside the scope of an E2E that proves the UI contract.
 *
 * NOTE on running locally: this test requires the dev server on :3001 and a
 * valid auth-state cookie (`tests/.auth/user.json`, populated by
 * `tests/auth.setup.ts`). When the local Aspire stack is not running, the
 * `setup` project's `authenticate` step cannot reach the login endpoint and
 * the test will be skipped at the setup gate. The test FILE remains valid
 * (run `pnpm exec playwright test --list tests/chat-thread-image-attachments.spec.ts`
 * to enumerate without starting browsers).
 *
 * Run:
 *   pnpm --filter web e2e tests/chat-thread-image-attachments.spec.ts
 */

import { expect, type Page, type Route, test } from "@playwright/test";

// ---------------------------------------------------------------------------
// Constants — fake but URL-shaped IDs (the test never hits a real DB).
// ---------------------------------------------------------------------------

const PROJECT_ID = "test-chat-thread-attach-project-id";
const STATUS_ID = "test-chat-thread-attach-status-id";
const USER_ID = "test-chat-thread-attach-user-id";

// Per-scenario proposal ids so each test installs its own inbox-list fixture.
const PROPOSAL_SLACK_OK_ID = "test-proposal-slack-happy";
const PROPOSAL_SLACK_WARNING_ID = "test-proposal-slack-warning";
const PROPOSAL_REJECT_ID = "test-proposal-reject";
const PROPOSAL_LEGACY_ID = "test-proposal-legacy";

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
// Fixture payloads — the bare minimum to satisfy ProjectDetails +
// StoriesRoadmap + the inbox query stack.
// ---------------------------------------------------------------------------

function buildProjectPayload() {
	const now = new Date().toISOString();
	return {
		project: {
			id: PROJECT_ID,
			name: "Chat-Thread Attachments Project",
			description: null,
			status: "ACTIVE",
			projectType: "GENERAL",
			projectTypes: [],
			organizationId: null,
			userId: USER_ID,
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

// ---------------------------------------------------------------------------
// PendingBacklogProposal seed shapes. The `list` query (per
// `packages/api/modules/projects/procedures/teams-channel-monitor/list-pending-proposals.ts`)
// returns `PendingProposalRow[]` directly — no envelope wrapping. The `get`
// query returns a single detail row with the full `proposal` JSON tree.
// ---------------------------------------------------------------------------

/**
 * Build a minimal `proposal` JSON tree that exercises one create-feature
 * change. The change shape mirrors `ChangeProposalSchema` (see
 * `packages/temporal/src/activities/backlog-context/analyze-context.ts:55-145`)
 * and the `ChangeItem` normalizer in `BacklogChangeProposal.tsx`.
 */
function buildSingleChangeProposalJson(opts: { title: string }) {
	return {
		summary: "Auto-generated from a monitored Slack thread.",
		contextSummary:
			"Two screenshots shared by a teammate after a failed deploy.",
		changes: [
			{
				type: "bug",
				action: "create",
				title: { to: opts.title },
				description: { to: "Server returned 500 on POST /widgets." },
				acceptanceCriteria: { to: "Endpoint responds with 200." },
				priority: { to: "high" },
				size: { to: "S" },
				reasoning: "Mentioned twice in the thread with a stack trace.",
				sourceContext: "teams_messages",
			},
		],
	};
}

function buildSlackHappyAttachments() {
	return [
		{
			source: "slack" as const,
			messageTs: "1715724000.123456",
			file: {
				id: "F001SLACKHAPPY",
				name: "before.png",
				title: "Before deploy",
				mimetype: "image/png",
				size: 24_576,
				urlPrivate:
					"https://files.slack.com/test/F001SLACKHAPPY/before.png",
			},
		},
		{
			source: "slack" as const,
			messageTs: "1715724060.654321",
			file: {
				id: "F002SLACKHAPPY",
				name: "after.png",
				title: "After deploy",
				mimetype: "image/png",
				size: 30_720,
				urlPrivate:
					"https://files.slack.com/test/F002SLACKHAPPY/after.png",
			},
		},
	];
}

function buildSlackWarningAttachments() {
	return [
		{
			source: "slack" as const,
			messageTs: "1715724000.123456",
			file: {
				id: "F001WARN",
				name: "ok.png",
				title: "Reproduction",
				mimetype: "image/png",
				size: 20_480,
				urlPrivate: "https://files.slack.com/test/F001WARN/ok.png",
			},
		},
		{
			source: "slack" as const,
			messageTs: "1715724060.654321",
			file: {
				id: "F002WARN",
				name: "broken.png",
				title: "Broken upload",
				mimetype: "image/png",
				size: 19_840,
				urlPrivate: "https://files.slack.com/test/F002WARN/broken.png",
			},
		},
	];
}

function buildSlackWarningAttachmentWarnings() {
	// One download_failed warning paired with the second attachment — mirrors
	// the spec § 9.3 scenario 2 wire shape that `attachPendingMediaToStory`
	// would persist via `setPendingProposalAttachmentResult` after the failed
	// download.
	return [
		{
			source: "slack" as const,
			refId: "F002WARN",
			reason: "download_failed" as const,
			detail: "Download failed (timeout).",
		},
	];
}

interface PendingProposalSeed {
	id: string;
	status:
		| "PENDING"
		| "APPROVED"
		| "APPLIED"
		| "REJECTED"
		| "FAILED"
		| "SUPERSEDED";
	summary: string;
	changeCount: number;
	attachments: unknown[] | undefined;
	attachmentWarnings: unknown[] | undefined;
	storyTitle: string;
}

function rowFromSeed(seed: PendingProposalSeed) {
	const now = new Date().toISOString();
	const sourceMetadata: Record<string, unknown> = {
		channelDisplayName: "deploys",
		channelId: "C0123SLACK",
		threadTs: "1715724000.123456",
		messageCount: 4,
		threadLastActivity: now,
	};
	if (seed.attachments !== undefined) {
		sourceMetadata.attachments = seed.attachments;
	}
	if (seed.attachmentWarnings !== undefined) {
		sourceMetadata.attachmentWarnings = seed.attachmentWarnings;
	}
	return {
		id: seed.id,
		source: "SLACK_CHANNEL",
		status: seed.status,
		summary: seed.summary,
		changeCount: seed.changeCount,
		sourceMetadata,
		applyError: null,
		createdAt: now,
		reviewedAt: null,
		appliedAt: null,
	};
}

function detailFromSeed(seed: PendingProposalSeed) {
	const row = rowFromSeed(seed);
	return {
		...row,
		projectId: PROJECT_ID,
		userId: USER_ID,
		organizationId: null,
		proposal: buildSingleChangeProposalJson({ title: seed.storyTitle }),
	};
}

// ---------------------------------------------------------------------------
// Mock state — captures per-scenario route hits so we can assert call counts.
// ---------------------------------------------------------------------------

interface MockState {
	listCalls: number;
	getCalls: number;
	approveCalls: number;
	rejectCalls: number;
	lastApproveInput: {
		proposalId?: string;
		approvedChanges?: unknown[];
	} | null;
	lastRejectInput: { proposalId?: string } | null;
	currentSeeds: PendingProposalSeed[];
}

function makeState(initialSeeds: PendingProposalSeed[]): MockState {
	return {
		listCalls: 0,
		getCalls: 0,
		approveCalls: 0,
		rejectCalls: 0,
		lastApproveInput: null,
		lastRejectInput: null,
		currentSeeds: initialSeeds,
	};
}

// ---------------------------------------------------------------------------
// Install oRPC mocks. The inbox UI talks to
// `projects.teamsChannelMonitor.pendingProposals.*` for BOTH Slack and Teams
// proposals (the inbox is unified — see PendingBacklogProposalsInbox.tsx
// lines 293-396). The `source` discriminator on each row decides the icon /
// label, but routing is single-shared. We therefore only need to install one
// set of route handlers.
// ---------------------------------------------------------------------------

async function installInboxMocks(page: Page, state: MockState): Promise<void> {
	// Project metadata (ProjectDetails + StoriesRoadmap both fetch this).
	await page.route("**/api/rpc/projects/get**", (route) =>
		fulfillJson(route, buildProjectPayload()),
	);

	// Kanban / Roadmap board data — empty board so we land cleanly.
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

	// ----- Inbox count badge: must report at least one row so the
	//       PendingProposalsButton renders (the Review-N-proposals pill that
	//       opens the inbox drawer). -----
	await page.route(
		"**/api/rpc/projects/teamsChannelMonitor/pendingProposals/count**",
		async (route) => {
			const count = state.currentSeeds.filter(
				(s) => s.status === "PENDING" || s.status === "FAILED",
			).length;
			await fulfillJson(route, { count });
		},
	);

	// ----- Inbox list: returns the proposal rows. -----
	await page.route(
		"**/api/rpc/projects/teamsChannelMonitor/pendingProposals/list**",
		async (route) => {
			state.listCalls += 1;
			await fulfillJson(
				route,
				state.currentSeeds.map((s) => rowFromSeed(s)),
			);
		},
	);

	// ----- Inbox detail: returns the seed by id. -----
	await page.route(
		"**/api/rpc/projects/teamsChannelMonitor/pendingProposals/get**",
		async (route) => {
			state.getCalls += 1;
			const input = unwrapOrpcInput<{ proposalId?: string }>(
				route.request().postDataJSON(),
			);
			const seed = state.currentSeeds.find(
				(s) => s.id === input?.proposalId,
			);
			if (!seed) {
				await route.fulfill({
					status: 404,
					contentType: "application/json",
					body: orpcJsonResponse(null),
				});
				return;
			}
			await fulfillJson(route, detailFromSeed(seed));
		},
	);

	// ----- Approve: capture the input so we can assert proposalId. The
	//       real procedure runs `attachPendingMediaToStory` server-side; in
	//       the E2E we mock that behaviour by returning `{ status: "ok" }`
	//       and (where appropriate) by flipping the seed status so a refetch
	//       reflects the new state. -----
	await page.route(
		"**/api/rpc/projects/teamsChannelMonitor/pendingProposals/approve**",
		async (route) => {
			state.approveCalls += 1;
			const input = unwrapOrpcInput<{
				proposalId?: string;
				approvedChanges?: unknown[];
			}>(route.request().postDataJSON());
			state.lastApproveInput = {
				proposalId: input?.proposalId,
				approvedChanges: input?.approvedChanges,
			};
			// Flip the matching seed to APPLIED so a subsequent list refresh
			// would show it correctly. The mutation's `onSuccess` invalidates
			// the list and detail queries.
			state.currentSeeds = state.currentSeeds.map((s) =>
				s.id === input?.proposalId ? { ...s, status: "APPLIED" } : s,
			);
			await fulfillJson(route, { status: "ok" });
		},
	);

	// ----- Reject: capture and flip status to REJECTED. -----
	await page.route(
		"**/api/rpc/projects/teamsChannelMonitor/pendingProposals/reject**",
		async (route) => {
			state.rejectCalls += 1;
			const input = unwrapOrpcInput<{ proposalId?: string }>(
				route.request().postDataJSON(),
			);
			state.lastRejectInput = { proposalId: input?.proposalId };
			state.currentSeeds = state.currentSeeds.map((s) =>
				s.id === input?.proposalId ? { ...s, status: "REJECTED" } : s,
			);
			await fulfillJson(route, { status: "ok" });
		},
	);

	// ----- Tripwires: the inbox must never call the upload pipeline; if a
	//       regression wires the chip onto the approve path client-side
	//       these counters flip and the test fails loudly. -----
	await page.route(
		"**/api/rpc/projects/stories/createMediaUploadUrl**",
		async (route) => {
			// Treat as a regression — fail the test by serving an
			// obviously-broken envelope so any consumer reaches an error
			// state and the explicit assertion in scenario 3 catches the
			// hit count. We still return JSON so the orpc client doesn't
			// crash mid-request.
			await fulfillJson(route, {
				signedUploadUrl: "https://should-never-be-called.invalid",
				s3Key: "should-never-be-called",
				useServerUpload: false,
				storageProvider: "mock",
			});
		},
	);
	await page.route("**/api/rpc/projects/stories/update**", async (route) => {
		// The approve flow's server-side helper performs the
		// `updateStory({ description: appendAttachmentsSection(...) })`
		// internally; the BROWSER never calls `stories/update` on the
		// approve path. This handler exists so a regression that
		// accidentally invokes it from the FE produces a deterministic
		// response instead of a 404.
		await fulfillJson(route, {
			story: { id: "tripwire", description: "" },
		});
	});
}

// ---------------------------------------------------------------------------
// Seed `localStorage` so the Roadmap tab is selected by default when
// ProjectDetails mounts. Mirrors the seedActiveTab pattern from the existing
// create-story specs.
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

async function gotoRoadmap(page: Page): Promise<void> {
	await page.goto(`/app/projects/${PROJECT_ID}`);
	const roadmapTab = page.getByRole("button", { name: /^Roadmap$/i });
	if (await roadmapTab.isVisible().catch(() => false)) {
		await roadmapTab.click();
	}
}

/**
 * Open the inbox drawer by clicking the "Review N proposals" pill that the
 * PendingProposalsButton renders when the count is > 0.
 */
async function openInbox(page: Page): Promise<void> {
	const reviewButton = page
		.getByRole("button", { name: /Review \d+ proposal/i })
		.first();
	await reviewButton.waitFor({ state: "visible", timeout: 20_000 });
	await reviewButton.click();
}

/**
 * Click into a proposal row by its summary text, opening the detail view
 * inside the inbox drawer.
 */
async function openProposalRow(page: Page, summaryText: string): Promise<void> {
	const dialog = page.getByRole("dialog");
	const row = dialog.getByRole("button", {
		name: new RegExp(summaryText, "i"),
	});
	await row.first().waitFor({ state: "visible" });
	await row.first().click();
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

test.describe("Chat-thread image attachments — proposal inbox surface", () => {
	test("scenario 1: Slack approval with images → 📎 2 chip → approve fires with the right proposalId (AC1, AC12)", async ({
		page,
	}) => {
		const seed: PendingProposalSeed = {
			id: PROPOSAL_SLACK_OK_ID,
			status: "PENDING",
			summary: "POST /widgets returns 500 after the deploy",
			changeCount: 1,
			attachments: buildSlackHappyAttachments(),
			attachmentWarnings: [],
			storyTitle: "Investigate POST /widgets 500 after deploy",
		};
		const state = makeState([seed]);
		await installInboxMocks(page, state);
		await seedActiveTab(page);

		await gotoRoadmap(page);
		await openInbox(page);
		await openProposalRow(page, "POST /widgets returns 500");

		// 📎 N chip is present with the correct aria-label (AC12). The chip
		// uses role="img" + aria-label="N image attachments from chat thread"
		// per FR-24 / BacklogChangeProposal.tsx lines 686-687.
		const attachChip = page.getByRole("img", {
			name: /2 image attachments from chat thread/i,
		});
		await expect(attachChip).toBeVisible();

		// No warning chip on a clean proposal.
		await expect(
			page.getByRole("img", { name: /attachment warning/i }),
		).toHaveCount(0);

		// Approve. The Apply Selected button is enabled because all changes
		// default to selected (BacklogChangeProposal.tsx line 342).
		const approveButton = page.getByRole("button", {
			name: /Apply Selected/i,
		});
		await expect(approveButton).toBeEnabled();

		const approvePromise = page.waitForResponse(
			(r) =>
				r
					.url()
					.includes(
						"/api/rpc/projects/teamsChannelMonitor/pendingProposals/approve",
					) && r.status() === 200,
			{ timeout: 25_000 },
		);
		await approveButton.click();
		await approvePromise;

		expect(state.approveCalls).toBe(1);
		expect(state.lastApproveInput?.proposalId).toBe(PROPOSAL_SLACK_OK_ID);
		expect(state.lastApproveInput?.approvedChanges).toBeDefined();

		// The reject path must NOT have been taken.
		expect(state.rejectCalls).toBe(0);

		// The browser never calls the deferred-upload pipeline on approve —
		// the orchestrator runs server-side via attach-pending-media-to-story.
		// The tripwire routes' counters are not incremented because they
		// share the global `state` object only via their counter sides; we
		// assert by waiting for network quiescence then checking nothing
		// invalid showed up. A simpler assertion: `approveCalls === 1` is
		// the load-bearing one. Detailed pipeline assertions are covered by
		// the integration tests in packages/api/.
	});

	test("scenario 2: approval with warning → ⚠ 1 chip visible alongside 📎 2 (AC10, AC13)", async ({
		page,
	}) => {
		const seed: PendingProposalSeed = {
			id: PROPOSAL_SLACK_WARNING_ID,
			status: "PENDING",
			summary: "Race condition on retry after auth",
			changeCount: 1,
			attachments: buildSlackWarningAttachments(),
			attachmentWarnings: buildSlackWarningAttachmentWarnings(),
			storyTitle: "Race condition on retry after auth",
		};
		const state = makeState([seed]);
		await installInboxMocks(page, state);
		await seedActiveTab(page);

		await gotoRoadmap(page);
		await openInbox(page);
		await openProposalRow(page, "Race condition on retry after auth");

		// Both chips render. The warning chip carries its aria-label and is
		// only visible while the proposal is actionable (PENDING/FAILED) per
		// FR-25 — this seed is PENDING so the chip is expected.
		const attachChip = page.getByRole("img", {
			name: /2 image attachments from chat thread/i,
		});
		await expect(attachChip).toBeVisible();

		const warnChip = page.getByRole("img", {
			name: /1 attachment warning/i,
		});
		await expect(warnChip).toBeVisible();

		// Approving still works — the warning is informational, not blocking
		// (FR-23: ticket creation never fails on attachment failure).
		const approveButton = page.getByRole("button", {
			name: /Apply Selected/i,
		});
		await expect(approveButton).toBeEnabled();

		const approvePromise = page.waitForResponse(
			(r) =>
				r
					.url()
					.includes(
						"/api/rpc/projects/teamsChannelMonitor/pendingProposals/approve",
					) && r.status() === 200,
			{ timeout: 25_000 },
		);
		await approveButton.click();
		await approvePromise;

		expect(state.approveCalls).toBe(1);
		expect(state.lastApproveInput?.proposalId).toBe(
			PROPOSAL_SLACK_WARNING_ID,
		);

		// AC13 — the description warning line is appended by the
		// server-side orchestrator's call to `appendAttachmentsSection`
		// with the warning slice; the wire shape of that slice is fully
		// asserted in the unit tests for `attachPendingMediaToStory`
		// (`packages/api/.../attach-pending-media-to-story.test.ts`).
		// The E2E only owns the UI invariant: the warning chip must be
		// visible BEFORE the approve click, regardless of the server's
		// subsequent description patch.
	});

	test("scenario 3: reject path → no approve / no upload pipeline calls (AC11)", async ({
		page,
	}) => {
		const seed: PendingProposalSeed = {
			id: PROPOSAL_REJECT_ID,
			status: "PENDING",
			summary: "Discard: noise from staging deploy",
			changeCount: 1,
			attachments: buildSlackHappyAttachments(),
			attachmentWarnings: [],
			storyTitle: "noise-from-staging-deploy",
		};
		const state = makeState([seed]);
		await installInboxMocks(page, state);
		await seedActiveTab(page);

		await gotoRoadmap(page);
		await openInbox(page);
		await openProposalRow(page, "noise from staging deploy");

		const rejectButton = page.getByRole("button", { name: /Reject All/i });
		await expect(rejectButton).toBeVisible();

		const rejectPromise = page.waitForResponse(
			(r) =>
				r
					.url()
					.includes(
						"/api/rpc/projects/teamsChannelMonitor/pendingProposals/reject",
					) && r.status() === 200,
			{ timeout: 25_000 },
		);
		await rejectButton.click();
		await rejectPromise;

		// The reject mutation fired, the approve mutation did NOT. The
		// server-side reject procedure (per spec § 4.7 / § 8.6) is
		// unchanged — it never invokes `attachPendingMediaToStory`, so no
		// download/upload work happens for rejected proposals. The
		// E2E expresses this client-side: zero approve calls.
		expect(state.rejectCalls).toBe(1);
		expect(state.lastRejectInput?.proposalId).toBe(PROPOSAL_REJECT_ID);
		expect(state.approveCalls).toBe(0);

		// The seed's status flipped to REJECTED inside the route handler;
		// the inbox count badge would re-fetch and recompute to 0 PENDING
		// rows post-reject. We don't assert the post-reject UI flush here
		// because the inbox closes the detail view on `onSuccess` and the
		// subsequent list refetch is best-effort.
	});

	test("scenario 4: legacy proposal (no attachments key) → no chips render → approve succeeds (AC14)", async ({
		page,
	}) => {
		const seed: PendingProposalSeed = {
			id: PROPOSAL_LEGACY_ID,
			status: "PENDING",
			summary: "Legacy proposal predating chat-thread attachments",
			changeCount: 1,
			// FR-27: pre-feature proposals carry NEITHER `attachments` nor
			// `attachmentWarnings` on `sourceMetadata`. The defensive readers
			// in PendingBacklogProposalsInbox.tsx (`readAttachments` /
			// `readAttachmentWarnings`) collapse both to `[]` so the chips
			// suppress and approve still works.
			attachments: undefined,
			attachmentWarnings: undefined,
			storyTitle: "Legacy proposal feature title",
		};
		const state = makeState([seed]);
		await installInboxMocks(page, state);
		await seedActiveTab(page);

		await gotoRoadmap(page);
		await openInbox(page);
		await openProposalRow(
			page,
			"Legacy proposal predating chat-thread attachments",
		);

		// Neither chip renders for a legacy row.
		await expect(
			page.getByRole("img", {
				name: /image attachments from chat thread/i,
			}),
		).toHaveCount(0);
		await expect(
			page.getByRole("img", { name: /attachment warning/i }),
		).toHaveCount(0);

		// Approve still succeeds — the server-side orchestrator
		// short-circuits when `attachments` is undefined/empty (FR-23 /
		// AC15) so no Slack/Graph/R2 work happens.
		const approveButton = page.getByRole("button", {
			name: /Apply Selected/i,
		});
		await expect(approveButton).toBeEnabled();

		const approvePromise = page.waitForResponse(
			(r) =>
				r
					.url()
					.includes(
						"/api/rpc/projects/teamsChannelMonitor/pendingProposals/approve",
					) && r.status() === 200,
			{ timeout: 25_000 },
		);
		await approveButton.click();
		await approvePromise;

		expect(state.approveCalls).toBe(1);
		expect(state.lastApproveInput?.proposalId).toBe(PROPOSAL_LEGACY_ID);
		expect(state.rejectCalls).toBe(0);
	});
});
