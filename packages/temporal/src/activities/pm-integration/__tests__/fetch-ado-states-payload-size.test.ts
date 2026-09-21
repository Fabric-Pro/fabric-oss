/**
 * Payload-size regression guard (#1741).
 *
 * The frozen prod poll was caused by `fetchAdoWorkItemStates` packing
 * `title`+`description` for every linked card (~6.48 MB on "Fabric-Main"),
 * blowing past Temporal's 4 MB gRPC limit so the activity return was rejected
 * and reconcile never ran. This test drives BOTH fetch paths (per-ID + ADO
 * batch) with 480 large-description cards and asserts the serialized result is
 * far under the limit and carries NO `title`/`description` — and that every
 * item carries a fetch-time `classification` (so the reconcile divergence gate
 * never fails open for a real poll).
 *
 * Fizzy #2304 adds a third case: the REST-GitLab path with status sync on, at
 * the most verdicts one poll can fetch. Those verdicts carry labels and the
 * issue URL, so the result does NOT fit the switch-on payload budget; that
 * case pins the payload cap's graceful degrade instead of a size ceiling.
 *
 * Run with:
 *   pnpm --filter @repo/temporal test src/activities/pm-integration/__tests__/fetch-ado-states-payload-size.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mockProjectFindUnique = vi.fn();
const mockGetLinkedExternalIds = vi.fn();
const mockFindFabricItemByExternalId = vi.fn();
const mockUpsertPendingChange = vi.fn();
const mockCreatePmSyncConflictNotifications = vi.fn();
const mockUserStoryFindUnique = vi.fn();
const mockFetchPMItemsByIds = vi.fn();
const mockGetWorkItemsByIdsFromPM = vi.fn();
const mockMergePmStatusSyncLastRun = vi.fn();

vi.mock("@repo/database", () => ({
	setAiUsageRecorder: vi.fn(),
	db: {
		project: {
			findMany: vi.fn(),
			update: vi.fn(),
			findUnique: (...args: unknown[]) => mockProjectFindUnique(...args),
		},
		userStory: {
			findUnique: (...args: unknown[]) =>
				mockUserStoryFindUnique(...args),
			update: vi.fn(),
		},
	},
	findFabricItemByExternalId: (...args: unknown[]) =>
		mockFindFabricItemByExternalId(...args),
	getLinkedExternalIds: (...args: unknown[]) =>
		mockGetLinkedExternalIds(...args),
	upsertPendingChange: (...args: unknown[]) =>
		mockUpsertPendingChange(...args),
	createPmSyncConflictNotifications: (...args: unknown[]) =>
		mockCreatePmSyncConflictNotifications(...args),
	applyTerminalClose: vi.fn(),
	applyTerminalUnhide: vi.fn(),
	recordAudit: vi.fn(),
	findFabricItemsByExternalId: vi.fn(),
	incrementMissingStreak: vi.fn(),
	resetMissingStreaks: vi.fn(),
	pendingFlagMissingExists: vi.fn(),
	autoDismissReappearedFlagMissing: vi.fn(),
	clearPendingContentDrift: vi.fn(),
	// Fizzy #2304: the switch-on REST case reaches the D2.6 last-run writer.
	mergePmStatusSyncLastRun: (...args: unknown[]) =>
		mockMergePmStatusSyncLastRun(...args),
}));

const mockRecordPmSyncLog = vi.fn();
vi.mock("../../pm-integration/record-pm-sync-log", () => ({
	recordPmSyncLog: (...args: unknown[]) => mockRecordPmSyncLog(...args),
}));

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

// Fizzy #2304: a pass-through spy on the REAL measure — behaviour unchanged.
// The REST case reads the one call whose argument carries every verdict: the
// untruncated result the payload cap sizes before deciding what to keep, so
// the PR can record what the realistic maximum costs untruncated.
vi.mock("../../../lib/payload-size-guard", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("../../../lib/payload-size-guard")
		>();
	return {
		...actual,
		measureSerializedBytes: vi.fn(actual.measureSerializedBytes),
	};
});

// Inlined copies of the real (pure) helpers — keep in sync with story-sync.ts.
function _extractItemState(
	rec: Record<string, unknown>,
	fields: Record<string, unknown> | undefined,
): string | undefined {
	const ado = fields?.["System.State"];
	if (typeof ado === "string" && ado.length > 0) {
		return ado;
	}
	const generic = rec.state ?? rec.status;
	if (typeof generic === "string" && generic.length > 0) {
		return generic;
	}
	return undefined;
}

function _extractChangedDate(
	rec: Record<string, unknown>,
	fields: Record<string, unknown> | undefined,
): Date | null {
	const value =
		(fields?.["System.ChangedDate"] as unknown) ??
		rec.updated_at ??
		rec.updatedAt ??
		rec.changed_date;
	if (typeof value !== "string" || value.length === 0) {
		return null;
	}
	const d = new Date(value);
	return Number.isNaN(d.getTime()) ? null : d;
}

vi.mock("../story-sync", () => ({
	fetchPMItemsByIds: (...args: unknown[]) => mockFetchPMItemsByIds(...args),
	getWorkItemsByIdsFromPM: (...args: unknown[]) =>
		mockGetWorkItemsByIdsFromPM(...args),
	extractItemState: _extractItemState,
	extractChangedDate: _extractChangedDate,
}));

import {
	measureSerializedBytes,
	PAYLOAD_HARD_LIMIT_BYTES,
} from "../../../lib/payload-size-guard";
import {
	fetchAdoWorkItemStates,
	PM_POLL_BUDGET_MS,
	PM_POLL_RESULT_BUDGET_BYTES,
	statusSyncFetchOrder,
} from "../pm-state-poll";

const BIG = "x".repeat(12_000); // ~12 KB description per card → ~5.8 MB if packed

function makeSummaries(n: number) {
	return Array.from({ length: n }, (_, i) => ({
		id: String(i + 1),
		title: `Card ${i + 1}`,
		description: BIG,
		raw: {
			fields: {
				"System.State": "Active",
				"System.ChangedDate": "2030-01-01T00:00:00Z",
			},
		},
	}));
}

describe("fetchAdoWorkItemStates — payload size (#1741)", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockRecordPmSyncLog.mockResolvedValue(undefined);
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org_1",
			userId: "user_1",
			pmTerminalStatuses: ["Closed", "Done", "Removed"],
			pmAutoCloseEnabled: true,
		});
		// Non-null baseline hash so passthrough drift would run if title/desc leaked.
		mockGetLinkedExternalIds.mockResolvedValue(
			makeSummaries(480).map((s) => ({
				entityType: "STORY",
				entityId: `story_${s.id}`,
				externalId: s.id,
				draftingStage: "DRAFT",
				pmAutoHidden: false,
				lastSyncedPmHash: "baseline",
				lastPmSyncStatus: null,
			})),
		);
		mockUserStoryFindUnique.mockResolvedValue({
			title: "Story",
			assigneeId: null,
		});
		mockUpsertPendingChange.mockResolvedValue({
			action: "skipped",
			pendingId: null,
		});
	});

	it("per-ID path: slim result is < 512 KB and carries no title/description", async () => {
		mockFetchPMItemsByIds.mockResolvedValue({
			items: makeSummaries(480),
			failedIds: [],
			notFoundIds: [],
		});
		const res = await fetchAdoWorkItemStates({
			projectId: "proj_1",
			mcpConfigId: "cfg",
			containerId: "c",
			containerName: null,
			lastAdoStatePollAt: null,
			userId: "user_1",
			pmTool: "fizzy",
			sourceKind: "mcp",
		});
		const bytes = JSON.stringify(res).length;
		expect(bytes).toBeLessThan(512 * 1024);
		expect(typeof res.terminalStatusesHash).toBe("string");
		expect(res.items.length).toBe(480);
		for (const it of res.items) {
			expect(it).not.toHaveProperty("title");
			expect(it).not.toHaveProperty("description");
			expect(["terminal", "reopen", "passthrough"]).toContain(
				it.classification,
			);
		}
	});

	it("ADO-batch path: slim result is < 512 KB and carries no title/description", async () => {
		mockGetWorkItemsByIdsFromPM.mockResolvedValue({
			items: makeSummaries(200),
			wrongBoardIds: [],
			notFoundIds: [],
		});
		const res = await fetchAdoWorkItemStates({
			projectId: "proj_1",
			mcpConfigId: "cfg",
			containerId: "c",
			containerName: "Proj",
			lastAdoStatePollAt: null,
			userId: "user_1",
			pmTool: "azure-devops",
			sourceKind: "mcp",
		});
		expect(JSON.stringify(res).length).toBeLessThan(512 * 1024);
		expect(typeof res.terminalStatusesHash).toBe("string");
		expect(res.items.length).toBeGreaterThan(0);
		for (const it of res.items) {
			expect(it).not.toHaveProperty("title");
			expect(it).not.toHaveProperty("description");
			expect(["terminal", "reopen", "passthrough"]).toContain(
				it.classification,
			);
		}
	});

	// The realistic REST maximum does NOT fit the switch-on payload budget
	// (2 MiB − 128 KiB, sized to Temporal's 2 MiB single-payload limit), so
	// this pins the graceful degrade instead: the cap keeps an in-order
	// prefix under the limit and defers the tail to the next cycle.
	it("REST path at the budget maximum: 6,400 verdicts carrying labels + itemUrl exceed the payload budget, and the cap degrades gracefully under Temporal's 2 MiB limit (Fizzy #2304)", async () => {
		// The most one REST poll can return: 8 reads in flight for the whole
		// budget at ~0.3 s per GitLab issue read.
		const MAX_REST_ITEMS = 6_400;
		expect(MAX_REST_ITEMS).toBe((8 * PM_POLL_BUDGET_MS) / 300);
		const webUrl = (iid: number) =>
			`https://gitlab.com/example-group/example-subgroup/example-project/-/issues/${iid}`;
		const labels = [
			"workflow::in-review",
			"type::feature",
			"priority::p2",
			"team::platform-integrations",
		];
		// Exactly what the REST branch of fetchPMItemsByIds returns: the
		// getGitLabIssueForPM object as `raw`, its externalUrl as `url`.
		const restSummaries = Array.from({ length: MAX_REST_ITEMS }, (_, i) => {
			const iid = i + 1;
			const raw = {
				title: `Card ${iid}`,
				description: BIG,
				externalUrl: webUrl(iid),
				labels,
				state: "opened",
				updatedAt: "2026-09-20T14:03:11.482Z",
			};
			return {
				id: String(iid),
				displayId: String(iid),
				title: raw.title,
				description: raw.description,
				url: raw.externalUrl,
				workItemType: "Issue",
				raw,
			};
		});
		// itemUrl is emitted only while the project's status-sync switch is on.
		mockProjectFindUnique.mockResolvedValue({
			organizationId: "org_1",
			userId: "user_1",
			pmTerminalStatuses: ["Closed", "Done", "Removed"],
			pmAutoCloseEnabled: true,
			pmStatusSyncEnabled: true,
			pmStatusSyncSessionAt: new Date("2026-09-21T08:00:00.000Z"),
			pmStatusSyncLastRun: null,
			projectManagementAdditionalContext: {
				labelStatusMap: { "workflow::in-review": "st-progress" },
			},
			projectManagementMcpConfigId: null,
			projectManagementMcpServerId: "key:gitlab-official",
		});
		// One more linked issue whose read was attempted and failed — the run
		// summary must still count it as failed (the positive control for the
		// deferred tail, which it must not).
		const FAILED_READ = String(MAX_REST_ITEMS + 1);
		mockGetLinkedExternalIds.mockResolvedValue(
			[...restSummaries.map((s) => s.id), FAILED_READ].map((id) => ({
				entityType: "STORY",
				entityId: `story_${id}`,
				externalId: id,
				draftingStage: "DRAFT",
				pmAutoHidden: false,
				lastSyncedPmHash: "baseline",
				lastPmSyncStatus: null,
			})),
		);
		mockFetchPMItemsByIds.mockResolvedValue({
			items: restSummaries,
			failedIds: [FAILED_READ],
			notFoundIds: [],
			failedIdErrors: { [FAILED_READ]: "GitLab API error: 500" },
		});
		// The switch-on fetch rotates the linked list by a random offset each
		// cycle (Task 5, D2.2); pin it so the verdict order below is the id order.
		const offset = vi
			.spyOn(statusSyncFetchOrder, "startOffset")
			.mockReturnValue(0);

		try {
			const res = await fetchAdoWorkItemStates({
				projectId: "proj_1",
				mcpConfigId: null,
				mcpServerId: "key:gitlab-official",
				containerId: "example-group/example-subgroup/example-project",
				containerName: null,
				lastAdoStatePollAt: null,
				userId: "user_1",
				organizationId: "org_1",
				pmTool: "gitlab-official",
				sourceKind: "rest-gitlab",
			});

			// The untruncated result: the ONE measure call whose argument
			// carries every verdict (the cap sizes it before deciding), picked
			// by its argument so no other, larger measure can stand in for it.
			const measure = vi.mocked(measureSerializedBytes).mock;
			const untruncatedCalls = measure.calls.flatMap(([value], index) =>
				(value as { items?: unknown[] } | null)?.items?.length ===
				MAX_REST_ITEMS
					? [index]
					: [],
			);
			expect(untruncatedCalls).toHaveLength(1);
			const untruncatedBytes = measure.results[untruncatedCalls[0] ?? -1]
				?.value as number;
			const bytes = measureSerializedBytes(res);
			const kept = res.items.length;
			// Recorded for the PR.
			console.info(
				`[payload-size] REST budget maximum: ${untruncatedBytes} bytes untruncated; the cap kept ${kept} of ${MAX_REST_ITEMS} verdicts in ${bytes} bytes`,
			);
			// Why the cap engaged.
			expect(untruncatedBytes).toBeGreaterThan(
				PM_POLL_RESULT_BUDGET_BYTES,
			);

			// Positive control: the cap kept a real prefix, in fetch order, of
			// complete verdicts.
			expect(kept).toBeGreaterThan(0);
			expect(kept).toBeLessThan(MAX_REST_ITEMS);
			for (const [i, verdict] of res.items.entries()) {
				expect(verdict.externalId).toBe(String(i + 1));
				expect(verdict.itemUrl).toBe(webUrl(i + 1));
				expect(verdict.labels).toEqual(labels);
				expect(verdict).not.toHaveProperty("title");
				expect(verdict).not.toHaveProperty("description");
			}
			const ids = restSummaries.map((s) => s.id);
			expect(res.seenExternalIds).toEqual(ids.slice(0, kept));
			// ...and packed it close to the budget. The cap stops only at the
			// first verdict that does not fit (+1 for its array comma). Its
			// running total is an upper bound that lists EVERY id in BOTH id
			// lists, while the result lists each id once, so the result sits one
			// id list below that total. Hence the slack under the budget is less
			// than one more verdict plus one id list, both measured for real:
			// the next verdict is the last kept one with the next id and URL.
			const lastKept = res.items[kept - 1];
			const nextVerdictBytes = measureSerializedBytes({
				...lastKept,
				externalId: String(kept + 1),
				itemUrl: webUrl(kept + 1),
			});
			const oneIdListBytes = measureSerializedBytes(ids);
			expect(PM_POLL_RESULT_BUDGET_BYTES - bytes).toBeLessThan(
				nextVerdictBytes + 1 + oneIdListBytes,
			);

			// The degrade: inside the budget, Temporal's 2 MiB payload limit and
			// the gRPC frame. The tail is a TRANSIENT failure — never not-found,
			// which would feed FLAG_MISSING — and the run is incomplete, so the
			// changed-date watermark holds (DEC-6).
			expect(bytes).toBeLessThanOrEqual(PM_POLL_RESULT_BUDGET_BYTES);
			expect(bytes).toBeLessThan(2 * 1024 * 1024);
			expect(bytes).toBeLessThan(PAYLOAD_HARD_LIMIT_BYTES);
			expect(res.failedIds).toEqual([FAILED_READ, ...ids.slice(kept)]);
			expect(res.notFoundIds).toEqual([]);
			expect(res.totalLinked).toBe(MAX_REST_ITEMS + 1);
			expect(res.complete).toBe(false);
			// ...and the run summary reports the incomplete fetch (D2.6).
			expect(mockMergePmStatusSyncLastRun).toHaveBeenCalledTimes(1);
			const { fetch } = mockMergePmStatusSyncLastRun.mock.calls[0]?.[0]
				.patch as {
				fetch: {
					linked: number;
					fetched: number;
					failed: number;
					notFound: number;
				};
			};
			// Positive control: the genuinely failed read counts as failed…
			expect(fetch.failed).toBe(1);
			// …and the deferred tail does not: every one of those reads
			// succeeded, so it shows as not fetched.
			expect(mockMergePmStatusSyncLastRun).toHaveBeenCalledWith({
				projectId: "proj_1",
				sessionAt: new Date("2026-09-21T08:00:00.000Z"),
				patch: {
					fetch: {
						at: expect.any(String),
						linked: MAX_REST_ITEMS + 1,
						fetched: kept,
						failed: 1,
						notFound: 0,
						complete: false,
					},
				},
			});
			expect(
				fetch.linked - fetch.fetched - fetch.failed - fetch.notFound,
			).toBe(MAX_REST_ITEMS - kept);
		} finally {
			offset.mockRestore();
		}
	});
});
