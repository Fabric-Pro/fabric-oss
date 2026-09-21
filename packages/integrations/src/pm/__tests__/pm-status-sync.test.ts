import { describe, expect, it } from "vitest";
import {
	decidePmStatusSync,
	PM_STATUS_SYNC_SENTINEL,
	type ResolvedTicketStatus,
	STATUS_SYNC_OUTCOMES,
	type StatusSyncBase,
	shouldPushStatusLabels,
	toResolvedTicketStatus,
} from "../pm-status-sync";

/*
 * The status-sync decision table (Fizzy #2304, spec §4.4 rows 4–10 and §4.5
 * step 2). Every row has a HIT fixture and a NEAR-MISS fixture that differs in
 * exactly the one fact the row keys on.
 *
 * Fixtures are realistic: the link key is a stored REST issue URL, every
 * observation carries a ticket clock, and the base was recorded against that
 * same link unless a test is about a relink.
 */
const K = "https://gitlab.example.com/acme/portal/-/issues/42";
const RELINKED_K = "https://gitlab.example.com/acme/portal/-/issues/57";

const TODO = "st-todo";
const PROGRESS = "st-progress";
const REVIEW = "st-review";

const T0 = new Date("2026-09-01T10:00:00.000Z");
const D_NEWER = new Date("2026-09-02T10:00:00.000Z");
const D_OLDER = new Date("2026-08-31T10:00:00.000Z");

const { NONE, AMBIGUOUS, TERMINAL } = PM_STATUS_SYNC_SENTINEL;
const SENTINELS: ReadonlySet<string> = new Set([NONE, AMBIGUOUS, TERMINAL]);

const status = (statusId: string): ResolvedTicketStatus => ({
	kind: "status",
	statusId,
});
const none: ResolvedTicketStatus = { kind: "none" };
const ambiguous: ResolvedTicketStatus = {
	kind: "ambiguous",
	statusIds: [PROGRESS, REVIEW],
	labels: ["workflow::in-progress", "workflow::in-review"],
};
/**
 * A base as the writers leave it. F (the Fabric status the observation was
 * made against) equals P for a status-id base — rows 8 and 10 and the push
 * stamp all write F = P. A sentinel base was recorded while Fabric showed
 * TODO unless a test passes F explicitly.
 */
const base = (
	baseId: string | null,
	baseAt: Date | null = T0,
	baseLink: string | null = K,
	baseFabricId: string | null = baseId === null
		? null
		: SENTINELS.has(baseId)
			? TODO
			: baseId,
): StatusSyncBase => ({ baseId, baseAt, baseLink, baseFabricId });
const NO_BASE: StatusSyncBase = {
	baseId: null,
	baseAt: null,
	baseLink: null,
	baseFabricId: null,
};

type DecideInput = Parameters<typeof decidePmStatusSync>[0];
type Decision = ReturnType<typeof decidePmStatusSync>;

/** Default: the ticket moved TODO → REVIEW since the last observation. */
const input = (over: Partial<DecideInput> = {}): DecideInput => ({
	resolved: status(REVIEW),
	fabricStatusId: TODO,
	base: base(TODO),
	linkKey: K,
	stateChangedDate: D_NEWER,
	pushConflictPending: false,
	...over,
});

const moved = (to: string, at: Date | null = D_NEWER): Decision => ({
	outcome: "moved",
	write: {
		statusId: to,
		baseId: to,
		baseAt: at,
		baseLink: K,
		baseFabricId: to,
	},
});

interface RowCase {
	row: string;
	name: string;
	input: DecideInput;
	expected: Decision;
}

const ROWS: RowCase[] = [
	{
		row: "4 hit",
		name: "an unresolved push CONFLICT skips the story",
		input: input({ pushConflictPending: true }),
		expected: { outcome: "skipped-conflict", write: null },
	},
	{
		row: "4 near-miss",
		name: "the same ticket change with no push CONFLICT moves",
		input: input({ pushConflictPending: false }),
		expected: moved(REVIEW),
	},
	{
		row: "5 hit",
		name: "an observation older than the base clock is stale",
		input: input({ stateChangedDate: D_OLDER }),
		expected: { outcome: "stale", write: null },
	},
	{
		row: "5 near-miss",
		name: "an observation AT the base clock is not stale",
		input: input({ stateChangedDate: T0 }),
		expected: moved(REVIEW, T0),
	},
	{
		row: "5 near-miss",
		name: "a ticket with no clock is never stale",
		input: input({ stateChangedDate: null }),
		expected: moved(REVIEW, null),
	},
	{
		row: "6 hit",
		name: "no mapped status records the __none__ sentinel against Fabric's status",
		input: input({ resolved: none, base: base(PROGRESS) }),
		expected: {
			outcome: "not-mapped",
			write: {
				baseId: NONE,
				baseAt: D_NEWER,
				baseLink: K,
				baseFabricId: TODO,
			},
		},
	},
	{
		row: "6 near-miss",
		name: "no mapped status again writes nothing",
		input: input({ resolved: none, base: base(NONE) }),
		expected: { outcome: "not-mapped", write: null },
	},
	{
		row: "6 near-miss",
		name: "a Fabric move while the ticket stays unmapped leaves F behind, so a push can still carry it",
		input: input({
			resolved: none,
			fabricStatusId: PROGRESS,
			base: base(NONE, T0, K, TODO),
		}),
		expected: { outcome: "not-mapped", write: null },
	},
	{
		row: "7 hit",
		name: "conflicting labels record the __ambiguous__ sentinel against Fabric's status",
		input: input({ resolved: ambiguous, base: base(TODO) }),
		expected: {
			outcome: "ambiguous",
			write: {
				baseId: AMBIGUOUS,
				baseAt: D_NEWER,
				baseLink: K,
				baseFabricId: TODO,
			},
		},
	},
	{
		row: "7 near-miss",
		name: "still-conflicting labels write nothing",
		input: input({ resolved: ambiguous, base: base(AMBIGUOUS) }),
		expected: { outcome: "ambiguous", write: null },
	},
	{
		row: "8 hit",
		name: "a ticket that already matches Fabric records the observation",
		input: input({
			resolved: status(PROGRESS),
			fabricStatusId: PROGRESS,
			base: base(TODO),
		}),
		expected: {
			outcome: "unchanged",
			write: {
				baseId: PROGRESS,
				baseAt: D_NEWER,
				baseLink: K,
				baseFabricId: PROGRESS,
			},
		},
	},
	{
		row: "8 near-miss",
		name: "a ticket that matches Fabric and the base writes nothing",
		input: input({
			resolved: status(PROGRESS),
			fabricStatusId: PROGRESS,
			base: base(PROGRESS),
		}),
		expected: { outcome: "unchanged", write: null },
	},
	{
		row: "9 hit",
		name: "a ticket still showing the observed status keeps a Fabric-only move",
		input: input({
			resolved: status(TODO),
			fabricStatusId: PROGRESS,
			base: base(TODO),
		}),
		expected: { outcome: "fabric-ahead", write: null },
	},
	{
		row: "9 near-miss",
		name: "a ticket that changed since the observation wins over the Fabric move",
		input: input({
			resolved: status(TODO),
			fabricStatusId: PROGRESS,
			base: base(REVIEW),
		}),
		expected: moved(TODO),
	},
	{
		row: "10 hit",
		name: "a ticket change Fabric has not seen moves the story",
		input: input(),
		expected: moved(REVIEW),
	},
	{
		row: "10 near-miss",
		name: "the same statuses with the base already at the ticket's status do not move",
		input: input({ base: base(REVIEW) }),
		expected: { outcome: "fabric-ahead", write: null },
	},
];

describe("decidePmStatusSync — spec §4.4 rows 4–10", () => {
	it.each(ROWS)("row $row: $name", ({ input: decideInput, expected }) => {
		expect(decidePmStatusSync(decideInput)).toEqual(expected);
	});

	it("does not mutate its input", () => {
		const frozen = Object.freeze({
			...input(),
			base: Object.freeze(base(TODO)),
			resolved: Object.freeze(status(REVIEW)),
		});
		expect(decidePmStatusSync(frozen)).toEqual(moved(REVIEW));
	});
});

describe("decidePmStatusSync — the base counts only for the current link", () => {
	it("a first observation that differs from Fabric moves the story (AC5)", () => {
		expect(decidePmStatusSync(input({ base: NO_BASE }))).toEqual(
			moved(REVIEW),
		);
	});

	it("a base recorded against another link is a first observation, not Fabric-ahead", () => {
		// Positive control: on the current link this base makes it Fabric-ahead.
		expect(decidePmStatusSync(input({ base: base(REVIEW) })).outcome).toBe(
			"fabric-ahead",
		);
		expect(
			decidePmStatusSync(input({ base: base(REVIEW, T0, RELINKED_K) })),
		).toEqual(moved(REVIEW));
	});

	it("a base clock from another link cannot make an observation stale", () => {
		expect(
			decidePmStatusSync(input({ stateChangedDate: D_OLDER })).outcome,
		).toBe("stale");
		expect(
			decidePmStatusSync(
				input({
					stateChangedDate: D_OLDER,
					base: base(TODO, T0, RELINKED_K),
				}),
			),
		).toEqual(moved(REVIEW, D_OLDER));
	});

	it("a sentinel recorded against another link is re-recorded against this one", () => {
		expect(
			decidePmStatusSync(input({ resolved: none, base: base(NONE) }))
				.write,
		).toBeNull();
		expect(
			decidePmStatusSync(
				input({ resolved: none, base: base(NONE, T0, RELINKED_K) }),
			),
		).toEqual({
			outcome: "not-mapped",
			write: {
				baseId: NONE,
				baseAt: D_NEWER,
				baseLink: K,
				baseFabricId: TODO,
			},
		});
	});
});

/** A story as the leaf sees it, with each decision's write applied. */
interface StoryState {
	statusId: string;
	base: StatusSyncBase;
}

function observe(
	story: StoryState,
	resolved: ResolvedTicketStatus,
	at: Date,
): { decision: Decision; story: StoryState } {
	const decision = decidePmStatusSync({
		resolved,
		fabricStatusId: story.statusId,
		base: story.base,
		linkKey: K,
		stateChangedDate: at,
		pushConflictPending: false,
	});
	if (decision.write === null) {
		return { decision, story };
	}
	return {
		decision,
		story: {
			statusId: decision.write.statusId ?? story.statusId,
			base: {
				baseId: decision.write.baseId,
				baseAt: decision.write.baseAt,
				baseLink: decision.write.baseLink,
				baseFabricId: decision.write.baseFabricId,
			},
		},
	};
}

const fabricMove = (story: StoryState, to: string): StoryState => ({
	...story,
	statusId: to,
});

describe("decidePmStatusSync — no-status observations count as changes (AC6)", () => {
	const D1 = new Date("2026-09-02T10:00:00.000Z");
	const D2 = new Date("2026-09-03T10:00:00.000Z");
	const D3 = new Date("2026-09-04T10:00:00.000Z");

	it("control: without a no-status observation in between, a Fabric move stands", () => {
		let story: StoryState = { statusId: PROGRESS, base: NO_BASE };
		story = observe(story, status(PROGRESS), D1).story;
		story = fabricMove(story, REVIEW);
		expect(observe(story, status(PROGRESS), D3).decision).toEqual({
			outcome: "fabric-ahead",
			write: null,
		});
	});

	it.each([
		["no mapped status", none, NONE],
		["ambiguous labels", ambiguous, AMBIGUOUS],
	])(
		"mapped → %s → mapped again, with a Fabric move in between, moves the story",
		(_label, noStatus, sentinel) => {
			let story: StoryState = { statusId: PROGRESS, base: NO_BASE };

			const first = observe(story, status(PROGRESS), D1);
			expect(first.decision.outcome).toBe("unchanged");
			story = first.story;
			expect(story.base).toEqual(base(PROGRESS, D1));

			const gap = observe(story, noStatus, D2);
			story = gap.story;
			// Recorded against the Fabric status of that moment (L = PROGRESS).
			expect(story.base).toEqual(base(sentinel, D2, K, PROGRESS));

			story = fabricMove(story, REVIEW);

			const back = observe(story, status(PROGRESS), D3);
			expect(back.decision).toEqual(moved(PROGRESS, D3));
			expect(back.story.statusId).toBe(PROGRESS);
		},
	);

	it("a terminal observation (as recordTerminalObservation writes it) makes the reopen a change", () => {
		const story: StoryState = {
			statusId: REVIEW, // moved in Fabric while the ticket was closed
			// recordTerminalObservation wrote F = L = PROGRESS at close time.
			base: base(TERMINAL, D2, K, PROGRESS),
		};
		expect(observe(story, status(PROGRESS), D3).decision).toEqual(
			moved(PROGRESS, D3),
		);
	});
});

describe("decidePmStatusSync — a stale verdict after a push stamp", () => {
	const STAMP = new Date("2026-09-03T08:00:00.000Z");

	it("a verdict fetched before the push stamped the base is stale; one fetched after it is not", () => {
		const pushed = input({
			resolved: status(TODO), // the labels the ticket carried before the push
			fabricStatusId: PROGRESS,
			base: base(PROGRESS, STAMP),
		});
		expect(
			decidePmStatusSync({
				...pushed,
				stateChangedDate: new Date("2026-09-03T08:05:00.000Z"),
			}),
		).toEqual(moved(TODO, new Date("2026-09-03T08:05:00.000Z")));
		expect(
			decidePmStatusSync({
				...pushed,
				stateChangedDate: new Date("2026-09-03T07:59:00.000Z"),
			}),
		).toEqual({ outcome: "stale", write: null });
	});
});

describe("shouldPushStatusLabels — spec §4.5 step 2", () => {
	/** Default: observed To Do while Fabric showed To Do; Fabric then moved to In Progress. */
	const gate = (
		over: Partial<Parameters<typeof shouldPushStatusLabels>[0]>,
	) =>
		shouldPushStatusLabels({
			fabricStatusId: PROGRESS,
			base: base(TODO),
			linkKey: K,
			liveResolved: status(TODO),
			...over,
		});

	it.each([
		[
			"Fabric moved since the observation (L≠F) and the ticket still shows it (R_live=P) → replace labels",
			{},
			true,
		],
		[
			"L=F → Fabric did not move since the observation: no label change",
			{ fabricStatusId: TODO },
			false,
		],
		[
			"R_live≠P → the ticket changed: leave it for the poll",
			{ liveResolved: status(REVIEW) },
			false,
		],
		[
			"no base → leave it for the poll's first observation",
			{ base: NO_BASE, liveResolved: status(TODO) },
			false,
		],
		[
			"a base from another link counts as no base",
			{ base: base(TODO, T0, RELINKED_K) },
			false,
		],
		[
			"P=__none__ recorded at To Do, Fabric since moved, ticket still unmapped → replace",
			{ base: base(NONE, T0, K, TODO), liveResolved: none },
			true,
		],
		[
			"P=__none__ recorded at Fabric's current status → no label change (AC12)",
			{ base: base(NONE, T0, K, PROGRESS), liveResolved: none },
			false,
		],
		[
			"P=__none__ but the ticket gained a mapped label",
			{ base: base(NONE, T0, K, TODO), liveResolved: status(REVIEW) },
			false,
		],
		[
			"P=__ambiguous__ recorded at To Do, Fabric since moved, still ambiguous → replace",
			{ base: base(AMBIGUOUS, T0, K, TODO), liveResolved: ambiguous },
			true,
		],
		[
			"P=__ambiguous__ recorded at Fabric's current status → no label change",
			{ base: base(AMBIGUOUS, T0, K, PROGRESS), liveResolved: ambiguous },
			false,
		],
		[
			"P=__terminal__ never matches a live resolution",
			{ base: base(TERMINAL, T0, K, TODO), liveResolved: status(TODO) },
			false,
		],
	] as const)("%s", (_name, over, expected) => {
		expect(gate(over)).toBe(expected);
	});
});

describe("poll → push trace: a ticket moved to an unmapped label (AC12)", () => {
	const D1 = new Date("2026-09-02T10:00:00.000Z");
	const D2 = new Date("2026-09-03T10:00:00.000Z");
	const push = (story: StoryState, liveResolved: ResolvedTicketStatus) =>
		shouldPushStatusLabels({
			fabricStatusId: story.statusId,
			base: story.base,
			linkKey: K,
			liveResolved,
		});

	it("a content-only push does not re-add the dropped labels; a later Fabric move is pushed", () => {
		// In sync at In Progress (as a push stamp or row 8 leaves it).
		let story: StoryState = {
			statusId: PROGRESS,
			base: base(PROGRESS, D1),
		};
		// Positive control: a Fabric move from this base IS pushed.
		expect(push(fabricMove(story, REVIEW), status(PROGRESS))).toBe(true);

		// The ticket's workflow label is replaced by one the map does not know.
		// The poll records __none__ against the Fabric status of that moment.
		const polled = observe(story, none, D2);
		expect(polled.decision).toEqual({
			outcome: "not-mapped",
			write: {
				baseId: NONE,
				baseAt: D2,
				baseLink: K,
				baseFabricId: PROGRESS,
			},
		});
		story = polled.story;

		// A content-only push (Fabric still In Progress) leaves the labels alone.
		expect(push(story, none)).toBe(false);

		// A Fabric move after that is carried to the ticket.
		story = fabricMove(story, REVIEW);
		expect(push(story, none)).toBe(true);
	});
});

describe("toResolvedTicketStatus", () => {
	it("maps a matched resolution to a status", () => {
		expect(
			toResolvedTicketStatus({
				kind: "matched",
				statusId: REVIEW,
				via: "label",
			}),
		).toEqual({ kind: "status", statusId: REVIEW });
	});

	it("maps a conflict to ambiguous, keeping statuses and labels", () => {
		expect(
			toResolvedTicketStatus({
				kind: "conflict",
				statusIds: [PROGRESS, REVIEW],
				labels: ["workflow::in-progress", "workflow::in-review"],
			}),
		).toEqual(ambiguous);
	});

	it("maps none to none", () => {
		expect(toResolvedTicketStatus({ kind: "none" })).toEqual({
			kind: "none",
		});
	});
});

describe("vocabulary", () => {
	it("lists the nine outcomes and the three sentinels", () => {
		expect([...STATUS_SYNC_OUTCOMES]).toEqual([
			"moved",
			"unchanged",
			"fabric-ahead",
			"not-mapped",
			"ambiguous",
			"unverified",
			"stale",
			"skipped-conflict",
			"raced",
		]);
		expect(PM_STATUS_SYNC_SENTINEL).toEqual({
			NONE: "__none__",
			AMBIGUOUS: "__ambiguous__",
			TERMINAL: "__terminal__",
		});
	});
});
