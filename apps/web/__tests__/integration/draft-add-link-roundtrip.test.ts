/**
 * Integration tests for the Unified Context Uploader Wizard's DRAFT
 * project surface (spec
 * `fabric/specs/2026-05-23-unified-context-uploader-wizard/spec.md` §13.2,
 * tasks.md Group 12).
 *
 * Three end-to-end scenarios exercise the API + DB contract that the
 * unit-test files in earlier groups intentionally mock:
 *
 *   12.1 DRAFT autosave → add-link round-trip. Wizard creates a DRAFT
 *        Project via `saveDraftProject`, the dialog submits a Link via
 *        `processLink`, and a `ProjectContext` row lands on the DRAFT
 *        with `extractionStatus = EXTRACTING`. The DRAFT's `projectId`
 *        is the row's parent (no stray rows on the legacy
 *        `WizardTempContext` buffer).
 *
 *   12.2 DRAFT activation preserves context rows. Three rows
 *        (LINK / TEXT / INTEGRATION) are written against a DRAFT, then
 *        `create-project.ts` flips the DRAFT to ACTIVE (AC2 — in-place
 *        status flip, not a row move). All three rows survive with the
 *        same `projectId`.
 *
 *   12.3 `cancelDraftCrawls` happy path. DRAFT with three LINK rows in
 *        EXTRACTING → procedure invocation → mocked Temporal `cancel()`
 *        fires 3× → ZERO `Notification` rows inserted (spec §6.4 silent
 *        contract). The finalize step (which would flip status to
 *        CANCELLED) is left to the workflow itself — this test asserts
 *        the procedure's contract, not the workflow's.
 *
 * # Skip gate
 *
 * Real Postgres only. The default Vitest CI workflow sets
 * `DATABASE_URL='postgresql://test:test@localhost:5432/test'` so the
 * `@repo/database` Prisma singleton can initialize, but the URL is
 * intentionally never connected to. We mirror the gate used by
 * `packages/database/__tests__/notification-context-indexing-categories.test.ts`
 * — checking for both presence AND a non-placeholder value — so CI skips
 * cleanly while local contributors (Aspire-spun-up dev DB) run the suite
 * end-to-end.
 *
 * Locally:
 *   pnpm --filter web test __tests__/integration/draft-add-link-roundtrip.test.ts
 *
 * # Temporal boundary
 *
 * The point of these tests is the API + DB integration. Temporal is
 * mocked at the `getTemporalClient` boundary so the suite does not need
 * a Temporal frontend or worker — that coverage lives in the dedicated
 * Temporal integration suite (Group 13). We assert the calls our
 * procedures make to Temporal (workflow start / cancel / schedule
 * create) match the contract, not Temporal's own execution.
 */

import { randomUUID } from "node:crypto";
import { cancelDraftCrawlsProcedure } from "@repo/api/modules/projects/procedures/contexts/cancel-draft-crawls";
import { processContextLinkProcedure } from "@repo/api/modules/projects/procedures/contexts/process-context-link";
import { createProjectProcedure } from "@repo/api/modules/projects/procedures/create-project";
import { saveDraftProjectProcedure } from "@repo/api/modules/projects/procedures/save-draft-project";
import { db, Prisma } from "@repo/database";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// ─────────────────────────────────────────────────────────────────────
// Skip gate — mirror packages/database/__tests__/_helpers/db-availability.ts.
// Duplicated here (instead of importing) because `apps/web` is a separate
// vitest project and the helper is not exported from `@repo/database`.
// Keep this in sync with the source helper if the placeholder ever changes.
// ─────────────────────────────────────────────────────────────────────

const CI_PLACEHOLDER_DATABASE_URLS: ReadonlySet<string> = new Set([
	"postgresql://test:test@localhost:5432/test",
]);

function hasReachableDatabaseUrl(): boolean {
	const url = process.env.DATABASE_URL;
	if (!url) {
		return false;
	}
	if (CI_PLACEHOLDER_DATABASE_URLS.has(url)) {
		return false;
	}
	return true;
}

// ─────────────────────────────────────────────────────────────────────
// Temporal boundary — mock the client so workflow.start / getHandle /
// schedule.create don't reach across to a real Temporal frontend. These
// mocks capture the *call* shape (workflow name, args, workflowId) so
// tests can assert the procedure invoked Temporal correctly; they do
// NOT exercise Temporal's own execution path.
// ─────────────────────────────────────────────────────────────────────

const mockWorkflowStart = vi.fn();
const mockWorkflowCancel = vi.fn();
const mockGetHandle = vi.fn();
const mockScheduleCreate = vi.fn();

vi.mock("@repo/temporal", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/temporal")>(
			"@repo/temporal",
		);
	return {
		...actual,
		getTemporalClient: vi.fn(async () => ({
			workflow: {
				start: mockWorkflowStart,
				getHandle: mockGetHandle,
			},
		})),
		getScheduleClient: vi.fn(async () => ({
			create: mockScheduleCreate,
		})),
	};
});

// ─────────────────────────────────────────────────────────────────────
// Decrypt mock — the real decryptApiKey lives in @repo/utils and reads
// a runtime secret. Override to deterministic so tests don't depend on
// the host env owning ENCRYPTION_KEY.
// ─────────────────────────────────────────────────────────────────────

vi.mock("@repo/utils", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/utils")>("@repo/utils");
	return {
		...actual,
		decryptApiKey: (value: string) => `decrypted-${value}`,
	};
});

// ─────────────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────────────

const RUN_ID = `${Date.now()}-${process.pid}`;
const USER_ID = `test-wizard-integ-user-${RUN_ID}`;
const USER_EMAIL = `${USER_ID}@test.com`;

// `processContextLink` expects a search-provider row to clear the
// pre-flight gate. We seed one Firecrawl row for the test user (personal
// context — no org-scoped row needed). `encryptedApiKey` is a sentinel
// the mocked `decryptApiKey` echoes back; nothing actually calls
// Firecrawl because the workflow.start mock returns void without
// executing the workflow.
async function seedFirecrawlProvider() {
	await db.userSearchProvider.upsert({
		where: {
			userId_providerName: {
				userId: USER_ID,
				providerName: "firecrawl",
			},
		},
		create: {
			userId: USER_ID,
			providerName: "firecrawl",
			encryptedApiKey: "fc-key-fixture",
			enabled: true,
			isDefault: true,
			priority: 100,
		},
		update: {
			enabled: true,
			encryptedApiKey: "fc-key-fixture",
		},
	});
}

// Direct handler invocation pattern — the same idea as the unit tests
// in `packages/api/modules/projects/procedures/contexts/__tests__/`,
// except those mock the oRPC builder. Here the real builder is used, so
// the handler lives on the procedure's `"~orpc"` definition (the shape
// the other DB-backed tests read, e.g.
// `packages/api/__tests__/mcp-tenant-isolation.test.ts`). We drive the
// handlers as pure functions of `{input, context}`; the
// `context.user`/`context.session` shape mirrors what
// `tenantProtectedProcedure` synthesises in production.
const personalCtx = {
	user: { id: USER_ID },
	session: { activeOrganizationId: undefined as string | undefined },
};

type SaveDraftHandler = (args: {
	input: Record<string, unknown>;
	context: typeof personalCtx;
}) => Promise<{
	project: { id: string; name: string; draftKey: string };
	created: boolean;
}>;

type ProcessLinkHandler = (args: {
	input: Record<string, unknown>;
	context: typeof personalCtx;
}) => Promise<{ contextId: string; status: "EXTRACTING" }>;

type CreateProjectHandler = (args: {
	input: Record<string, unknown>;
	context: typeof personalCtx;
}) => Promise<{ project: { id: string; status: string } }>;

type CancelDraftCrawlsHandler = (args: {
	input: { projectId: string; organizationId?: string | null };
	context: typeof personalCtx;
}) => Promise<{
	cancelledCount: number;
	skippedTerminalCount: number;
	errors: Array<{ contextId: string; message: string }>;
}>;

type OrpcProcedure<H> = { "~orpc": { handler: H } };

const saveDraftHandler = (
	saveDraftProjectProcedure as unknown as OrpcProcedure<SaveDraftHandler>
)["~orpc"].handler;
const processLinkHandler = (
	processContextLinkProcedure as unknown as OrpcProcedure<ProcessLinkHandler>
)["~orpc"].handler;
const createProjectHandler = (
	createProjectProcedure as unknown as OrpcProcedure<CreateProjectHandler>
)["~orpc"].handler;
const cancelDraftCrawlsHandler = (
	cancelDraftCrawlsProcedure as unknown as OrpcProcedure<CancelDraftCrawlsHandler>
)["~orpc"].handler;

// ─────────────────────────────────────────────────────────────────────
// Cleanup helper — tear down everything created by a single test run,
// in FK-safe order. Notifications first (FK → user), then contexts
// (FK → project), then projects (FK → user), then provider rows, then
// the seed user.
// ─────────────────────────────────────────────────────────────────────

async function purgeUserData() {
	await db.notification.deleteMany({ where: { userId: USER_ID } });
	await db.projectContext.deleteMany({ where: { userId: USER_ID } });
	await db.project.deleteMany({ where: { userId: USER_ID } });
	await db.userSearchProvider.deleteMany({ where: { userId: USER_ID } });
}

// ─────────────────────────────────────────────────────────────────────
// Suite — self-skips on the CI placeholder DATABASE_URL.
// ─────────────────────────────────────────────────────────────────────

describe.skipIf(!hasReachableDatabaseUrl())(
	"Wizard integration — DRAFT context surface",
	() => {
		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${USER_ID}, ${USER_EMAIL}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
			await seedFirecrawlProvider();
		});

		beforeEach(async () => {
			// Per-test clean slate — drop projects/contexts/notifications
			// so the previous case's rows don't bleed in. Keep the user +
			// provider row since they're owned by beforeAll.
			await db.notification.deleteMany({ where: { userId: USER_ID } });
			await db.projectContext.deleteMany({ where: { userId: USER_ID } });
			await db.project.deleteMany({ where: { userId: USER_ID } });
			vi.clearAllMocks();
			mockGetHandle.mockReturnValue({ cancel: mockWorkflowCancel });
			mockWorkflowStart.mockResolvedValue(undefined);
			mockWorkflowCancel.mockResolvedValue(undefined);
			mockScheduleCreate.mockResolvedValue({ scheduleId: "sched-test" });
		});

		afterAll(async () => {
			await purgeUserData();
			await db.user.deleteMany({ where: { id: USER_ID } });
		});

		// ─────────────────────────────────────────────────────────────────
		// 12.1 DRAFT autosave → add-link round-trip
		// ─────────────────────────────────────────────────────────────────

		it("12.1 — DRAFT autosave + processLink writes a ProjectContext attached to the DRAFT", async () => {
			// (a) Wizard's first autosave — saveDraftProject creates a row
			//     with status="DRAFT" keyed by the client-generated draftKey.
			const draftKey = randomUUID();
			const draftResult = await saveDraftHandler({
				input: {
					draftKey,
					name: "Test wizard project (12.1)",
				},
				context: personalCtx,
			});
			expect(draftResult.created).toBe(true);
			expect(draftResult.project.id).toBeTruthy();
			const draftProjectId = draftResult.project.id;

			// Confirm the DB row is indeed a DRAFT — the spec's AC2 hinges
			// on the activation flow being an in-place status flip, so the
			// pre-activation row MUST be DRAFT.
			const draftProject = await db.project.findUnique({
				where: { id: draftProjectId },
				select: { id: true, status: true, userId: true },
			});
			expect(draftProject).not.toBeNull();
			expect(draftProject?.status).toBe("DRAFT");
			expect(draftProject?.userId).toBe(USER_ID);

			// (b) Dialog submits a Link — processLink writes a
			//     ProjectContext row against the DRAFT and starts the
			//     (mocked) urlSourceCrawlWorkflow.
			const linkResult = await processLinkHandler({
				input: {
					projectId: draftProjectId,
					url: "https://example.com/docs/integ-12-1",
					scope: "SINGLE_PAGE",
				},
				context: personalCtx,
			});
			expect(linkResult.status).toBe("EXTRACTING");
			expect(linkResult.contextId).toBeTruthy();

			// (c) Polling assertion — the row is parented to the DRAFT and
			//     reports `extractionStatus = EXTRACTING` (the contract the
			//     dialog's poll relies on).
			const contextRow = await db.projectContext.findUnique({
				where: { id: linkResult.contextId },
				select: {
					id: true,
					projectId: true,
					type: true,
					extractionStatus: true,
					urlActiveWorkflowId: true,
					sourceUrl: true,
				},
			});
			expect(contextRow).not.toBeNull();
			expect(contextRow?.projectId).toBe(draftProjectId);
			expect(contextRow?.type).toBe("LINK");
			expect(contextRow?.extractionStatus).toBe("EXTRACTING");
			expect(contextRow?.sourceUrl).toBe(
				"https://example.com/docs/integ-12-1",
			);
			// workflowId stamped so the cancel procedures can look it up.
			expect(contextRow?.urlActiveWorkflowId).toBe(
				`url-crawl-${linkResult.contextId}`,
			);

			// (d) Temporal workflow.start was invoked by name with the
			//     expected workflowId — pins the contract used by the
			//     workflow worker.
			expect(mockWorkflowStart).toHaveBeenCalledTimes(1);
			const [workflowName, options] =
				mockWorkflowStart.mock.calls[0] ?? [];
			expect(workflowName).toBe("urlSourceCrawlWorkflow");
			expect(options).toMatchObject({
				workflowId: `url-crawl-${linkResult.contextId}`,
				taskQueue: "project-documents",
			});
		});

		// ─────────────────────────────────────────────────────────────────
		// 12.2 DRAFT activation preserves context rows
		// ─────────────────────────────────────────────────────────────────

		it("12.2 — create-project activation flips DRAFT → ACTIVE in place; LINK + TEXT + INTEGRATION rows survive", async () => {
			// (a) Seed a DRAFT via saveDraftProject (deterministic draftKey
			//     so we can route createProject to activate it instead of
			//     creating a parallel ACTIVE row).
			const draftKey = randomUUID();
			const { project: draft } = await saveDraftHandler({
				input: {
					draftKey,
					name: "Activation parity (12.2)",
				},
				context: personalCtx,
			});
			const draftProjectId = draft.id;

			// (b) Write LINK + TEXT + INTEGRATION rows directly against the
			//     DRAFT. We bypass the procedures here because the goal of
			//     12.2 is to assert the activation flow's row-preserving
			//     contract — the input shape of each procedure is unit-
			//     tested elsewhere, but only direct Prisma writes lock down
			//     the "same projectId before + after activation" assertion.
			const linkRow = await db.projectContext.create({
				data: {
					projectId: draftProjectId,
					type: "LINK",
					content: "",
					sourceUrl: "https://example.com/12-2-link",
					extractionStatus: "EXTRACTING",
					urlActiveWorkflowId: "wf-12-2-link",
					userId: USER_ID,
				},
			});
			const textRow = await db.projectContext.create({
				data: {
					projectId: draftProjectId,
					type: "TEXT",
					content: "12.2 free-form text context",
					sourceTitle: "12.2 text note",
					extractionStatus: "COMPLETED",
					userId: USER_ID,
				},
			});
			const integrationRow = await db.projectContext.create({
				data: {
					projectId: draftProjectId,
					type: "INTEGRATION",
					content: "",
					extractionStatus: "PENDING",
					metadata: {
						provider: "MICROSOFT_TEAMS",
						chatType: "channel",
						channelId: "ch-12-2",
					},
					userId: USER_ID,
				},
			});

			// Count baseline — three rows on the DRAFT.
			const preCount = await db.projectContext.count({
				where: { projectId: draftProjectId },
			});
			expect(preCount).toBe(3);

			// (c) Activate via the createProject procedure with the same
			//     draftKey. The procedure finds the DRAFT and flips it to
			//     ACTIVE in place (per create-project.ts:117-172) — same
			//     projectId, no row moves on ProjectContext.
			const { project: created } = await createProjectHandler({
				input: {
					name: "Activation parity (12.2)",
					draftKey,
				},
				context: personalCtx,
			});

			// Activation must hit the same project row, not a new one —
			// AC2: "Create Project completes immediately" with the existing
			// DRAFT's context rows.
			expect(created.id).toBe(draftProjectId);
			expect(created.status).toBe("ACTIVE");

			const activated = await db.project.findUnique({
				where: { id: draftProjectId },
				select: { id: true, status: true },
			});
			expect(activated?.status).toBe("ACTIVE");

			// (d) Row-preservation assertion — same three rows, same ids,
			//     same projectId pointer, no extras.
			const postRows = await db.projectContext.findMany({
				where: { projectId: draftProjectId },
				orderBy: { createdAt: "asc" },
				select: {
					id: true,
					projectId: true,
					type: true,
					extractionStatus: true,
				},
			});
			expect(postRows).toHaveLength(3);
			const postIds = new Set(postRows.map((r) => r.id));
			expect(postIds.has(linkRow.id)).toBe(true);
			expect(postIds.has(textRow.id)).toBe(true);
			expect(postIds.has(integrationRow.id)).toBe(true);
			for (const row of postRows) {
				expect(row.projectId).toBe(draftProjectId);
			}
			// Status passthrough — activation should NOT touch
			// extractionStatus on the children.
			const linkAfter = postRows.find((r) => r.id === linkRow.id);
			const textAfter = postRows.find((r) => r.id === textRow.id);
			const integrationAfter = postRows.find(
				(r) => r.id === integrationRow.id,
			);
			expect(linkAfter?.extractionStatus).toBe("EXTRACTING");
			expect(textAfter?.extractionStatus).toBe("COMPLETED");
			expect(integrationAfter?.extractionStatus).toBe("PENDING");
		});

		// ─────────────────────────────────────────────────────────────────
		// 12.3 cancelDraftCrawls happy path — three LINK rows in
		// EXTRACTING, mocked Temporal cancel called 3×, ZERO Notification
		// rows.
		// ─────────────────────────────────────────────────────────────────

		it("12.3 — cancelDraftCrawls cancels 3 in-flight workflows and creates no Notification rows (silent §6.4)", async () => {
			// (a) DRAFT with three LINK rows in EXTRACTING, each carrying a
			//     stamped urlActiveWorkflowId. Direct Prisma writes — this
			//     test asserts the cancel procedure's batch contract, not
			//     processLink's row-creation contract (covered by 12.1).
			const draftKey = randomUUID();
			const { project: draft } = await saveDraftHandler({
				input: {
					draftKey,
					name: "Cancel batch (12.3)",
				},
				context: personalCtx,
			});
			const draftProjectId = draft.id;

			const linkRows = await Promise.all(
				[1, 2, 3].map((i) =>
					db.projectContext.create({
						data: {
							projectId: draftProjectId,
							type: "LINK",
							content: "",
							sourceUrl: `https://example.com/12-3-link-${i}`,
							extractionStatus: "EXTRACTING",
							urlActiveWorkflowId: `wf-12-3-link-${i}`,
							userId: USER_ID,
						},
					}),
				),
			);
			expect(linkRows).toHaveLength(3);

			// Notification baseline — zero rows before the cancel.
			const preNotifCount = await db.notification.count({
				where: { userId: USER_ID },
			});
			expect(preNotifCount).toBe(0);

			// (b) Invoke cancelDraftCrawls. The mocked Temporal client
			//     resolves cancel() without doing anything; the procedure
			//     does NOT flip the row status here — that's the workflow
			//     finalize step's job (covered by Group 13). We're
			//     asserting the orchestration: cancel called once per
			//     candidate row, zero notifications inserted.
			const result = await cancelDraftCrawlsHandler({
				input: { projectId: draftProjectId },
				context: personalCtx,
			});

			expect(result.cancelledCount).toBe(3);
			expect(result.skippedTerminalCount).toBe(0);
			expect(result.errors).toEqual([]);

			// Temporal client received exactly 3 getHandle + cancel calls,
			// one per LINK row. Order isn't load-bearing so we assert the
			// full set of workflowIds.
			expect(mockGetHandle).toHaveBeenCalledTimes(3);
			const calledWorkflowIds = mockGetHandle.mock.calls.map(
				(c) => c[0] as string,
			);
			expect(calledWorkflowIds.sort()).toEqual(
				["wf-12-3-link-1", "wf-12-3-link-2", "wf-12-3-link-3"].sort(),
			);
			expect(mockWorkflowCancel).toHaveBeenCalledTimes(3);

			// (c) §6.4 silent-cancellation contract — ZERO Notification
			//     rows inserted by the cancel path. The CONTEXT_INDEXING_*
			//     notifications fire on workflow start (covered by 12.1's
			//     processLink) and on terminal COMPLETED/FAILED (covered
			//     by emit-completion-notification unit tests); the cancel
			//     path neither inserts nor reads notifications.
			const postNotifCount = await db.notification.count({
				where: { userId: USER_ID },
			});
			expect(postNotifCount).toBe(0);
		});
	},
);
