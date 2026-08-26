import { afterEach, beforeEach, expect, it, vi } from "vitest";

const getLinkedTeamsChannels = vi.fn();
const getLinkedSlackChannels = vi.fn();
const claimChatDelivery = vi.fn();
// Channel-linker authorization guard (parity with the scheduled-actor guard).
const isScheduledNewsletterActorValid = vi.fn();
// Read-only gate — the engine's own defence-in-depth check (Fizzy #2203).
const isProjectReadOnly = vi.fn();
// Stateful in-memory ledger so listChatDeliveriesForSend reflects what was marked
// (the engine derives its return counts from the ledger — retry-safe).
//
// Rows carry the channel identity as well as the status, because the engine also
// asserts after the fan-out that every resolved target left a row of its own
// kind, and that lookup is by identity. This mock returns every row regardless of
// the `kind` argument; that the real query FILTERS by kind is proven separately,
// in packages/database's chat-delivery-kind suite. What is proven here is what
// the engine does with the answer.
type LedgerRow = {
	status: string;
	platform: string;
	externalTeamId: string;
	channelId: string;
};
let ledger: LedgerRow[] = [];
const markChatDelivery = vi.fn(
	async (i: {
		status: string;
		errorMessage?: string;
		platform: string;
		externalTeamId: string;
		channelId: string;
	}) => {
		ledger.push({
			status: i.status,
			platform: i.platform,
			externalTeamId: i.externalTeamId,
			channelId: i.channelId,
		});
	},
);
vi.mock("@repo/database", () => ({
	getLinkedTeamsChannels: (...a: unknown[]) => getLinkedTeamsChannels(...a),
	getLinkedSlackChannels: (...a: unknown[]) => getLinkedSlackChannels(...a),
	claimChatDelivery: (...a: unknown[]) => claimChatDelivery(...a),
	isScheduledNewsletterActorValid: (...a: unknown[]) =>
		isScheduledNewsletterActorValid(...a),
	isProjectReadOnly: (...a: unknown[]) => isProjectReadOnly(...a),
	// markChatDelivery's vi.fn() implementation has a single typed-object
	// parameter (not a rest param), so wrapping it as
	// `(...a: unknown[]) => markChatDelivery(...a)` fails TS2556 ("spread
	// argument must be a tuple or match a rest parameter"). A same-shape,
	// single-parameter wrapper avoids the spread while still deferring the
	// `markChatDelivery` reference to call time (vi.mock's factory runs before
	// the `const markChatDelivery = vi.fn(...)` above initializes, since
	// vi.mock calls are hoisted above other top-level statements — referencing
	// it directly here, outside a function body, would be a TDZ error).
	markChatDelivery: (i: {
		status: string;
		errorMessage?: string;
		platform: string;
		externalTeamId: string;
		channelId: string;
	}) => markChatDelivery(i),
	listChatDeliveriesForSend: async () => ledger,
}));
const postToTeams = vi.fn();
// Test file lives in newsletter/__tests__/, two levels below activities/ — the
// source module (newsletter/chat-delivery-engine.ts) is one level below
// activities/, so its own "../teams-mention" import resolves to
// activities/teams-mention.ts. Mirroring that from __tests__/ requires
// "../../teams-mention" (same convention as send-newsletter-chat-messages.test.ts).
vi.mock("../../teams-mention", () => ({
	postToTeams: (...a: unknown[]) => postToTeams(...a),
}));
// Mock the credentials resolver directly — NOT the wholesale "@repo/integrations"
// module — so the test exercises the real trigger-independent Slack path.
const getSlackCredentials = vi.fn();
vi.mock("@repo/integrations/slack", () => ({
	getSlackCredentials: (...a: unknown[]) => getSlackCredentials(...a),
}));
// Temporal heartbeat is a no-op in tests:
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { deliverChatMessages } from "../chat-delivery-engine";

const originalFetch = globalThis.fetch;
const fetchMock = vi.fn();

function slackApiResponse(body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function baseInput(overrides: Record<string, unknown> = {}) {
	return {
		sendId: "s",
		projectId: "p",
		organizationId: null,
		userId: "u",
		kind: "CONTENT" as const,
		channels: [],
		renderText: () => "hello",
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	ledger = [];
	claimChatDelivery.mockResolvedValue({ claimed: true });
	isScheduledNewsletterActorValid.mockResolvedValue(true);
	isProjectReadOnly.mockResolvedValue(false);
	postToTeams.mockResolvedValue({ success: true, messageId: "m1" });
	getSlackCredentials.mockResolvedValue({
		accessToken: "xoxb-test",
		integrationId: "wfi-1",
	});
	getLinkedTeamsChannels.mockResolvedValue([]);
	getLinkedSlackChannels.mockResolvedValue([]);
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(slackApiResponse({ ok: true, ts: "1.1" }));
	globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

it("skips every target with no provider call and no ledger claim when the project is read-only", async () => {
	isProjectReadOnly.mockResolvedValue(true);
	getLinkedSlackChannels.mockResolvedValue([
		{
			slackTeamId: "ST",
			channelId: "C1",
			userId: "u1",
			organizationId: null,
		},
	]);
	const out = await deliverChatMessages(
		baseInput({
			channels: [{ platform: "SLACK", teamId: "ST", channelId: "C1" }],
		}),
	);
	expect(isProjectReadOnly).toHaveBeenCalledWith("p");
	// The gate runs before target resolution, so the live linked set is never
	// even consulted — a read-only project short-circuits at the top.
	expect(getLinkedSlackChannels).not.toHaveBeenCalled();
	expect(getLinkedTeamsChannels).not.toHaveBeenCalled();
	expect(claimChatDelivery).not.toHaveBeenCalled();
	expect(markChatDelivery).not.toHaveBeenCalled();
	expect(fetchMock).not.toHaveBeenCalled();
	expect(postToTeams).not.toHaveBeenCalled();
	expect(out).toEqual({
		targetCount: 1,
		sentCount: 0,
		failedCount: 0,
		skippedCount: 1,
	});
});

it("posts to a resolved target using the injected renderText, kind-tagged on every ledger call", async () => {
	getLinkedSlackChannels.mockResolvedValue([
		{
			slackTeamId: "ST",
			channelId: "C1",
			userId: "u1",
			organizationId: null,
		},
	]);
	const renderText = vi.fn(
		(platform: "TEAMS" | "SLACK") => `body-${platform}`,
	);
	const out = await deliverChatMessages(
		baseInput({
			channels: [{ platform: "SLACK", teamId: "ST", channelId: "C1" }],
			renderText,
		}),
	);
	expect(renderText).toHaveBeenCalledWith("SLACK");
	expect(fetchMock).toHaveBeenCalledWith(
		"https://slack.com/api/chat.postMessage",
		expect.objectContaining({
			body: expect.stringContaining('"text":"body-SLACK"'),
		}),
	);
	expect(claimChatDelivery).toHaveBeenCalledWith(
		expect.objectContaining({ kind: "CONTENT", platform: "SLACK" }),
	);
	expect(markChatDelivery).toHaveBeenCalledWith(
		expect.objectContaining({ kind: "CONTENT", status: "SENT" }),
	);
	expect(out).toMatchObject({ targetCount: 1, sentCount: 1, failedCount: 0 });
});

it("records SKIPPED with a terminal row when the review concludes mid-dispatch", async () => {
	getLinkedSlackChannels.mockResolvedValue([
		{
			slackTeamId: "ST",
			channelId: "C1",
			userId: "u1",
			organizationId: null,
		},
	]);
	const stillWanted = vi.fn().mockResolvedValue(false);
	const out = await deliverChatMessages(
		baseInput({
			channels: [{ platform: "SLACK", teamId: "ST", channelId: "C1" }],
			stillWanted,
		}),
	);
	expect(stillWanted).toHaveBeenCalled();
	// No provider post was attempted.
	expect(fetchMock).not.toHaveBeenCalled();
	expect(postToTeams).not.toHaveBeenCalled();
	// A terminal row exists — recordSkip claims in order to write it, so a claim
	// call did happen; asserting it did NOT would contradict that requirement.
	expect(markChatDelivery).toHaveBeenCalledWith(
		expect.objectContaining({
			status: "SKIPPED",
			errorMessage: "review concluded before dispatch",
		}),
	);
	expect(out).toMatchObject({ sentCount: 0, skippedCount: 1 });
});

// The single-target case above proves the abort happens at all. This one proves
// the shape the concurrent fan-out ACTUALLY produces: a decision landing
// mid-dispatch, so some channels post and others abort. The spec calls that
// asymmetry correct but insists it must not be invisible — which means the
// aborted channel has to leave a terminal row carrying its reason, not just
// disappear from the posts.
it("posts the targets it reached and records only the rest as SKIPPED when the review concludes mid-dispatch", async () => {
	getLinkedSlackChannels.mockResolvedValue([
		{
			slackTeamId: "ST",
			channelId: "C1",
			userId: "u1",
			organizationId: null,
		},
		{
			slackTeamId: "ST",
			channelId: "C2",
			userId: "u1",
			organizationId: null,
		},
	]);
	// deliverOne runs synchronously up to its first await, and that await IS the
	// stillWanted call — so the two targets consume these answers in map order.
	const stillWanted = vi
		.fn()
		.mockResolvedValueOnce(true)
		.mockResolvedValueOnce(false);

	const out = await deliverChatMessages(
		baseInput({
			channels: [
				{ platform: "SLACK", teamId: "ST", channelId: "C1" },
				{ platform: "SLACK", teamId: "ST", channelId: "C2" },
			],
			stillWanted,
		}),
	);

	expect(stillWanted).toHaveBeenCalledTimes(2);

	// Exactly ONE provider post, and it is the target that was still wanted.
	const postCalls = fetchMock.mock.calls.filter(
		(c) => c[0] === "https://slack.com/api/chat.postMessage",
	);
	expect(postCalls).toHaveLength(1);
	expect(postCalls[0][1]).toMatchObject({
		body: expect.stringContaining('"channel":"C1"'),
	});

	// Exactly ONE terminal SKIPPED row, on the OTHER channel, carrying the
	// reason verbatim — an aborted target must stay distinguishable from one
	// that failed to send.
	const skipCalls = markChatDelivery.mock.calls.filter(
		(c) => (c[0] as { status: string }).status === "SKIPPED",
	);
	expect(skipCalls).toHaveLength(1);
	expect(skipCalls[0][0]).toMatchObject({
		channelId: "C2",
		status: "SKIPPED",
		errorMessage: "review concluded before dispatch",
	});

	expect(out).toMatchObject({
		targetCount: 1,
		sentCount: 1,
		failedCount: 0,
		skippedCount: 1,
	});
});

it("skips a selected channel that is no longer in the live linked set", async () => {
	getLinkedTeamsChannels.mockResolvedValue([]);
	getLinkedSlackChannels.mockResolvedValue([]);
	const out = await deliverChatMessages(
		baseInput({
			channels: [{ platform: "SLACK", teamId: "T", channelId: "C" }],
		}),
	);
	expect(getSlackCredentials).not.toHaveBeenCalled();
	expect(fetchMock).not.toHaveBeenCalled();
	expect(markChatDelivery).toHaveBeenCalledWith(
		expect.objectContaining({
			status: "SKIPPED",
			errorMessage: "channel no longer linked to project",
		}),
	);
	expect(out).toMatchObject({
		targetCount: 0,
		sentCount: 0,
		skippedCount: 1,
	});
});

it("skips a channel whose linker is no longer authorized", async () => {
	getLinkedSlackChannels.mockResolvedValue([
		{
			slackTeamId: "ST",
			channelId: "C1",
			userId: "departed",
			organizationId: "o1",
		},
	]);
	isScheduledNewsletterActorValid.mockResolvedValue(false);
	const out = await deliverChatMessages(
		baseInput({
			organizationId: "o1",
			userId: null,
			channels: [{ platform: "SLACK", teamId: "ST", channelId: "C1" }],
		}),
	);
	expect(getSlackCredentials).not.toHaveBeenCalled();
	expect(fetchMock).not.toHaveBeenCalled();
	expect(markChatDelivery).toHaveBeenCalledWith(
		expect.objectContaining({
			status: "SKIPPED",
			errorMessage: "channel linker no longer authorized for project",
		}),
	);
	expect(out).toMatchObject({
		targetCount: 0,
		sentCount: 0,
		skippedCount: 1,
	});
});

// A refused claim has two meanings and the engine MUST tell them apart, because
// `deliverOne` returns a bare "SKIPPED" with no ledger row either way. These two
// tests are the pair: same refusal, opposite verdicts, decided only by what the
// ledger holds for THIS kind. The distinction cannot be drawn from the P2002's
// `meta.target` — a legitimate same-kind re-claim violates both unique indexes
// at once and Postgres names only one — which is why it is drawn here instead.
const oneSlackChannel = [
	{
		slackTeamId: "ST",
		channelId: "C1",
		userId: "u1",
		organizationId: null,
	},
];

it("does not raise when a refused claim is explained by this kind's own row — an ordinary activity retry", async () => {
	getLinkedSlackChannels.mockResolvedValue(oneSlackChannel);
	claimChatDelivery.mockResolvedValue({ claimed: false });
	// The prior attempt's row, already terminal and of this kind.
	ledger = [
		{
			status: "SENT",
			platform: "SLACK",
			externalTeamId: "ST",
			channelId: "C1",
		},
	];

	const out = await deliverChatMessages(
		baseInput({
			channels: [{ platform: "SLACK", teamId: "ST", channelId: "C1" }],
		}),
	);

	// Fail-closed still holds: a refused claim never re-posts.
	expect(fetchMock).not.toHaveBeenCalled();
	expect(out).toMatchObject({ targetCount: 1, sentCount: 1, failedCount: 0 });
});

it("raises, naming the channel, when a refused claim left no row of this kind", async () => {
	getLinkedSlackChannels.mockResolvedValue(oneSlackChannel);
	claimChatDelivery.mockResolvedValue({ claimed: false });
	// The ledger stays empty for this kind: the row occupying the channel
	// belongs to the OTHER kind, so this kind's read-back cannot see it. The
	// retained legacy index was the original way to reach that state, and it is
	// gone; the assertion stays because any future cause of a phantom target
	// produces the same shape. Without it the engine would return all-zero
	// counts and the send would finalize as if the channel had never been a
	// target.
	ledger = [];

	await expect(
		deliverChatMessages(
			baseInput({
				channels: [
					{ platform: "SLACK", teamId: "ST", channelId: "C1" },
				],
			}),
		),
	).rejects.toThrow(/left no ledger row.*SLACK:C1/);

	expect(fetchMock).not.toHaveBeenCalled();
});

it("joins the channel and retries once when Slack replies not_in_channel", async () => {
	getLinkedSlackChannels.mockResolvedValue([
		{
			slackTeamId: "ST",
			channelId: "C1",
			userId: "u1",
			organizationId: null,
		},
	]);
	fetchMock
		.mockResolvedValueOnce(
			slackApiResponse({ ok: false, error: "not_in_channel" }),
		)
		.mockResolvedValueOnce(
			slackApiResponse({ ok: true, channel: { id: "C1" } }),
		)
		.mockResolvedValueOnce(slackApiResponse({ ok: true, ts: "1.2" }));

	const out = await deliverChatMessages(
		baseInput({
			channels: [{ platform: "SLACK", teamId: "ST", channelId: "C1" }],
		}),
	);

	expect(fetchMock).toHaveBeenCalledTimes(3);
	expect(fetchMock.mock.calls[1][0]).toBe(
		"https://slack.com/api/conversations.join",
	);
	expect(out).toMatchObject({ sentCount: 1, failedCount: 0 });
});
