import { afterEach, beforeEach, expect, it, vi } from "vitest";

const getLinkedTeamsChannels = vi.fn();
const getLinkedSlackChannels = vi.fn();
const isProjectReadOnly = vi.fn(async () => false);
const claimChatDelivery = vi.fn();
// Channel-linker authorization guard (parity with the scheduled-actor guard).
// Real logic is unit-tested at the DB layer (newsletter.test.ts); mocked here at
// the activity's unit boundary like the other @repo/database calls.
const isScheduledNewsletterActorValid = vi.fn();
// Stateful in-memory ledger so listChatDeliveriesForSend reflects what was marked
// (the activity derives its return counts from the ledger — retry-safe).
//
// Rows carry the channel identity as well as the status because the engine now
// asserts, after the fan-out, that every resolved target left a row of its own
// kind, and that lookup is by identity. The real `listChatDeliveriesForSend`
// selects those columns; a status-only mock modelled the query too thinly and
// made every delivered target look unrecorded (Fizzy #2203).
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
	// Read-only gate — default: project is writable.
	isProjectReadOnly: (...a: unknown[]) => isProjectReadOnly(...(a as [])),
	getLinkedTeamsChannels: (...a: unknown[]) => getLinkedTeamsChannels(...a),
	getLinkedSlackChannels: (...a: unknown[]) => getLinkedSlackChannels(...a),
	claimChatDelivery: (...a: unknown[]) => claimChatDelivery(...a),
	isScheduledNewsletterActorValid: (...a: unknown[]) =>
		isScheduledNewsletterActorValid(...a),
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
	buildReleaseNotesUrl: async () =>
		"https://app.test/app/projects/p?tab=release-notes",
}));
const postToTeams = vi.fn();
// Test file lives in newsletter/__tests__/, two levels below activities/ — the
// source module (newsletter/send-newsletter-chat-messages.ts) is one level
// below activities/, so its own "../teams-mention" import resolves to
// activities/teams-mention.ts. Mirroring that from __tests__/ requires
// "../../teams-mention" (matches the ../../ convention used by sibling
// __tests__ dirs, e.g. teams-channel-monitor/__tests__ mocking ../../backlog-context/*).
vi.mock("../../teams-mention", () => ({
	postToTeams: (...a: unknown[]) => postToTeams(...a),
}));
// Mock the credentials resolver directly — NOT the wholesale "@repo/integrations"
// module — so the test exercises the real trigger-independent Slack path. Mocking
// the whole package (as this suite used to) is exactly why the DOA `sendSlackMessage`
// bug (trigger-gated credentials) was invisible: the mock swallowed the real
// resolver call entirely.
const getSlackCredentials = vi.fn();
vi.mock("@repo/integrations/slack", () => ({
	getSlackCredentials: (...a: unknown[]) => getSlackCredentials(...a),
}));
// Controllable render mock so a per-test render failure can be exercised (the
// activity must render BEFORE it claims a ledger row — a render throw must not
// orphan a SENDING row that the ledger-derived count treats as sent). Declared
// with its real 2-arg arity and wrapped WITHOUT a spread — a nullary vi.fn +
// `(...a) => fn(...a)` trips TS2556 (same reason markChatDelivery is wrapped
// single-param above).
const renderNewsletterChatMessage = vi.fn(
	(_content: unknown, _opts: unknown) => ({ text: "hello" }),
);
vi.mock("@repo/utils", () => ({
	getBaseUrl: () => "https://app.test",
	renderNewsletterChatMessage: (content: unknown, opts: unknown) =>
		renderNewsletterChatMessage(content, opts),
}));
// Temporal heartbeat is a no-op in tests:
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { sendNewsletterChatMessagesActivity } from "../send-newsletter-chat-messages";

const content = {
	headline: "H",
	intro: "i",
	highlights: [],
	hasMajorFeatures: true,
} as never;

const originalFetch = globalThis.fetch;
const fetchMock = vi.fn();

function slackApiResponse(body: Record<string, unknown>): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	ledger = [];
	isProjectReadOnly.mockResolvedValue(false);
	claimChatDelivery.mockResolvedValue({ claimed: true });
	isScheduledNewsletterActorValid.mockResolvedValue(true);
	postToTeams.mockResolvedValue({ success: true, messageId: "m1" });
	getSlackCredentials.mockResolvedValue({
		accessToken: "xoxb-test",
		integrationId: "wfi-1",
	});
	fetchMock.mockReset();
	fetchMock.mockResolvedValue(slackApiResponse({ ok: true, ts: "1.1" }));
	globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

it("skips a selected channel that is no longer linked", async () => {
	getLinkedTeamsChannels.mockResolvedValue([]);
	getLinkedSlackChannels.mockResolvedValue([]);
	const out = await sendNewsletterChatMessagesActivity({
		sendId: "s",
		projectId: "p",
		organizationId: null,
		userId: "u",
		projectName: "P",
		content,
		chatChannels: [{ platform: "SLACK", teamId: "T", channelId: "C" }],
	});
	expect(getSlackCredentials).not.toHaveBeenCalled();
	expect(fetchMock).not.toHaveBeenCalled();
	expect(out).toMatchObject({
		targetCount: 0,
		sentCount: 0,
		skippedCount: 1,
	});
});

it("Read-only mode skips the whole send with no external post", async () => {
	isProjectReadOnly.mockResolvedValue(true);
	const out = await sendNewsletterChatMessagesActivity({
		sendId: "s",
		projectId: "p",
		organizationId: null,
		userId: "u",
		projectName: "P",
		content,
		chatChannels: [
			{ platform: "SLACK", teamId: "T", channelId: "C" },
			{ platform: "TEAMS", teamId: "TT", channelId: "TC" },
		],
	});
	// The gate short-circuits before channel resolution or any provider dispatch.
	expect(getLinkedSlackChannels).not.toHaveBeenCalled();
	expect(getLinkedTeamsChannels).not.toHaveBeenCalled();
	expect(fetchMock).not.toHaveBeenCalled();
	expect(postToTeams).not.toHaveBeenCalled();
	expect(out).toMatchObject({
		targetCount: 2,
		sentCount: 0,
		failedCount: 0,
		skippedCount: 2,
	});
});

it("posts to a linked Slack + Teams target using the linking user's identity", async () => {
	getLinkedTeamsChannels.mockResolvedValue([
		{
			teamId: "TT",
			channelId: "TC",
			userId: "teamsUser",
			organizationId: null,
		},
	]);
	getLinkedSlackChannels.mockResolvedValue([
		{
			slackTeamId: "ST",
			channelId: "SC",
			userId: "slackUser",
			organizationId: null,
		},
	]);
	const out = await sendNewsletterChatMessagesActivity({
		sendId: "s",
		projectId: "p",
		organizationId: null,
		userId: "u",
		projectName: "P",
		content,
		chatChannels: [
			{ platform: "TEAMS", teamId: "TT", channelId: "TC" },
			{ platform: "SLACK", teamId: "ST", channelId: "SC" },
		],
	});
	expect(postToTeams).toHaveBeenCalledWith(
		expect.objectContaining({
			teamId: "TT",
			channelId: "TC",
			userId: "teamsUser",
		}),
	);
	// Trigger-independence + actor proof: credentials are resolved with the
	// LINKER's identity ("slackUser", null org) — never the send tenant ("u") —
	// and WITHOUT going through the trigger-gated `sendSlackMessage` helper.
	// This is the assertion that would have caught the DOA bug: the old
	// trigger-gated path never calls `getSlackCredentials` at all.
	expect(getSlackCredentials).toHaveBeenCalledWith("slackUser", undefined);
	expect(fetchMock).toHaveBeenCalledWith(
		"https://slack.com/api/chat.postMessage",
		expect.objectContaining({
			method: "POST",
			headers: expect.objectContaining({
				Authorization: "Bearer xoxb-test",
			}),
			body: expect.stringContaining('"channel":"SC"'),
		}),
	);
	// P3 tenant split: the ledger claim must carry the SEND's identity
	// (organizationId: null, userId: "u"), never the channel-linker's
	// identity ("teamsUser"/"slackUser") — those are poster credentials
	// only. This must FAIL if the two identities are ever swapped.
	expect(claimChatDelivery).toHaveBeenCalledWith(
		expect.objectContaining({
			organizationId: null,
			userId: "u",
			platform: "TEAMS",
		}),
	);
	expect(claimChatDelivery).toHaveBeenCalledWith(
		expect.objectContaining({
			organizationId: null,
			userId: "u",
			platform: "SLACK",
		}),
	);
	expect(claimChatDelivery).not.toHaveBeenCalledWith(
		expect.objectContaining({ userId: "teamsUser" }),
	);
	expect(claimChatDelivery).not.toHaveBeenCalledWith(
		expect.objectContaining({ userId: "slackUser" }),
	);
	expect(out).toMatchObject({ targetCount: 2, sentCount: 2, failedCount: 0 });
});

it("isolates a failing poster (one throws, the other still posts)", async () => {
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
	getLinkedTeamsChannels.mockResolvedValue([]);
	fetchMock.mockRejectedValueOnce(new Error("boom")); // first target throws
	const out = await sendNewsletterChatMessagesActivity({
		sendId: "s",
		projectId: "p",
		organizationId: null,
		userId: "u",
		projectName: "P",
		content,
		chatChannels: [
			{ platform: "SLACK", teamId: "ST", channelId: "C1" },
			{ platform: "SLACK", teamId: "ST", channelId: "C2" },
		],
	});
	expect(out).toMatchObject({ targetCount: 2, sentCount: 1, failedCount: 1 });
});

it("does not post when the claim conflicts (already handled)", async () => {
	getLinkedSlackChannels.mockResolvedValue([
		{
			slackTeamId: "ST",
			channelId: "C1",
			userId: "u1",
			organizationId: null,
		},
	]);
	getLinkedTeamsChannels.mockResolvedValue([]);
	claimChatDelivery.mockResolvedValue({ claimed: false });
	// "Already handled" means a PRIOR ATTEMPT of this same kind wrote the row, so
	// the ledger has to hold it. Without it this is not the retry case at all —
	// it is the shape where the claim was refused by something else and the
	// channel left no trace, which the engine now raises on rather than reporting
	// as a silent zero (Fizzy #2203).
	ledger = [
		{
			status: "SENT",
			platform: "SLACK",
			externalTeamId: "ST",
			channelId: "C1",
		},
	];
	await sendNewsletterChatMessagesActivity({
		sendId: "s",
		projectId: "p",
		organizationId: null,
		userId: "u",
		projectName: "P",
		content,
		chatChannels: [{ platform: "SLACK", teamId: "ST", channelId: "C1" }],
	});
	expect(getSlackCredentials).not.toHaveBeenCalled();
	expect(fetchMock).not.toHaveBeenCalled();
});

it("re-raises (never a false-empty) when a target's claim rejects before any ledger row", async () => {
	// A DB error in claimChatDelivery rejects deliverOne BEFORE a terminal ledger
	// row exists. The activity must re-raise so the workflow marks the send
	// errored and Temporal retries — NOT swallow it via Promise.allSettled and
	// return targetCount:0, which the workflow finalizes as a false SKIPPED_EMPTY
	// (Codex BLOCKER 2026-07-08). The idempotent claim ledger makes the retry safe
	// (already-terminal rows return claimed:false).
	getLinkedSlackChannels.mockResolvedValue([
		{
			slackTeamId: "ST",
			channelId: "C1",
			userId: "u1",
			organizationId: null,
		},
	]);
	getLinkedTeamsChannels.mockResolvedValue([]);
	claimChatDelivery.mockRejectedValue(new Error("db down"));
	await expect(
		sendNewsletterChatMessagesActivity({
			sendId: "s",
			projectId: "p",
			organizationId: null,
			userId: "u",
			projectName: "P",
			content,
			chatChannels: [
				{ platform: "SLACK", teamId: "ST", channelId: "C1" },
			],
		}),
	).rejects.toThrow(/failed before a terminal ledger row/);
});

it("renders before it claims, so a render failure orphans no SENDING row (not counted as sent)", async () => {
	// If render throws AFTER the claim, the SENDING row is counted as sent — a
	// silent miss recorded as delivered. Render must run BEFORE claimChatDelivery:
	// a render throw then writes no ledger row and re-raises instead of finalizing
	// a false SENT (Codex BLOCKER 2026-07-08).
	getLinkedSlackChannels.mockResolvedValue([
		{
			slackTeamId: "ST",
			channelId: "C1",
			userId: "u1",
			organizationId: null,
		},
	]);
	getLinkedTeamsChannels.mockResolvedValue([]);
	renderNewsletterChatMessage.mockImplementationOnce(() => {
		throw new Error("render boom");
	});
	await expect(
		sendNewsletterChatMessagesActivity({
			sendId: "s",
			projectId: "p",
			organizationId: null,
			userId: "u",
			projectName: "P",
			content,
			chatChannels: [
				{ platform: "SLACK", teamId: "ST", channelId: "C1" },
			],
		}),
	).rejects.toThrow();
	// Render precedes the claim, so no row is ever written for the failed target.
	expect(claimChatDelivery).not.toHaveBeenCalled();
	expect(fetchMock).not.toHaveBeenCalled();
});

it("skips a channel whose linker is no longer authorized (no post under a departed linker's token)", async () => {
	// Parity with the scheduled-actor guard: the channel-linker identity (row.userId)
	// must still be authorized in the SEND's tenant. A departed org member must not
	// keep powering posts under their token (Codex 2026-07-08). A stale linker is a
	// fail-closed SKIPPED — never a post, never a FAILED that marks the send errored.
	getLinkedSlackChannels.mockResolvedValue([
		{
			slackTeamId: "ST",
			channelId: "C1",
			userId: "departed",
			organizationId: "o1",
		},
	]);
	getLinkedTeamsChannels.mockResolvedValue([]);
	isScheduledNewsletterActorValid.mockResolvedValue(false); // linker removed from org
	const out = await sendNewsletterChatMessagesActivity({
		sendId: "s",
		projectId: "p",
		organizationId: "o1",
		userId: null,
		projectName: "P",
		content,
		chatChannels: [{ platform: "SLACK", teamId: "ST", channelId: "C1" }],
	});
	// Validated against the LINKER id + the SEND's tenant — not the poster identity
	// and not the selection. Swap-proof: must fail if the wrong id is validated.
	expect(isScheduledNewsletterActorValid).toHaveBeenCalledWith(
		"departed",
		"o1",
		null,
	);
	// Fail-closed: no credentials resolved, no post; recorded as SKIPPED.
	expect(getSlackCredentials).not.toHaveBeenCalled();
	expect(fetchMock).not.toHaveBeenCalled();
	expect(out).toMatchObject({
		targetCount: 0,
		sentCount: 0,
		failedCount: 0,
		skippedCount: 1,
	});
});

it("joins the channel and retries once when Slack replies not_in_channel", async () => {
	// A bot that is not a member of the destination channel gets not_in_channel
	// on every post, forever — the failure mode behind Fizzy #2013. The activity
	// must attempt conversations.join and retry the post exactly once.
	getLinkedSlackChannels.mockResolvedValue([
		{
			slackTeamId: "ST",
			channelId: "C1",
			userId: "u1",
			organizationId: null,
		},
	]);
	getLinkedTeamsChannels.mockResolvedValue([]);
	fetchMock
		.mockResolvedValueOnce(
			slackApiResponse({ ok: false, error: "not_in_channel" }),
		)
		.mockResolvedValueOnce(
			slackApiResponse({ ok: true, channel: { id: "C1" } }),
		)
		.mockResolvedValueOnce(slackApiResponse({ ok: true, ts: "1.2" }));

	const out = await sendNewsletterChatMessagesActivity({
		sendId: "s",
		projectId: "p",
		organizationId: null,
		userId: "u",
		projectName: "P",
		content,
		chatChannels: [{ platform: "SLACK", teamId: "ST", channelId: "C1" }],
	});

	expect(fetchMock).toHaveBeenCalledTimes(3);
	expect(fetchMock.mock.calls[1][0]).toBe(
		"https://slack.com/api/conversations.join",
	);
	expect(out).toMatchObject({ sentCount: 1, failedCount: 0 });
});

it("records the Slack error when the join also fails (private channel)", async () => {
	// conversations.join only works for PUBLIC channels. A private channel
	// returns an error and the post must fail with the ORIGINAL Slack code
	// preserved for diagnosis — not the join's code.
	getLinkedSlackChannels.mockResolvedValue([
		{
			slackTeamId: "ST",
			channelId: "C1",
			userId: "u1",
			organizationId: null,
		},
	]);
	getLinkedTeamsChannels.mockResolvedValue([]);
	fetchMock
		.mockResolvedValueOnce(
			slackApiResponse({ ok: false, error: "not_in_channel" }),
		)
		.mockResolvedValueOnce(
			slackApiResponse({
				ok: false,
				error: "method_not_supported_for_channel_type",
			}),
		);

	const out = await sendNewsletterChatMessagesActivity({
		sendId: "s",
		projectId: "p",
		organizationId: null,
		userId: "u",
		projectName: "P",
		content,
		chatChannels: [{ platform: "SLACK", teamId: "ST", channelId: "C1" }],
	});

	expect(fetchMock).toHaveBeenCalledTimes(2); // post, join — no second post
	expect(markChatDelivery).toHaveBeenCalledWith(
		expect.objectContaining({
			status: "FAILED",
			errorMessage: "not_in_channel",
		}),
	);
	expect(out).toMatchObject({ sentCount: 0, failedCount: 1 });
});

it("reports a scope problem, not a membership problem, when the join is refused", async () => {
	// A token issued before `channels:join` was requested fails the join with
	// missing_scope. Recording the original not_in_channel would tell the admin
	// to invite the app when the real remedy is reconnecting Slack.
	getLinkedSlackChannels.mockResolvedValue([
		{
			slackTeamId: "ST",
			channelId: "C1",
			userId: "u1",
			organizationId: null,
		},
	]);
	getLinkedTeamsChannels.mockResolvedValue([]);
	fetchMock
		.mockResolvedValueOnce(
			slackApiResponse({ ok: false, error: "not_in_channel" }),
		)
		.mockResolvedValueOnce(
			slackApiResponse({ ok: false, error: "missing_scope" }),
		);

	const out = await sendNewsletterChatMessagesActivity({
		sendId: "s",
		projectId: "p",
		organizationId: null,
		userId: "u",
		projectName: "P",
		content,
		chatChannels: [{ platform: "SLACK", teamId: "ST", channelId: "C1" }],
	});

	expect(markChatDelivery).toHaveBeenCalledWith(
		expect.objectContaining({
			status: "FAILED",
			errorMessage: "join_missing_scope",
		}),
	);
	expect(out).toMatchObject({ sentCount: 0, failedCount: 1 });
});

it("does not join or retry for a non-membership Slack error", async () => {
	// invalid_auth is not fixable by joining; a retry would just burn a
	// second API call and could double-post if the first call actually landed.
	getLinkedSlackChannels.mockResolvedValue([
		{
			slackTeamId: "ST",
			channelId: "C1",
			userId: "u1",
			organizationId: null,
		},
	]);
	getLinkedTeamsChannels.mockResolvedValue([]);
	fetchMock.mockResolvedValueOnce(
		slackApiResponse({ ok: false, error: "invalid_auth" }),
	);

	const out = await sendNewsletterChatMessagesActivity({
		sendId: "s",
		projectId: "p",
		organizationId: null,
		userId: "u",
		projectName: "P",
		content,
		chatChannels: [{ platform: "SLACK", teamId: "ST", channelId: "C1" }],
	});

	expect(fetchMock).toHaveBeenCalledTimes(1);
	expect(out).toMatchObject({ sentCount: 0, failedCount: 1 });
});
