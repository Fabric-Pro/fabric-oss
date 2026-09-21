/**
 * The status-sync leaf (Fizzy #2304 — spec §4.4 rows 1 and 3–10, AC3–AC9).
 *
 * The database is a select-honouring, where-evaluating fake
 * (`test-helpers/select-honouring-db.ts`): every story reaches the leaf through
 * the same `STATUS_SYNC_STORY_SELECT` read the poll runs, and every
 * compare-and-set is evaluated against the fixture row, so a story that
 * changed between the read and the write yields Prisma's real count 0. The
 * sync-log helper runs for real down to `createPmSyncLog`, and the CONFLICT
 * dedupe lookup answers from the rows that helper wrote.
 *
 * Run with: corepack pnpm --filter @repo/temporal exec vitest run __tests__/reconcile-story-mapped-status.test.ts
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	storyRows: [] as Array<Record<string, unknown>>,
	calls: [] as Array<{
		table: string;
		method: string;
		args: Record<string, unknown>;
	}>,
	syncLogRows: [] as Array<Record<string, unknown>>,
	dedupeLookups: [] as Array<Record<string, unknown>>,
	recordAudit: vi.fn(),
	createPmSyncLog: vi.fn(),
}));

vi.mock("@repo/database", async () => {
	const { createFakeTable } = await import(
		"./test-helpers/select-honouring-db"
	);
	return {
		db: {
			userStory: createFakeTable("userStory", () => h.storyRows, h.calls),
		},
		recordAudit: h.recordAudit,
		createPmSyncLog: h.createPmSyncLog,
		// Answers from the rows the REAL recordPmSyncLog wrote through the
		// createPmSyncLog mock — the query itself is pinned in
		// packages/database/__tests__/pm-sync-log-dedupe.test.ts.
		hasPmSyncConflictWithDedupeKey: async (args: {
			projectId: string;
			entityId: string;
			dedupeKey: string;
		}) => {
			h.dedupeLookups.push(args);
			return h.syncLogRows.some(
				(row) =>
					row.projectId === args.projectId &&
					row.entityId === args.entityId &&
					row.direction === "pull" &&
					row.status === "CONFLICT" &&
					(row.errorPayload as { dedupeKey?: unknown } | undefined)
						?.dedupeKey === args.dedupeKey,
			);
		},
	};
});

vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { db } from "@repo/database";
import type { TrustedKey } from "../src/activities/pm-integration/pm-server-provenance-match";
import {
	isLinkedIssue,
	normalizeIssueUrl,
	reconcileStoryMappedStatus,
	recordTerminalObservation,
	STATUS_SYNC_STORY_SELECT,
	type StatusSyncStoryRow,
	statusSyncLinkKey,
} from "../src/activities/pm-integration/reconcile-story-mapped-status";

type Row = Record<string, unknown>;
type LeafInput = Parameters<typeof reconcileStoryMappedStatus>[0];

const PROJECT_ID = "proj-1";
const ORG_ID = "org-1";
const OWNER_ID = "user-owner";
const GITLAB_SERVER = "key:gitlab-official";
const issueUrl = (iid: string) =>
	`https://gitlab.example.com/acme/portal/-/issues/${iid}`;
const URL_42 = issueUrl("42");

const NOW = new Date("2026-09-21T12:00:00.000Z");
const T0 = new Date("2026-09-01T10:00:00.000Z");
const D1 = new Date("2026-09-02T10:00:00.000Z");
const D2 = new Date("2026-09-03T10:00:00.000Z");
const D3 = new Date("2026-09-04T10:00:00.000Z");

const TODO = { id: "st-todo", name: "To Do" };
const PROGRESS = { id: "st-progress", name: "In Progress" };
const REVIEW = { id: "st-review", name: "In Review" };
const PROJECT_STATUSES = [TODO, PROGRESS, REVIEW];
const LABEL_MAP = {
	"workflow::todo": TODO.id,
	"workflow::in-progress": PROGRESS.id,
	"workflow::in-review": REVIEW.id,
};

/** A realistic linked REST story: stored URL, base recorded against it, a non-status label on the ticket. */
function storyRow(over: Row = {}): Row {
	return {
		id: "story-42",
		projectId: PROJECT_ID,
		kind: "FEATURE",
		title: "Saved payment methods",
		statusId: TODO.id,
		order: 2,
		pmStatusSyncBaseId: TODO.id,
		pmStatusSyncBaseAt: T0,
		pmStatusSyncBaseLink: URL_42,
		// Observed To Do while Fabric showed To Do (what row 8 or a push stamp writes).
		pmStatusSyncBaseFabricId: TODO.id,
		lastPmSyncStatus: "SUCCESS",
		externalId: "42",
		externalUrl: URL_42,
		externalMcpServerId: null,
		lastEditedAt: new Date("2026-08-30T09:00:00.000Z"),
		lastEditedSource: "MANUAL",
		lastEditedByName: "Example Editor",
		...over,
	};
}

const REST_SOURCE: LeafInput["source"] = {
	isRest: true,
	activeServerId: GITLAB_SERVER,
	pmToolKey: "gitlab-official",
	pmToolLabel: "GitLab",
	activeOrg: null,
};

async function readStory(id = "story-42"): Promise<StatusSyncStoryRow> {
	const row = await db.userStory.findUnique({
		where: { id, projectId: PROJECT_ID },
		select: STATUS_SYNC_STORY_SELECT,
	});
	if (!row) {
		throw new Error(`fixture story ${id} is missing`);
	}
	return row as StatusSyncStoryRow;
}

interface LeafOverrides {
	item?: Partial<LeafInput["item"]>;
	/**
	 * Build the verdict with NO `itemUrl` key at all — what the poll passes
	 * for every MCP verdict (only the REST GitLab fetch with the switch on
	 * sets one), and for a REST verdict fetched with the switch off.
	 */
	omitItemUrl?: boolean;
	source?: Partial<LeafInput["source"]>;
	config?: Partial<LeafInput["config"]>;
	tenant?: LeafInput["tenant"];
	story?: StatusSyncStoryRow;
}

/** One poll verdict for story-42: the ticket now carries the in-review label. */
async function runLeaf(over: LeafOverrides = {}) {
	const { itemUrl, ...withoutItemUrl }: LeafInput["item"] = {
		externalId: "42",
		state: "",
		labels: ["type::feature", "workflow::in-review"],
		stateChangedDate: D1,
		itemUrl: URL_42,
		...over.item,
	};
	return reconcileStoryMappedStatus({
		projectId: PROJECT_ID,
		tenant: over.tenant ?? {
			organizationId: ORG_ID,
			ownerUserId: OWNER_ID,
		},
		item: over.omitItemUrl
			? withoutItemUrl
			: { ...withoutItemUrl, itemUrl },
		story: over.story ?? (await readStory()),
		config: {
			labelStatusMap: LABEL_MAP,
			statusColumnMap: {},
			projectStatuses: PROJECT_STATUSES,
			...over.config,
		},
		source: { ...REST_SOURCE, ...over.source },
	});
}

const story42 = () => h.storyRows.find((r) => r.id === "story-42") as Row;
const casCalls = () =>
	h.calls
		.filter((c) => c.table === "userStory" && c.method === "updateMany")
		.map((c) => c.args);
const conflictRows = () => h.syncLogRows.filter((r) => r.status === "CONFLICT");
const successRows = () => h.syncLogRows.filter((r) => r.status === "SUCCESS");

/** The observed state of the default fixture — what every CAS must match. */
const CAS_WHERE = {
	id: "story-42",
	projectId: PROJECT_ID,
	statusId: TODO.id,
	pmStatusSyncBaseId: TODO.id,
	pmStatusSyncBaseAt: T0,
	pmStatusSyncBaseLink: URL_42,
	pmStatusSyncBaseFabricId: TODO.id,
};

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(NOW);
	h.storyRows = [
		storyRow(),
		// Two stories already In Review, so a move there appends after order 7.
		storyRow({
			id: "story-50",
			statusId: REVIEW.id,
			order: 3,
			externalId: "50",
			externalUrl: issueUrl("50"),
			pmStatusSyncBaseId: REVIEW.id,
			pmStatusSyncBaseLink: issueUrl("50"),
			pmStatusSyncBaseFabricId: REVIEW.id,
		}),
		storyRow({
			id: "story-51",
			statusId: REVIEW.id,
			order: 7,
			externalId: "51",
			externalUrl: issueUrl("51"),
			pmStatusSyncBaseId: REVIEW.id,
			pmStatusSyncBaseLink: issueUrl("51"),
			pmStatusSyncBaseFabricId: REVIEW.id,
		}),
	];
	h.calls.length = 0;
	h.syncLogRows.length = 0;
	h.dedupeLookups.length = 0;
	h.recordAudit.mockReset();
	h.createPmSyncLog.mockReset();
	h.createPmSyncLog.mockImplementation(async (row: Row) => {
		h.syncLogRows.push(row);
		return { id: `log-${h.syncLogRows.length}` };
	});
});

afterEach(() => {
	vi.useRealTimers();
});

describe("STATUS_SYNC_STORY_SELECT", () => {
	it("is exactly the spec D2.5 story read", () => {
		expect(STATUS_SYNC_STORY_SELECT).toEqual({
			id: true,
			title: true,
			statusId: true,
			order: true,
			pmStatusSyncBaseId: true,
			pmStatusSyncBaseAt: true,
			pmStatusSyncBaseLink: true,
			pmStatusSyncBaseFabricId: true,
			lastPmSyncStatus: true,
			externalId: true,
			externalUrl: true,
			externalMcpServerId: true,
		});
	});
});

describe("row 10 — moved", () => {
	it("moves the story to the ticket's mapped status, appended to the end of that column, through an exact compare-and-set", async () => {
		await expect(runLeaf()).resolves.toEqual({ outcome: "moved" });

		expect(
			h.calls.filter((c) => c.method === "findFirst").map((c) => c.args),
		).toEqual([
			{
				where: { projectId: PROJECT_ID, statusId: REVIEW.id },
				orderBy: { order: "desc" },
				select: { order: true },
			},
		]);
		expect(casCalls()).toEqual([
			{
				where: CAS_WHERE,
				data: {
					statusId: REVIEW.id,
					order: 8,
					pmStatusSyncBaseId: REVIEW.id,
					pmStatusSyncBaseAt: D1,
					pmStatusSyncBaseLink: URL_42,
					pmStatusSyncBaseFabricId: REVIEW.id,
					lastEditedAt: NOW,
					lastEditedSource: "PM_PULL",
					lastEditedByName: null,
				},
			},
		]);
		expect(story42()).toMatchObject({
			statusId: REVIEW.id,
			order: 8,
			lastEditedSource: "PM_PULL",
			lastEditedByName: null,
		});
	});

	it("appends as order 1 to an empty column", async () => {
		await expect(
			runLeaf({ item: { labels: ["workflow::in-progress"] } }),
		).resolves.toEqual({ outcome: "moved" });
		expect(story42()).toMatchObject({ statusId: PROGRESS.id, order: 1 });
	});

	it("records the audit event and one SUCCESS pull row in the org tenant shape", async () => {
		await runLeaf();

		expect(h.recordAudit).toHaveBeenCalledTimes(1);
		expect(h.recordAudit).toHaveBeenCalledWith({
			action: "story.pm_status_synced",
			category: "story",
			actor: { type: "system" },
			organizationId: ORG_ID,
			projectId: PROJECT_ID,
			resource: {
				type: "story",
				id: "story-42",
				name: "Saved payment methods",
			},
			metadata: {
				fromStatus: TODO.id,
				toStatus: REVIEW.id,
				statusName: "In Review",
				source: "PM_STATUS_SYNC",
				pmTool: "GitLab",
			},
		});
		expect(successRows()).toEqual([
			{
				organizationId: ORG_ID,
				userId: null,
				projectId: PROJECT_ID,
				direction: "pull",
				entityType: "STORY",
				entityId: "story-42",
				title: "Saved payment methods",
				pmTool: "gitlab",
				status: "SUCCESS",
				actorUserId: null,
				externalId: "42",
				externalUrl: URL_42,
				batchId: null,
				correlationId: null,
			},
		]);
		expect(conflictRows()).toEqual([]);
	});

	it("records the SUCCESS row in the personal tenant shape", async () => {
		await runLeaf({
			tenant: { organizationId: null, ownerUserId: OWNER_ID },
		});

		expect(successRows()).toHaveLength(1);
		expect(successRows()[0]).toMatchObject({
			organizationId: null,
			userId: OWNER_ID,
		});
		expect(h.recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({ organizationId: null }),
		);
	});

	it("a label-map edit moves an already-linked story (spec §2 policy)", async () => {
		h.storyRows[0] = storyRow({
			statusId: PROGRESS.id,
			pmStatusSyncBaseId: PROGRESS.id,
			pmStatusSyncBaseFabricId: PROGRESS.id,
		});
		const item = { labels: ["workflow::in-progress"] };

		// Positive control: under the current map the ticket still says In Progress.
		await expect(runLeaf({ item })).resolves.toEqual({
			outcome: "unchanged",
		});
		expect(casCalls()).toEqual([]);

		// The owner re-points the label at In Review.
		await expect(
			runLeaf({
				item,
				config: {
					labelStatusMap: {
						...LABEL_MAP,
						"workflow::in-progress": REVIEW.id,
					},
				},
			}),
		).resolves.toEqual({ outcome: "moved" });
		expect(story42()).toMatchObject({ statusId: REVIEW.id });
	});
});

describe("CAS count 0 → raced", () => {
	it.each([
		["statusId", PROGRESS.id],
		["pmStatusSyncBaseId", REVIEW.id],
		["pmStatusSyncBaseAt", D2],
		["pmStatusSyncBaseLink", issueUrl("41")],
		["pmStatusSyncBaseFabricId", PROGRESS.id],
	] as const)(
		"a concurrent write to %s between the read and the write is raced, and nothing else is written",
		async (field, value) => {
			const story = await readStory();
			story42()[field] = value; // someone else wrote the story first

			await expect(runLeaf({ story })).resolves.toEqual({
				outcome: "raced",
			});

			// Positive control: the write WAS attempted, against the state we read.
			expect(casCalls()).toHaveLength(1);
			expect(casCalls()[0].where).toEqual(CAS_WHERE);
			expect(story42().statusId).not.toBe(REVIEW.id);
			expect(h.recordAudit).not.toHaveBeenCalled();
			expect(h.syncLogRows).toEqual([]);
		},
	);

	it("a base-only write that loses the race is raced too, with no CONFLICT row", async () => {
		const story = await readStory();
		story42().statusId = PROGRESS.id;

		await expect(
			runLeaf({
				story,
				item: {
					labels: ["workflow::in-progress", "workflow::in-review"],
				},
			}),
		).resolves.toEqual({ outcome: "raced" });
		expect(casCalls()).toHaveLength(1);
		expect(h.syncLogRows).toEqual([]);
	});
});

describe("rows 4–9", () => {
	it("row 4: a story with an unresolved push CONFLICT is skipped — the same verdict moves it without one", async () => {
		await expect(runLeaf()).resolves.toEqual({ outcome: "moved" });

		h.storyRows[0] = storyRow({ lastPmSyncStatus: "CONFLICT" });
		h.calls.length = 0;
		await expect(runLeaf()).resolves.toEqual({
			outcome: "skipped-conflict",
		});
		expect(casCalls()).toEqual([]);
	});

	it("row 5: a verdict older than the base clock is stale — one at the base clock is not", async () => {
		// Positive control: the same verdict at the base clock is applied.
		await expect(
			runLeaf({ item: { stateChangedDate: T0 } }),
		).resolves.toEqual({ outcome: "moved" });
		expect(casCalls()).toHaveLength(1);

		h.storyRows[0] = storyRow();
		h.calls.length = 0;
		await expect(
			runLeaf({
				item: {
					stateChangedDate: new Date("2026-08-31T10:00:00.000Z"),
				},
			}),
		).resolves.toEqual({ outcome: "stale" });
		expect(casCalls()).toEqual([]);
	});

	it("row 6: no mapped label records __none__ once, against Fabric's status", async () => {
		await expect(
			runLeaf({ item: { labels: ["type::feature"] } }),
		).resolves.toEqual({ outcome: "not-mapped" });
		expect(casCalls()).toEqual([
			{
				where: CAS_WHERE,
				data: {
					pmStatusSyncBaseId: "__none__",
					pmStatusSyncBaseAt: D1,
					pmStatusSyncBaseLink: URL_42,
					pmStatusSyncBaseFabricId: TODO.id,
				},
			},
		]);
		expect(h.syncLogRows).toEqual([]);

		h.calls.length = 0;
		await expect(
			runLeaf({
				item: { labels: ["type::feature"], stateChangedDate: D2 },
			}),
		).resolves.toEqual({ outcome: "not-mapped" });
		expect(casCalls()).toEqual([]);
	});

	it("row 7: conflicting labels record __ambiguous__ and ONE deduped CONFLICT row per (story, label set, ticket date)", async () => {
		const ambiguousItem = {
			labels: [
				"workflow::in-review",
				"type::feature",
				"workflow::in-progress",
			],
		};
		const key = `status-sync:ambiguous:story-42:workflow::in-progress|workflow::in-review:${D1.toISOString()}`;

		await expect(runLeaf({ item: ambiguousItem })).resolves.toEqual({
			outcome: "ambiguous",
		});
		expect(casCalls()).toEqual([
			{
				where: CAS_WHERE,
				data: {
					pmStatusSyncBaseId: "__ambiguous__",
					pmStatusSyncBaseAt: D1,
					pmStatusSyncBaseLink: URL_42,
					pmStatusSyncBaseFabricId: TODO.id,
				},
			},
		]);
		expect(h.dedupeLookups).toEqual([
			{ projectId: PROJECT_ID, entityId: "story-42", dedupeKey: key },
		]);
		expect(conflictRows()).toEqual([
			{
				organizationId: ORG_ID,
				userId: null,
				projectId: PROJECT_ID,
				direction: "pull",
				entityType: "STORY",
				entityId: "story-42",
				title: "Saved payment methods",
				pmTool: "gitlab",
				status: "CONFLICT",
				actorUserId: null,
				externalId: "42",
				externalUrl: URL_42,
				errorPayload: {
					source: "pm-status-sync",
					dedupeKey: key,
					reason: "ambiguous-status-labels",
					errorMessage:
						"Status sync left this story unchanged: its GitLab labels workflow::in-progress, workflow::in-review map to different Fabric statuses. Keep one of them in GitLab, or edit the label map.",
					labels: ["workflow::in-progress", "workflow::in-review"],
					statusIds: [REVIEW.id, PROGRESS.id],
				},
				batchId: null,
				correlationId: null,
			},
		]);

		// An identical cycle: no base write, no second row.
		h.calls.length = 0;
		await expect(runLeaf({ item: ambiguousItem })).resolves.toEqual({
			outcome: "ambiguous",
		});
		expect(casCalls()).toEqual([]);
		expect(conflictRows()).toHaveLength(1);

		// The ticket changed again, still ambiguous: exactly one more row.
		await runLeaf({ item: { ...ambiguousItem, stateChangedDate: D2 } });
		expect(conflictRows()).toHaveLength(2);
		expect(
			(conflictRows()[1].errorPayload as Record<string, unknown>)
				.dedupeKey,
		).toBe(
			`status-sync:ambiguous:story-42:workflow::in-progress|workflow::in-review:${D2.toISOString()}`,
		);
	});

	it("row 8: a ticket that already matches Fabric records the observation, then writes nothing", async () => {
		// Last observed In Progress (while Fabric showed it); both sides since
		// moved back to To Do.
		h.storyRows[0] = storyRow({
			pmStatusSyncBaseId: PROGRESS.id,
			pmStatusSyncBaseFabricId: PROGRESS.id,
		});
		await expect(
			runLeaf({ item: { labels: ["workflow::todo"] } }),
		).resolves.toEqual({ outcome: "unchanged" });
		expect(casCalls()).toEqual([
			{
				where: {
					...CAS_WHERE,
					pmStatusSyncBaseId: PROGRESS.id,
					pmStatusSyncBaseFabricId: PROGRESS.id,
				},
				data: {
					pmStatusSyncBaseId: TODO.id,
					pmStatusSyncBaseAt: D1,
					pmStatusSyncBaseLink: URL_42,
					pmStatusSyncBaseFabricId: TODO.id,
				},
			},
		]);

		h.calls.length = 0;
		await expect(
			runLeaf({
				item: { labels: ["workflow::todo"], stateChangedDate: D2 },
			}),
		).resolves.toEqual({ outcome: "unchanged" });
		expect(casCalls()).toEqual([]);
	});

	it("row 9: a Fabric-only move stands while the ticket shows the observed status — and yields once the ticket changes", async () => {
		const fabricMoved = () => storyRow({ statusId: PROGRESS.id }); // moved in Fabric; base still To Do

		// Positive control: the same story yields to a ticket that changed.
		h.storyRows[0] = fabricMoved();
		await expect(runLeaf()).resolves.toEqual({ outcome: "moved" });
		expect(casCalls()).toHaveLength(1);

		h.storyRows[0] = fabricMoved();
		h.calls.length = 0;
		await expect(
			runLeaf({ item: { labels: ["workflow::todo"] } }),
		).resolves.toEqual({ outcome: "fabric-ahead" });
		expect(casCalls()).toEqual([]);
		expect(story42().statusId).toBe(PROGRESS.id);

		// Both changed between two polls: the ticket wins (spec §2).
		await expect(runLeaf()).resolves.toEqual({ outcome: "moved" });
		expect(story42().statusId).toBe(REVIEW.id);
	});
});

describe("row 9 survives a cosmetic externalUrl rewrite (Codex C5)", () => {
	// The same issue as URL_42, rewritten the way GitLab (or a client-side
	// normalizer) might return it: upper-case host, trailing slash. AC8's
	// linked-issue check already treats this as the same issue.
	const REWRITTEN_URL_42 =
		"https://GitLab.Example.com/acme/portal/-/issues/42/";

	/**
	 * Fabric moved TODO -> REVIEW; the base still says TODO, recorded against
	 * the canonical URL (what a prior poll/push would have stamped). `url` is
	 * the story's CURRENT `externalUrl` — canonical for the positive control,
	 * cosmetically rewritten for the regression.
	 */
	const rewrittenLinkFixture = (url: string) =>
		storyRow({
			statusId: REVIEW.id,
			externalUrl: url,
			pmStatusSyncBaseId: TODO.id, // P
			pmStatusSyncBaseAt: T0, // T
			pmStatusSyncBaseLink: URL_42, // base recorded against the canonical URL
			pmStatusSyncBaseFabricId: TODO.id, // F
		});

	/** The fetched verdict: ticket still shows To Do, itemUrl canonical, d > T. */
	const stillTodoVerdict = {
		labels: ["workflow::todo"],
		itemUrl: URL_42,
		stateChangedDate: D1,
	};

	it("positive control: an unrewritten externalUrl reports fabric-ahead and writes nothing", async () => {
		h.storyRows[0] = rewrittenLinkFixture(URL_42);
		await expect(runLeaf({ item: stillTodoVerdict })).resolves.toEqual({
			outcome: "fabric-ahead",
		});
		expect(casCalls()).toEqual([]);
		expect(story42().statusId).toBe(REVIEW.id);
	});

	it("a cosmetic rewrite of externalUrl (trailing slash, upper-case host) still matches the stored base: fabric-ahead, no write", async () => {
		h.storyRows[0] = rewrittenLinkFixture(REWRITTEN_URL_42);
		await expect(runLeaf({ item: stillTodoVerdict })).resolves.toEqual({
			outcome: "fabric-ahead",
		});
		expect(casCalls()).toEqual([]);
		expect(story42().statusId).toBe(REVIEW.id);
	});
});

describe("first observation, relinks and stale verdicts", () => {
	it("a story with no base takes the ticket's status on first observation (AC5)", async () => {
		h.storyRows[0] = storyRow({
			pmStatusSyncBaseId: null,
			pmStatusSyncBaseAt: null,
			pmStatusSyncBaseLink: null,
			pmStatusSyncBaseFabricId: null,
		});
		await expect(runLeaf()).resolves.toEqual({ outcome: "moved" });
		expect(casCalls()[0].where).toEqual({
			...CAS_WHERE,
			pmStatusSyncBaseId: null,
			pmStatusSyncBaseAt: null,
			pmStatusSyncBaseLink: null,
			pmStatusSyncBaseFabricId: null,
		});
	});

	it("a relinked story ignores the old link's base (first observation)", async () => {
		// Positive control: with the base on THIS link, In Review is Fabric-ahead.
		h.storyRows[0] = storyRow({
			pmStatusSyncBaseId: REVIEW.id,
			pmStatusSyncBaseFabricId: REVIEW.id,
		});
		await expect(runLeaf()).resolves.toEqual({ outcome: "fabric-ahead" });

		h.storyRows[0] = storyRow({
			pmStatusSyncBaseId: REVIEW.id,
			pmStatusSyncBaseLink: issueUrl("41"),
			pmStatusSyncBaseFabricId: REVIEW.id,
		});
		await expect(runLeaf()).resolves.toEqual({ outcome: "moved" });
		expect(story42()).toMatchObject({
			statusId: REVIEW.id,
			pmStatusSyncBaseLink: URL_42,
		});
	});

	it("a verdict fetched before a push stamped the base is stale; a later one applies", async () => {
		const STAMP = new Date("2026-09-03T08:00:00.000Z");
		// What a push stamp leaves: P = F = L, T = GitLab's updated_at.
		h.storyRows[0] = storyRow({
			statusId: PROGRESS.id,
			pmStatusSyncBaseId: PROGRESS.id,
			pmStatusSyncBaseAt: STAMP,
			pmStatusSyncBaseFabricId: PROGRESS.id,
		});
		const oldLabels = { labels: ["workflow::todo"] };

		await expect(
			runLeaf({
				item: {
					...oldLabels,
					stateChangedDate: new Date("2026-09-03T07:59:00.000Z"),
				},
			}),
		).resolves.toEqual({ outcome: "stale" });
		expect(casCalls()).toEqual([]);

		await expect(
			runLeaf({
				item: {
					...oldLabels,
					stateChangedDate: new Date("2026-09-03T08:05:00.000Z"),
				},
			}),
		).resolves.toEqual({ outcome: "moved" });
	});

	it("mapped → no mapped label → mapped again, with a Fabric move in between, moves the story (AC6)", async () => {
		h.storyRows[0] = storyRow({
			pmStatusSyncBaseId: null,
			pmStatusSyncBaseAt: null,
			pmStatusSyncBaseLink: null,
			pmStatusSyncBaseFabricId: null,
		});
		await expect(
			runLeaf({
				item: { labels: ["workflow::todo"], stateChangedDate: D1 },
			}),
		).resolves.toEqual({ outcome: "unchanged" });
		await expect(
			runLeaf({
				item: { labels: ["type::feature"], stateChangedDate: D2 },
			}),
		).resolves.toEqual({ outcome: "not-mapped" });
		story42().statusId = PROGRESS.id; // a Fabric-only move while unmapped

		await expect(
			runLeaf({
				item: { labels: ["workflow::todo"], stateChangedDate: D3 },
			}),
		).resolves.toEqual({ outcome: "moved" });
		expect(story42().statusId).toBe(TODO.id);
	});
});

describe("row 3 — the linked-issue check (AC8)", () => {
	it("REST: a fetched issue whose URL is not the story's link writes nothing and one deduped CONFLICT row", async () => {
		const URL_43 = issueUrl("43");
		// Positive control: the same story verifies against its own URL.
		expect(
			isLinkedIssue({
				isRest: true,
				storyExternalUrl: URL_42,
				storyExternalMcpServerId: null,
				itemUrl: URL_42,
				activeServerId: GITLAB_SERVER,
				pmToolKey: "gitlab-official",
				activeOrg: null,
			}),
		).toBe(true);

		await expect(runLeaf({ item: { itemUrl: URL_43 } })).resolves.toEqual({
			outcome: "unverified",
		});
		expect(casCalls()).toEqual([]);
		const key = `status-sync:unverified:story-42:url=${URL_43}`;
		expect(h.dedupeLookups).toEqual([
			{ projectId: PROJECT_ID, entityId: "story-42", dedupeKey: key },
		]);
		expect(conflictRows()).toEqual([
			{
				organizationId: ORG_ID,
				userId: null,
				projectId: PROJECT_ID,
				direction: "pull",
				entityType: "STORY",
				entityId: "story-42",
				title: "Saved payment methods",
				pmTool: "gitlab",
				status: "CONFLICT",
				actorUserId: null,
				externalId: "42",
				externalUrl: URL_43,
				errorPayload: {
					source: "pm-status-sync",
					dedupeKey: key,
					reason: "status-sync-unverified-link",
					errorMessage:
						"Status sync did not use GitLab issue 42 for this story: the issue's URL does not match the story's link. Pull the story to refresh its link, or relink it.",
					observedItemUrl: URL_43,
					storyExternalUrl: URL_42,
					storyExternalMcpServerId: null,
					activeServerId: GITLAB_SERVER,
				},
				batchId: null,
				correlationId: null,
			},
		]);

		// The same observation again: no second row. A different URL: one more.
		await runLeaf({ item: { itemUrl: URL_43 } });
		expect(conflictRows()).toHaveLength(1);
		await runLeaf({ item: { itemUrl: issueUrl("44") } });
		expect(conflictRows()).toHaveLength(2);
		expect(casCalls()).toEqual([]);
	});

	it("REST: a story with no stored URL is unverified", async () => {
		h.storyRows[0] = storyRow({ externalUrl: null });
		await expect(runLeaf()).resolves.toEqual({ outcome: "unverified" });
		expect(casCalls()).toEqual([]);
	});

	it("REST: a verdict without the fetched issue's URL is unverified", async () => {
		await expect(runLeaf({ item: { itemUrl: null } })).resolves.toEqual({
			outcome: "unverified",
		});
		expect(casCalls()).toEqual([]);
	});

	it("REST: a verdict fetched with the switch off (no itemUrl key) is not observed — no write, no CONFLICT row, no outcome", async () => {
		// Positive control: itemUrl null (switch on, issue without a URL) IS
		// unverified and reported.
		await expect(runLeaf({ item: { itemUrl: null } })).resolves.toEqual({
			outcome: "unverified",
		});
		expect(conflictRows()).toHaveLength(1);

		h.calls.length = 0;
		h.dedupeLookups.length = 0;
		await expect(
			runLeaf({ item: { itemUrl: undefined } }),
		).resolves.toEqual({ outcome: null });
		expect(casCalls()).toEqual([]);
		expect(h.dedupeLookups).toEqual([]);
		expect(conflictRows()).toHaveLength(1);
		expect(story42().statusId).toBe(TODO.id);
	});

	it("REST: host case and a trailing slash do not break the match", async () => {
		await expect(
			runLeaf({
				item: {
					itemUrl:
						"HTTPS://GitLab.Example.com/acme/portal/-/issues/42/",
				},
			}),
		).resolves.toEqual({ outcome: "moved" });
	});

	describe("MCP", () => {
		const ADO_SERVER = "srv-ado";
		const adoUrl = (org: string, id: string) =>
			`https://dev.azure.com/${org}/Portal/_workitems/edit/${id}`;
		const MCP_SOURCE = {
			isRest: false,
			activeServerId: ADO_SERVER,
			pmToolKey: "azure-devops",
			pmToolLabel: "Azure DevOps",
		};
		const TRUSTED: TrustedKey = { kind: "trusted", key: "example-org" };
		const mcpStory = (over: Row) =>
			storyRow({
				externalId: "101",
				externalUrl: adoUrl("example-org", "101"),
				pmStatusSyncBaseLink: "101",
				...over,
			});
		/**
		 * The poll's MCP verdict as it really arrives: a status string and NO
		 * `itemUrl` key — nothing on the MCP path produces one, and the poll
		 * passes the verdict through unchanged.
		 */
		const runMcpLeaf = (activeOrg: TrustedKey | null) =>
			runLeaf({
				item: { externalId: "101", state: "In Review", labels: [] },
				omitItemUrl: true,
				source: { ...MCP_SOURCE, activeOrg },
			});

		it("an MCP verdict (no itemUrl key) is observed, and its write is keyed by the external id", async () => {
			// Positive control: the same key-absent verdict on REST is a
			// switch-off fetch and is not observed — so the key really is absent.
			await expect(runLeaf({ omitItemUrl: true })).resolves.toEqual({
				outcome: null,
			});
			expect(casCalls()).toEqual([]);

			h.storyRows[0] = mcpStory({ externalMcpServerId: ADO_SERVER });
			await expect(runMcpLeaf(null)).resolves.toEqual({
				outcome: "moved",
			});
			expect(casCalls()).toEqual([
				{
					where: { ...CAS_WHERE, pmStatusSyncBaseLink: "101" },
					data: {
						statusId: REVIEW.id,
						order: 8,
						pmStatusSyncBaseId: REVIEW.id,
						pmStatusSyncBaseAt: D1,
						pmStatusSyncBaseLink: "101",
						pmStatusSyncBaseFabricId: REVIEW.id,
						lastEditedAt: NOW,
						lastEditedSource: "PM_PULL",
						lastEditedByName: null,
					},
				},
			]);
		});

		it("a story stamped with the active server verifies; one stamped with another server does not", async () => {
			h.storyRows[0] = mcpStory({ externalMcpServerId: ADO_SERVER });
			await expect(runMcpLeaf(null)).resolves.toEqual({
				outcome: "moved",
			});
			// Positive control for the no-write assertion below.
			expect(casCalls()).toHaveLength(1);

			h.storyRows[0] = mcpStory({ externalMcpServerId: "srv-other" });
			h.calls.length = 0;
			await expect(runMcpLeaf(null)).resolves.toEqual({
				outcome: "unverified",
			});
			expect(casCalls()).toEqual([]);
			expect(conflictRows()).toHaveLength(1);
			expect(
				(conflictRows()[0].errorPayload as Record<string, unknown>)
					.dedupeKey,
			).toBe(
				`status-sync:unverified:story-42:server=srv-other;url=${adoUrl("example-org", "101")}`,
			);
		});

		it("a never-stamped story verifies only through the project's trusted org", async () => {
			h.storyRows[0] = mcpStory({ externalMcpServerId: null });
			await expect(runMcpLeaf(TRUSTED)).resolves.toEqual({
				outcome: "moved",
			});
			// Positive control for the no-write assertions below.
			expect(casCalls()).toHaveLength(1);

			h.storyRows[0] = mcpStory({
				externalMcpServerId: null,
				externalUrl: adoUrl("other-org", "101"),
			});
			h.calls.length = 0;
			await expect(runMcpLeaf(TRUSTED)).resolves.toEqual({
				outcome: "unverified",
			});
			expect(casCalls()).toEqual([]);

			h.storyRows[0] = mcpStory({ externalMcpServerId: null });
			await expect(runMcpLeaf({ kind: "none" })).resolves.toEqual({
				outcome: "unverified",
			});
			expect(casCalls()).toEqual([]);
		});
	});
});

describe("isLinkedIssue", () => {
	const base = {
		isRest: false,
		storyExternalUrl:
			"https://dev.azure.com/example-org/Portal/_workitems/edit/101",
		storyExternalMcpServerId: null,
		itemUrl: null,
		activeServerId: "srv-ado",
		pmToolKey: "azure-devops",
		activeOrg: { kind: "trusted", key: "example-org" } as TrustedKey | null,
	};

	it.each([
		[
			"REST: equal URLs",
			{ isRest: true, storyExternalUrl: URL_42, itemUrl: URL_42 },
			true,
		],
		[
			"REST: a different path case is a different issue",
			{
				isRest: true,
				storyExternalUrl: URL_42,
				itemUrl: "https://gitlab.example.com/ACME/portal/-/issues/42",
			},
			false,
		],
		[
			"REST: no stored URL",
			{ isRest: true, storyExternalUrl: null, itemUrl: URL_42 },
			false,
		],
		[
			"REST: no fetched URL",
			{ isRest: true, storyExternalUrl: URL_42, itemUrl: undefined },
			false,
		],
		[
			"MCP: stamped with the active server",
			{ storyExternalMcpServerId: "srv-ado" },
			true,
		],
		[
			"MCP: stamped with another server",
			{ storyExternalMcpServerId: "srv-jira" },
			false,
		],
		["MCP: never stamped, URL in the trusted org", {}, true],
		[
			"MCP: never stamped, URL in another org",
			{
				storyExternalUrl:
					"https://dev.azure.com/other-org/Portal/_workitems/edit/101",
			},
			false,
		],
		[
			"MCP: never stamped, no trusted org",
			{ activeOrg: { kind: "none" } },
			false,
		],
		[
			"MCP: never stamped, ambiguous org",
			{ activeOrg: { kind: "ambiguous", reason: "multitenant" } },
			false,
		],
		["MCP: never stamped, org not resolved", { activeOrg: null }, false],
		[
			"MCP: never stamped, URL on another known tool's host",
			{
				storyExternalUrl:
					"https://github.com/example-org/portal/issues/101",
			},
			false,
		],
		[
			"MCP: never stamped, no stored URL",
			{ storyExternalUrl: null },
			false,
		],
		[
			"MCP: never stamped, unknown tool key",
			{ pmToolKey: "slack-remote" },
			false,
		],
	] as const)("%s", (_name, over, expected) => {
		expect(
			isLinkedIssue({ ...base, ...over } as Parameters<
				typeof isLinkedIssue
			>[0]),
		).toBe(expected);
	});
});

describe("normalizeIssueUrl / statusSyncLinkKey", () => {
	it("trims, drops trailing slashes and lower-cases only the scheme and host", () => {
		expect(
			normalizeIssueUrl(
				"  HTTPS://GitLab.Example.COM/Acme/Portal/-/issues/42//  ",
			),
		).toBe("https://gitlab.example.com/Acme/Portal/-/issues/42");
	});

	it("uses the issue URL for REST and the external id for MCP", () => {
		const story = { externalUrl: URL_42, externalId: "42" };
		expect(statusSyncLinkKey(story, true)).toBe(URL_42);
		expect(statusSyncLinkKey(story, false)).toBe("42");
		expect(
			statusSyncLinkKey({ externalUrl: null, externalId: "42" }, true),
		).toBeNull();
		expect(
			statusSyncLinkKey({ externalUrl: URL_42, externalId: "" }, false),
		).toBeNull();
	});

	it("REST: a trailing-slash URL and an upper-case-host URL key the same as the canonical URL (Codex C5)", () => {
		const trailingSlash = { externalUrl: `${URL_42}/`, externalId: "42" };
		const upperCaseHost = {
			externalUrl: "https://GitLab.Example.COM/acme/portal/-/issues/42",
			externalId: "42",
		};
		expect(statusSyncLinkKey(trailingSlash, true)).toBe(URL_42);
		expect(statusSyncLinkKey(upperCaseHost, true)).toBe(URL_42);
	});

	it("MCP: the external id passes through unchanged — no normalization applied", () => {
		// Mixed case and no URL shape at all: if this were run through
		// `normalizeIssueUrl` it would come back lower-cased or mangled.
		const story = { externalUrl: null, externalId: "ABC-Ticket-42" };
		expect(statusSyncLinkKey(story, false)).toBe("ABC-Ticket-42");
	});
});

describe("recordTerminalObservation — row 1", () => {
	it("records __terminal__ against Fabric's status through an exact compare-and-set, leaving the status alone", async () => {
		await recordTerminalObservation({
			projectId: PROJECT_ID,
			story: await readStory(),
			linkKey: URL_42,
			stateChangedDate: D1,
		});
		expect(casCalls()).toEqual([
			{
				where: CAS_WHERE,
				data: {
					pmStatusSyncBaseId: "__terminal__",
					pmStatusSyncBaseAt: D1,
					pmStatusSyncBaseLink: URL_42,
					pmStatusSyncBaseFabricId: TODO.id,
				},
			},
		]);
		expect(story42().statusId).toBe(TODO.id);
	});

	it("writes nothing when the base already says terminal for this link — but does for another link", async () => {
		h.storyRows[0] = storyRow({
			pmStatusSyncBaseId: "__terminal__",
			pmStatusSyncBaseLink: issueUrl("41"),
		});
		await recordTerminalObservation({
			projectId: PROJECT_ID,
			story: await readStory(),
			linkKey: URL_42,
			stateChangedDate: D1,
		});
		expect(casCalls()).toHaveLength(1);

		h.calls.length = 0;
		await recordTerminalObservation({
			projectId: PROJECT_ID,
			story: await readStory(),
			linkKey: URL_42,
			stateChangedDate: D2,
		});
		expect(casCalls()).toEqual([]);
	});

	it("a terminal observation makes the reopen that follows a change (AC6/AC7)", async () => {
		h.storyRows[0] = storyRow({
			statusId: PROGRESS.id,
			pmStatusSyncBaseId: PROGRESS.id,
			pmStatusSyncBaseFabricId: PROGRESS.id,
		});
		await recordTerminalObservation({
			projectId: PROJECT_ID,
			story: await readStory(),
			linkKey: URL_42,
			stateChangedDate: D1,
		});
		story42().statusId = TODO.id; // moved in Fabric while the ticket was closed

		await expect(
			runLeaf({
				item: {
					labels: ["workflow::in-progress"],
					stateChangedDate: D2,
				},
			}),
		).resolves.toEqual({ outcome: "moved" });
		expect(story42().statusId).toBe(PROGRESS.id);
	});
});

describe("leaf discipline", () => {
	it("never imports story-sync or pm-state-poll", () => {
		const source = readFileSync(
			join(
				dirname(fileURLToPath(import.meta.url)),
				"..",
				"src",
				"activities",
				"pm-integration",
				"reconcile-story-mapped-status.ts",
			),
			"utf-8",
		);
		// Positive control: the scan really reads this module's imports.
		expect(source).toContain('from "./record-pm-sync-log"');
		expect(source).not.toMatch(/from "\.\/(story-sync|pm-state-poll)"/);
	});
});
