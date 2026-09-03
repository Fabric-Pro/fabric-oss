import { beforeEach, expect, it, vi } from "vitest";

const isProjectReadOnly = vi.fn(async () => false);
const assertPublishingCycleTenant = vi.fn();
const getPublishingSuiteSettings = vi.fn();
const readCycleNotificationState = vi.fn();
const listCycleTopics = vi.fn();
const getLinkedTeamsChannels = vi.fn();
const getLinkedSlackChannels = vi.fn();
const isScheduledNewsletterActorValid = vi.fn();
const claimPublishingChatDelivery = vi.fn();

// Stateful in-memory ledger: the activity derives its RETURN from the ledger, so
// a list mock that ignored what was written would let a broken derivation pass.
//
// Rows are KEYED and updated in place, because that is what the table does — a
// naive append made a claim followed by a settle look like two delivered
// channels, which is a way for a broken count to pass.
type LedgerRow = {
	key: string;
	status: string;
	reason?: string | null;
};
let ledger: LedgerRow[] = [];
const rowKey = (i: {
	platform?: string;
	externalTeamId?: string;
	channelId?: string;
}) => `${i.platform}:${i.externalTeamId}:${i.channelId}`;

const markPublishingChatDelivery = vi.fn(
	async (i: {
		status: string;
		reason?: string;
		platform?: string;
		externalTeamId?: string;
		channelId?: string;
	}) => {
		const key = rowKey(i);
		const row = ledger.find((r) => r.key === key);
		if (row) {
			row.status = i.status;
			row.reason = i.reason ?? null;
			return;
		}
		ledger.push({ key, status: i.status, reason: i.reason ?? null });
	},
);

vi.mock("@repo/database", () => ({
	logDraftRefusal: vi.fn(),
	isProjectReadOnly: (...a: unknown[]) => isProjectReadOnly(...(a as [])),
	assertPublishingCycleTenant: (...a: unknown[]) =>
		assertPublishingCycleTenant(...a),
	getPublishingSuiteSettings: (...a: unknown[]) =>
		getPublishingSuiteSettings(...a),
	readCycleNotificationState: (...a: unknown[]) =>
		readCycleNotificationState(...a),
	listPublishingTopicsForCycle: (...a: unknown[]) => listCycleTopics(...a),
	getLinkedTeamsChannels: (...a: unknown[]) => getLinkedTeamsChannels(...a),
	getLinkedSlackChannels: (...a: unknown[]) => getLinkedSlackChannels(...a),
	isScheduledNewsletterActorValid: (...a: unknown[]) =>
		isScheduledNewsletterActorValid(...a),
	claimPublishingChatDelivery: (...a: unknown[]) =>
		claimPublishingChatDelivery(...a),
	// Single-parameter wrapper, NOT a spread: a typed-object vi.fn() wrapped as
	// `(...a: unknown[]) => fn(...a)` trips TS2556 ("spread argument must be a
	// tuple or match a rest parameter"), the same reason the sibling newsletter
	// suite wraps its own mark this way.
	markPublishingChatDelivery: (i: { status: string; reason?: string }) =>
		markPublishingChatDelivery(i),
	listPublishingChatDeliveriesForCycle: async () => ledger,
	// The activity reads the project name and the workspace slug directly, the
	// way notify-topics-ready.ts does at its own link-building step.
	db: {
		project: { findUnique: async () => ({ name: "Example Project" }) },
		organization: { findUnique: async () => ({ slug: "example-org" }) },
	},
}));

const postToTeams = vi.fn();
// This file lives in publishing-suggestion/__tests__/, two levels below
// activities/, so the source module's own "../teams-mention" is mirrored here as
// "../../teams-mention".
vi.mock("../../teams-mention", () => ({
	postToTeams: (...a: unknown[]) => postToTeams(...a),
}));

const getSlackCredentials = vi.fn();
// Mocked at the credentials RESOLVER, not the whole "@repo/integrations" module.
// Mocking the package wholesale is exactly why a trigger-gated-credentials bug
// stayed invisible on the newsletter path: the mock swallowed the real resolver
// call entirely.
vi.mock("@repo/integrations/slack", () => ({
	getSlackCredentials: (...a: unknown[]) => getSlackCredentials(...a),
}));

// Controllable render mock, declared with its real 2-arg arity and wrapped
// WITHOUT a spread, so the render-throws-before-claim case can be driven.
const renderPublishingChatMessage = vi.fn((_c: unknown, _o: unknown) => ({
	text: "teaser",
}));
vi.mock("@repo/utils", () => ({
	getBaseUrl: () => "https://app.example.com",
	renderPublishingChatMessage: (c: unknown, o: unknown) =>
		renderPublishingChatMessage(c, o),
}));
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
// `vi.hoisted`, not a plain top-level const: vi.mock factories are hoisted above
// every other top-level statement, so a factory closing over `const logger` hits
// a TDZ error at collection ("Cannot access 'logger' before initialization") and
// the whole FILE fails rather than one case. The sibling newsletter suite
// side-steps this by declaring its logger inline in the factory — which works
// only because it never asserts on the logger. This suite does.
const logger = vi.hoisted(() => ({
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
}));
vi.mock("@repo/logs", () => ({ logger }));

// The mocked `heartbeat` above, pulled into scope so a case can assert on it.
// The activity's liveness signal is part of its contract with the proxy's
// `heartbeatTimeout`, and nothing else in this suite would notice it changing.
import { heartbeat } from "@temporalio/activity";
import { broadcastPublishingTopicsToChat } from "../broadcast-topics-to-chat";

const TENANT = {
	projectId: "proj-1",
	organizationId: null,
	userId: "user-1",
};
const INPUT = { cycleId: "cycle-1", tenant: TENANT };

const SLACK_SELECTION = [
	{ platform: "SLACK" as const, teamId: "T-example", channelId: "C-example" },
];

const linkedSlackRow = {
	slackTeamId: "T-example",
	channelId: "C-example",
	userId: "linker-1",
	organizationId: null,
};

function slackResponse(body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	ledger = [];
	isProjectReadOnly.mockResolvedValue(false);
	readCycleNotificationState.mockResolvedValue({ status: "READY" });
	getPublishingSuiteSettings.mockResolvedValue({
		notificationsEnabled: true,
		chatChannels: SLACK_SELECTION,
	});
	listCycleTopics.mockResolvedValue([{ title: "A topic", angle: null }]);
	getLinkedSlackChannels.mockResolvedValue([linkedSlackRow]);
	getLinkedTeamsChannels.mockResolvedValue([]);
	isScheduledNewsletterActorValid.mockResolvedValue(true);
	assertPublishingCycleTenant.mockResolvedValue("OK");
	// `mockImplementation` survives `vi.clearAllMocks()` — that only clears
	// recorded CALLS. Both stateful mocks are therefore re-installed here, or a
	// throwing implementation set by one case leaks into every case after it.
	markPublishingChatDelivery.mockImplementation(async (i) => {
		const key = rowKey(i);
		const row = ledger.find((r) => r.key === key);
		if (row) {
			row.status = i.status;
			row.reason = i.reason ?? null;
			return;
		}
		ledger.push({ key, status: i.status, reason: i.reason ?? null });
	});
	// The claim is an INSERT, so a successful one puts a row in the ledger — and
	// a skip now lands its final status in that one statement. Modelling it as a
	// bare `{claimed:true}` would leave the ledger empty and hide every count
	// derived from it.
	claimPublishingChatDelivery.mockImplementation(
		async (i: {
			status?: string;
			reason?: string;
			platform?: string;
			externalTeamId?: string;
			channelId?: string;
		}) => {
			ledger.push({
				key: rowKey(i),
				status: i.status ?? "SENDING",
				reason: i.reason ?? null,
			});
			return { claimed: true };
		},
	);
	getSlackCredentials.mockResolvedValue({ accessToken: "xoxb-test" });
	renderPublishingChatMessage.mockImplementation(() => ({ text: "teaser" }));
	globalThis.fetch = vi
		.fn()
		.mockResolvedValue(
			slackResponse({ ok: true, ts: "1.1" }),
		) as unknown as typeof globalThis.fetch;
});

it("posts to a selected, linked channel and records SENT", async () => {
	const out = await broadcastPublishingTopicsToChat(INPUT);
	expect(out.sentCount).toBe(1);
	expect(markPublishingChatDelivery).toHaveBeenCalledWith(
		expect.objectContaining({ status: "SENT", postedMessageId: "1.1" }),
	);
});

// Each whole-run gate gets its own case AND asserts that no row was written. A
// case that only checked the counts would pass against an implementation that
// writes SKIPPED rows for every target — which would then make the NEXT
// attempt's claim refuse a channel that was never actually refused.
it.each([
	[
		"the cycle is not READY",
		() =>
			readCycleNotificationState.mockResolvedValue({ status: "FAILED" }),
	],
	[
		"the project kill switch is off",
		() =>
			getPublishingSuiteSettings.mockResolvedValue({
				notificationsEnabled: false,
				chatChannels: SLACK_SELECTION,
			}),
	],
	[
		"no channels are selected",
		() =>
			getPublishingSuiteSettings.mockResolvedValue({
				notificationsEnabled: true,
				chatChannels: [],
			}),
	],
	[
		"the selection is null",
		() =>
			getPublishingSuiteSettings.mockResolvedValue({
				notificationsEnabled: true,
				chatChannels: null,
			}),
	],
	["the cycle has no topics", () => listCycleTopics.mockResolvedValue([])],
	[
		"the project is read-only",
		() => isProjectReadOnly.mockResolvedValue(true),
	],
])(
	"issues no provider call and writes no row when %s",
	async (_label, arrange) => {
		arrange();
		const out = await broadcastPublishingTopicsToChat(INPUT);
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(postToTeams).not.toHaveBeenCalled();
		expect(claimPublishingChatDelivery).not.toHaveBeenCalled();
		expect(markPublishingChatDelivery).not.toHaveBeenCalled();
		expect(out.sentCount).toBe(0);
	},
);

// A skip lands its final status in the CLAIM, in one statement. It used to
// claim SENDING and then settle, and a failure between the two left a SENDING
// row — counted as delivered — for a channel this path deliberately refused and
// never contacted. Asserting no `mark` call is what pins the single write.
it("skips a selection whose channel is no longer linked, on that reason", async () => {
	getLinkedSlackChannels.mockResolvedValue([]);
	await broadcastPublishingTopicsToChat(INPUT);
	expect(claimPublishingChatDelivery).toHaveBeenCalledWith(
		expect.objectContaining({
			status: "SKIPPED",
			reason: "CHANNEL_NOT_LINKED",
		}),
	);
	expect(markPublishingChatDelivery).not.toHaveBeenCalled();
	expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("skips a channel whose linker is no longer authorized, on that reason", async () => {
	isScheduledNewsletterActorValid.mockResolvedValue(false);
	await broadcastPublishingTopicsToChat(INPUT);
	expect(claimPublishingChatDelivery).toHaveBeenCalledWith(
		expect.objectContaining({
			status: "SKIPPED",
			reason: "LINKER_NOT_AUTHORIZED",
		}),
	);
	expect(markPublishingChatDelivery).not.toHaveBeenCalled();
	expect(globalThis.fetch).not.toHaveBeenCalled();
});

// Raised by the adversarial panel: the gate BOTH sibling publishing activities
// treat as mandatory, and which this one was missing. An archived, soft-deleted
// or transferred project must not announce its topics to a room — and cannot be
// walked back, since chat never re-posts and there is no drain.
it("issues no provider call and writes no row when the project tenant changed", async () => {
	assertPublishingCycleTenant.mockResolvedValue("TENANT_CHANGED");
	const out = await broadcastPublishingTopicsToChat(INPUT);
	expect(globalThis.fetch).not.toHaveBeenCalled();
	expect(postToTeams).not.toHaveBeenCalled();
	expect(claimPublishingChatDelivery).not.toHaveBeenCalled();
	expect(out.sentCount).toBe(0);
	const aggregate = logger.info.mock.calls.filter(
		(c) => c[0] === "publishing chat broadcast complete",
	);
	expect(aggregate[0][1]).toMatchObject({ gate: "tenant-changed" });
});

// The gate must be asked BEFORE any provider work, not merely somewhere.
it("checks the tenant before reading linked channels", async () => {
	assertPublishingCycleTenant.mockResolvedValue("TENANT_CHANGED");
	await broadcastPublishingTopicsToChat(INPUT);
	expect(getLinkedSlackChannels).not.toHaveBeenCalled();
	expect(getLinkedTeamsChannels).not.toHaveBeenCalled();
});

// The two skips are told apart NOWHERE else — same status, same absence of a
// post. Without this, the two cases above would both pass against an
// implementation that hard-codes one reason for both.
it("records the two skip reasons distinctly", async () => {
	getLinkedSlackChannels.mockResolvedValue([]);
	await broadcastPublishingTopicsToChat(INPUT);
	const first = claimPublishingChatDelivery.mock.calls[0][0];

	claimPublishingChatDelivery.mockClear();
	ledger = [];
	getLinkedSlackChannels.mockResolvedValue([linkedSlackRow]);
	isScheduledNewsletterActorValid.mockResolvedValue(false);
	await broadcastPublishingTopicsToChat(INPUT);
	const second = claimPublishingChatDelivery.mock.calls[0][0];

	expect(first.reason).not.toBe(second.reason);
});

// The per-channel warn used to fire outside the `claimed` branch, so a retried
// attempt re-emitted it for every channel already recorded while writing
// nothing — the same divergence the aggregate line was fixed for, one function
// above it.
it("does not re-log a skip whose row another attempt already wrote", async () => {
	getLinkedSlackChannels.mockResolvedValue([]);
	claimPublishingChatDelivery.mockResolvedValue({ claimed: false });
	await broadcastPublishingTopicsToChat(INPUT);
	const skipLines = logger.warn.mock.calls.filter(
		(c) => c[0] === "publishing chat channel skipped",
	);
	expect(skipLines).toHaveLength(0);
});

// The ORDER in §3.3 step 1 is invisible to any test that only checks outcomes:
// claim-then-render and render-then-claim both end with no message posted. Only
// the absence of the claim call distinguishes them — and a SENDING row left by a
// post-claim render throw would be COUNTED AS DELIVERED.
it("creates no ledger row when the render throws", async () => {
	renderPublishingChatMessage.mockImplementation(() => {
		throw new Error("render blew up");
	});
	await expect(broadcastPublishingTopicsToChat(INPUT)).rejects.toThrow();
	expect(claimPublishingChatDelivery).not.toHaveBeenCalled();
});

it("never posts when the claim is refused", async () => {
	claimPublishingChatDelivery.mockResolvedValue({ claimed: false });
	const out = await broadcastPublishingTopicsToChat(INPUT);
	expect(globalThis.fetch).not.toHaveBeenCalled();
	expect(out.sentCount).toBe(0);
});

it("records FAILED with the provider error when the post is refused", async () => {
	globalThis.fetch = vi
		.fn()
		.mockResolvedValue(
			slackResponse({ ok: false, error: "channel_not_found" }),
		) as unknown as typeof globalThis.fetch;
	const out = await broadcastPublishingTopicsToChat(INPUT);
	expect(markPublishingChatDelivery).toHaveBeenCalledWith(
		expect.objectContaining({
			status: "FAILED",
			reason: "POST_FAILED",
			errorMessage: "channel_not_found",
		}),
	);
	expect(out.failedCount).toBe(1);
});

// A row can be left SENDING only if the process died between the provider
// accepting and the confirming write landing. Counting it as failed would
// re-post next run, and a duplicate in a shared channel is worse than an
// unconfirmed count.
it("counts a SENDING row as delivered", async () => {
	ledger = [
		{
			key: rowKey({
				platform: "SLACK",
				externalTeamId: "T-example",
				channelId: "C-example",
			}),
			status: "SENDING",
		},
	];
	claimPublishingChatDelivery.mockResolvedValue({ claimed: false });
	const out = await broadcastPublishingTopicsToChat(INPUT);
	expect(out.sentCount).toBe(1);
});

it("resolves the linker once for two channels sharing it", async () => {
	getPublishingSuiteSettings.mockResolvedValue({
		notificationsEnabled: true,
		chatChannels: [
			...SLACK_SELECTION,
			{ platform: "SLACK", teamId: "T-example", channelId: "C-other" },
		],
	});
	getLinkedSlackChannels.mockResolvedValue([
		linkedSlackRow,
		{ ...linkedSlackRow, channelId: "C-other" },
	]);
	await broadcastPublishingTopicsToChat(INPUT);
	expect(isScheduledNewsletterActorValid).toHaveBeenCalledTimes(1);
});

// §3.5 makes an operator depend on this line, and this product has already had a
// month-long chat outage whose telemetry was written and never read. Asserted on
// its fields, so a rename or a dropped field is red.
it("emits one aggregate log line per run, with the skip breakdown", async () => {
	getPublishingSuiteSettings.mockResolvedValue({
		notificationsEnabled: true,
		chatChannels: [
			...SLACK_SELECTION,
			{ platform: "SLACK", teamId: "T-example", channelId: "C-gone" },
		],
	});
	await broadcastPublishingTopicsToChat(INPUT);
	const aggregate = logger.info.mock.calls.filter(
		(c) => c[0] === "publishing chat broadcast complete",
	);
	expect(aggregate).toHaveLength(1);
	expect(aggregate[0][1]).toMatchObject({
		cycleId: "cycle-1",
		projectId: "proj-1",
		targetCount: expect.any(Number),
		sentCount: expect.any(Number),
		failedCount: expect.any(Number),
		skippedCount: expect.any(Number),
		skippedByReason: expect.objectContaining({
			CHANNEL_NOT_LINKED: 1,
		}),
	});
});

// Raised by the Copilot review on PR #2933. The breakdown used to be tallied in
// memory as the loop decided each refusal, while every other number on the same
// line is read back from the ledger. Two denominators in one line: the tally
// counts refusals DECIDED, the ledger counts rows that EXIST, and a selection
// naming one channel twice separates them — the second claim is refused and
// writes nothing, but a counter increments anyway.
it("derives the skip breakdown from the ledger, so a duplicated selection counts once", async () => {
	getPublishingSuiteSettings.mockResolvedValue({
		notificationsEnabled: true,
		chatChannels: [...SLACK_SELECTION, ...SLACK_SELECTION],
	});
	getLinkedSlackChannels.mockResolvedValue([]); // both entries resolve to a skip
	// The real claim is an INSERT against a unique key: the first wins and
	// leaves a row, the second conflicts and writes nothing.
	let firstClaim = true;
	claimPublishingChatDelivery.mockImplementation(
		async (i: {
			status?: string;
			reason?: string;
			platform?: string;
			externalTeamId?: string;
			channelId?: string;
		}) => {
			if (!firstClaim) {
				return { claimed: false };
			}
			firstClaim = false;
			ledger.push({
				key: rowKey(i),
				status: i.status ?? "SENDING",
				reason: i.reason ?? null,
			});
			return { claimed: true };
		},
	);

	const out = await broadcastPublishingTopicsToChat(INPUT);

	const aggregate = logger.info.mock.calls.filter(
		(c) => c[0] === "publishing chat broadcast complete",
	);
	expect(aggregate[0][1]).toMatchObject({
		skippedCount: 1,
		skippedByReason: { CHANNEL_NOT_LINKED: 1 },
	});
	expect(out.skippedCount).toBe(1);
});

// Also from the Copilot review, and the more expensive of the two: this is the
// case where the provider ACCEPTED the message. Recording FAILED would move a
// delivered post out of sentCount, and FAILED is terminal by design — chat never
// re-posts — so the misreport would be permanent. The row must stay SENDING,
// which the ledger-derived count already reads as delivered.
it("leaves the row SENDING when the SENT write fails after a successful post", async () => {
	markPublishingChatDelivery.mockImplementationOnce(async (i) => {
		if (i.status === "SENT") {
			throw new Error("connection reset while marking SENT");
		}
		ledger.push({
			key: rowKey(i),
			status: i.status,
			reason: i.reason ?? null,
		});
	});

	await expect(broadcastPublishingTopicsToChat(INPUT)).rejects.toThrow();

	expect(globalThis.fetch).toHaveBeenCalled(); // the post really did go out
	expect(markPublishingChatDelivery).not.toHaveBeenCalledWith(
		expect.objectContaining({ status: "FAILED" }),
	);
});

// A GUARD, not a regression test, and the distinction is worth writing down: it
// passes against the previous commit too. The panel read the FAILED settle
// sitting inside the catch as a swallow, and it never was one — a throw inside a
// `catch` block is not caught by that block's own `try`. The settle was moved out
// for symmetry, and this case pins the property that was already true so a later
// refactor cannot quietly make the swallow real.
it("does not swallow a failure to record FAILED", async () => {
	globalThis.fetch = vi
		.fn()
		.mockResolvedValue(
			slackResponse({ ok: false, error: "channel_not_found" }),
		) as unknown as typeof globalThis.fetch;
	markPublishingChatDelivery.mockImplementation(async (i) => {
		if (i.status === "FAILED") {
			throw new Error("connection reset while marking FAILED");
		}
		ledger.push({
			key: rowKey(i),
			status: i.status,
			reason: i.reason ?? null,
		});
	});

	await expect(broadcastPublishingTopicsToChat(INPUT)).rejects.toThrow();
});

// §3.5 makes an operator depend on this line, and the runs that take the throw
// path are the ones whose state is least known — exactly the ones that were
// producing no line at all, while the source comment, the spec and the
// changeset all claimed every exit path was covered.
it("emits the aggregate line before re-raising on the throw path", async () => {
	renderPublishingChatMessage.mockImplementation(() => {
		throw new Error("render blew up");
	});

	await expect(broadcastPublishingTopicsToChat(INPUT)).rejects.toThrow();

	const aggregate = [
		...logger.info.mock.calls,
		...logger.warn.mock.calls,
	].filter((c) => c[0] === "publishing chat broadcast complete");
	expect(aggregate).toHaveLength(1);
	expect(aggregate[0][1]).toMatchObject({ gate: "targets-threw" });
});

// A query keyed on the message string alone cannot tell a total outage from a
// healthy run: every count is present either way. The LEVEL is what an alert
// keys on, and this module's neighbours already use it that way.
it("logs the aggregate line at warn when a target failed, and at info otherwise", async () => {
	globalThis.fetch = vi
		.fn()
		.mockResolvedValue(
			slackResponse({ ok: false, error: "channel_not_found" }),
		) as unknown as typeof globalThis.fetch;
	await broadcastPublishingTopicsToChat(INPUT);
	expect(
		logger.warn.mock.calls.filter(
			(c) => c[0] === "publishing chat broadcast complete",
		),
	).toHaveLength(1);
	expect(
		logger.info.mock.calls.filter(
			(c) => c[0] === "publishing chat broadcast complete",
		),
	).toHaveLength(0);

	vi.clearAllMocks();
	ledger = [];
	globalThis.fetch = vi
		.fn()
		.mockResolvedValue(
			slackResponse({ ok: true, ts: "1.1" }),
		) as unknown as typeof globalThis.fetch;
	await broadcastPublishingTopicsToChat(INPUT);
	expect(
		logger.info.mock.calls.filter(
			(c) => c[0] === "publishing chat broadcast complete",
		),
	).toHaveLength(1);
});

// A SENDING row means the process died between the claim and the confirming
// write. The claim is taken BEFORE the provider is contacted, so it establishes
// nothing about whether the room saw anything — folding it into `sentCount` with
// no way to see it separately is what let that read as a delivered broadcast.
it("reports SENDING rows separately as unconfirmed", async () => {
	ledger = [
		{
			key: rowKey({
				platform: "SLACK",
				externalTeamId: "T-example",
				channelId: "C-example",
			}),
			status: "SENDING",
		},
	];
	claimPublishingChatDelivery.mockResolvedValue({ claimed: false });
	await broadcastPublishingTopicsToChat(INPUT);
	const aggregate = [
		...logger.info.mock.calls,
		...logger.warn.mock.calls,
	].filter((c) => c[0] === "publishing chat broadcast complete");
	expect(aggregate[0][1]).toMatchObject({
		sentCount: 1,
		unconfirmedCount: 1,
		event: "publishing.chat.broadcast_complete",
	});
});

// The gates return early; without this the aggregate line could be emitted on
// the happy path only, which is the shape where an operator watching for a total
// outage sees nothing at all and concludes nothing ran.
it("emits the aggregate line on a gated exit too, naming the gate", async () => {
	isProjectReadOnly.mockResolvedValue(true);
	await broadcastPublishingTopicsToChat(INPUT);
	const aggregate = logger.info.mock.calls.filter(
		(c) => c[0] === "publishing chat broadcast complete",
	);
	expect(aggregate).toHaveLength(1);
	expect(aggregate[0][1]).toMatchObject({ gate: "project-read-only" });
});

// The fan-out is `Promise.allSettled` over every target at once, and the only
// heartbeat used to sit at the TOP of deliverOne. All of them therefore fired
// within milliseconds of the start and nothing heartbeat again for the rest of
// the run — so `heartbeatTimeout: "1 minute"` on the proxy would kill a HEALTHY
// run whose slowest provider call took longer than that, while the wedge it
// exists to detect looks identical.
//
// Asserting the LAST heartbeat carries done === total is what pins it: that
// value is unreachable unless a heartbeat happens after the final target
// settles. A count emitted up front cannot fake it.
it("heartbeats as targets finish, not only when they start", async () => {
	const channels = ["C-one", "C-two", "C-three"];
	getPublishingSuiteSettings.mockResolvedValue({
		notificationsEnabled: true,
		chatChannels: channels.map((channelId) => ({
			platform: "SLACK" as const,
			teamId: "T-example",
			channelId,
		})),
	});
	getLinkedSlackChannels.mockResolvedValue(
		channels.map((channelId) => ({ ...linkedSlackRow, channelId })),
	);

	await broadcastPublishingTopicsToChat(INPUT);

	// `vi.mocked`, not `heartbeat.mock` — the import carries the REAL signature
	// `(details?: unknown) => void`, so reaching for `.mock` on it is a type
	// error even though the value at runtime is the factory's `vi.fn()`.
	const progress = vi
		.mocked(heartbeat)
		.mock.calls.map((c) => c[0])
		.filter(
			(d): d is { done: number; total: number } =>
				typeof d === "object" && d !== null && "done" in d,
		);
	expect(progress.at(-1)).toEqual({ done: 3, total: 3 });
	// One per settled target, so a slow run keeps proving it is alive.
	expect(progress).toHaveLength(3);
});
