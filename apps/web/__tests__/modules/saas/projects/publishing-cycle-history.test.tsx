/**
 * PublishingCycleHistory — the refresh-history table (Fizzy #1850, Phase 1C-4a).
 *
 * `@tanstack/react-query` is mocked wholesale, mirroring
 * `publishing-suite-list.test.tsx` in this same directory: `useQuery` resolves
 * against a hoisted `state` fixture keyed off the oRPC procedure path baked
 * into the mocked `orpc.*.queryOptions` queryKey, and the input that reached
 * it is recorded so the filter/pagination cases can assert what was requested
 * rather than what was rendered.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";

const {
	state,
	refetchCycles,
	refetchChatDeliveries,
	lastInput,
	lastChatInput,
	enabledByProcedure,
} = vi.hoisted(() => ({
	state: {
		cycles: [] as Array<Record<string, unknown>>,
		total: 0,
		isPending: false,
		isError: false,
		// 1C-4b — the Channels disclosure.
		chatChannelsConfigured: false,
		chatDeliveries: [] as Array<Record<string, unknown>>,
		chatIsError: false,
		chatIsPending: false,
	},
	refetchCycles: vi.fn(),
	refetchChatDeliveries: vi.fn(),
	lastInput: { value: undefined as unknown },
	lastChatInput: { value: undefined as unknown },
	// `opts.enabled` was ignored entirely by this mock, so "nothing is fetched
	// until a row is expanded" was unassertable: an implementation that dropped
	// `enabled` would issue a request on every render with an empty cycle id and
	// every case here would still pass.
	enabledByProcedure: new Map<string, boolean | undefined>(),
}));

vi.mock("@tanstack/react-query", () => ({
	useQuery: (opts: { queryKey?: unknown[]; enabled?: boolean }) => {
		const procedure = Array.isArray(opts?.queryKey)
			? opts.queryKey[0]
			: undefined;
		if (typeof procedure === "string") {
			enabledByProcedure.set(procedure, opts?.enabled);
		}
		if (procedure === "projects.publishingSuite.listCycles") {
			lastInput.value = Array.isArray(opts?.queryKey)
				? opts.queryKey[1]
				: undefined;
			return {
				data: state.isError
					? undefined
					: {
							cycles: state.cycles,
							total: state.total,
							chatChannelsConfigured:
								state.chatChannelsConfigured,
						},
				isPending: state.isPending,
				isLoading: state.isPending,
				isError: state.isError,
				refetch: refetchCycles,
			};
		}
		if (procedure === "projects.publishingSuite.cycleChatDeliveries") {
			// Recorded for the same reason `lastInput` is recorded for the outer
			// table: without it nothing pins WHICH cycle the disclosure asks
			// about, so sending an empty id, or always the first row's id, would
			// pass every case here.
			lastChatInput.value = Array.isArray(opts?.queryKey)
				? opts.queryKey[1]
				: undefined;
			return {
				data: state.chatIsError
					? undefined
					: { deliveries: state.chatDeliveries },
				isPending: state.chatIsPending,
				isLoading: state.chatIsPending,
				isError: state.chatIsError,
				refetch: refetchChatDeliveries,
			};
		}
		return {
			data: undefined,
			isPending: false,
			isLoading: false,
			isError: false,
			refetch: vi.fn(),
		};
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const q = (procedure: string) => ({
		queryOptions: ({ input }: { input?: unknown }) => ({
			queryKey: [procedure, input],
			queryFn: async () => undefined,
		}),
		queryKey: ({ input }: { input?: unknown }) => [procedure, input],
	});
	return {
		orpc: {
			projects: {
				publishingSuite: {
					listCycles: q("projects.publishingSuite.listCycles"),
					cycleChatDeliveries: q(
						"projects.publishingSuite.cycleChatDeliveries",
					),
				},
			},
		},
	};
});

import { PublishingCycleHistory } from "@saas/projects/components/publishing-suite/PublishingCycleHistory";

function renderHistory() {
	return render(
		<PublishingCycleHistory projectId="p1" organizationId={null} />,
	);
}

const READY_MANUAL = {
	id: "c1",
	status: "READY",
	startedAt: new Date("2026-08-01T10:00:00Z"),
	completedAt: new Date("2026-08-01T10:02:30Z"),
	trigger: "manual" as const,
	topicCount: 3,
	chatDeliveryCount: 0,
	notificationOutcome: "SENT",
	// Complete reach: everyone owed a notification got one, so the label needs
	// no qualifying number.
	notifiedRecipients: { owed: 2, delivered: 2 },
};

const EMPTY_SCHEDULED = {
	id: "c2",
	status: "NO_TOPICS",
	startedAt: new Date("2026-07-01T10:00:00Z"),
	completedAt: new Date("2026-07-01T10:00:20Z"),
	trigger: "scheduled" as const,
	topicCount: 0,
	// A cycle that produced nothing never enters the notification lifecycle, so
	// the column keeps its default. Faithful to the engine, not merely a spare
	// enum value: §9.1 fires no notification for a NO_TOPICS terminal.
	notificationOutcome: "NOT_APPLICABLE",
	notifiedRecipients: { owed: 0, delivered: 0 },
};

const CHAT_ROW = { ...READY_MANUAL, chatDeliveryCount: 2 };
const CHAT_KEY = "projects.publishingSuite.cycleChatDeliveries";

beforeEach(() => {
	vi.clearAllMocks();
	state.cycles = [];
	state.total = 0;
	state.isPending = false;
	state.isError = false;
	// Reset BY NAME, like the fields above — this fixture is not wholesale-reset,
	// so an unlisted field leaks from one case into the next.
	state.chatChannelsConfigured = false;
	state.chatDeliveries = [];
	state.chatIsError = false;
	state.chatIsPending = false;
	lastInput.value = undefined;
	lastChatInput.value = undefined;
	enabledByProcedure.clear();
});

it("renders a row per cycle with its trigger, duration and topic count", () => {
	state.cycles = [READY_MANUAL, EMPTY_SCHEDULED];
	state.total = 2;
	renderHistory();

	const rows = screen.getAllByRole("row");
	// One header row plus one per cycle.
	expect(rows).toHaveLength(3);
	expect(within(rows[1]).getByText("Manual")).toBeTruthy();
	expect(within(rows[1]).getByText("Ready")).toBeTruthy();
	expect(within(rows[1]).getByText("2m 30s")).toBeTruthy();
	expect(within(rows[1]).getByText("3")).toBeTruthy();
	expect(within(rows[2]).getByText("Scheduled")).toBeTruthy();
	// NO_TOPICS and INSUFFICIENT_CONTEXT share this label on purpose.
	expect(within(rows[2]).getByText("No topics")).toBeTruthy();
});

it("shows a retryable error rather than the empty state when the read fails", async () => {
	state.isError = true;
	renderHistory();

	// The specific defect this guards: an errored query has undefined data, so
	// a component that checks emptiness first renders "No refreshes yet" for
	// what is actually a failed read — hiding exactly what someone opened the
	// table to find.
	expect(screen.queryByText("No refreshes yet.")).toBeNull();
	expect(
		screen.getByText("Could not load the refresh history."),
	).toBeTruthy();

	await userEvent.click(screen.getByRole("button", { name: "Retry" }));
	expect(refetchCycles).toHaveBeenCalled();
});

it("shows the empty state only when the read SUCCEEDED with zero rows", () => {
	state.cycles = [];
	state.total = 0;
	renderHistory();
	expect(screen.getByText("No refreshes yet.")).toBeTruthy();
});

it("derives no emptiness while the read is still pending", () => {
	state.isPending = true;
	renderHistory();
	expect(screen.getByText("Loading refreshes…")).toBeTruthy();
	expect(screen.queryByText("No refreshes yet.")).toBeNull();
});

it("sends the chosen outcome filter to the query and resets to the first page", async () => {
	state.cycles = [READY_MANUAL];
	state.total = 200;
	renderHistory();

	await userEvent.click(screen.getByRole("button", { name: "Next" }));
	expect((lastInput.value as { offset: number }).offset).toBe(15);

	await userEvent.click(screen.getByRole("button", { name: "Failed" }));
	const input = lastInput.value as { status: string; offset: number };
	expect(input.status).toBe("failed");
	// Changing the filter while on page 2 must not leave the offset behind:
	// landing past the end of a narrower result set renders an empty table
	// that reads as "no refreshes" — the same lie the error branch avoids.
	expect(input.offset).toBe(0);
});

it("keeps the filter reachable when the current one returns nothing", async () => {
	state.cycles = [];
	state.total = 0;
	renderHistory();

	// Rendered outside the state switch on purpose: if the chips lived inside
	// the rows branch, an empty filter would have no way back except a reload.
	await userEvent.click(screen.getByRole("button", { name: "Ready" }));
	expect((lastInput.value as { status: string }).status).toBe("ready");
	expect(screen.getByText("No refreshes match this filter.")).toBeTruthy();
});

it("leaves the duration blank for a cycle that has not finished", () => {
	state.cycles = [
		{
			id: "c3",
			status: "GENERATING",
			startedAt: new Date("2026-08-01T10:00:00Z"),
			completedAt: null,
			trigger: "scheduled" as const,
			topicCount: 0,
		},
	];
	state.total = 1;
	renderHistory();

	expect(screen.getByText("Running")).toBeTruthy();
	// A duration measured against `now` would tick without the row being
	// refetched, which reads as data rather than as a clock.
	//
	// Scoped to the Duration cell rather than asking the whole table for "—".
	// The Notified column answers "never entered the notification lifecycle"
	// with the same em dash, so a document-wide query is now ambiguous — and it
	// would pass on a row where the dash came from the wrong column.
	const rows = screen.getAllByRole("row");
	const headers = within(rows[0]).getAllByRole("columnheader");
	const at = headers.findIndex((h) => h.textContent === "Duration");
	expect(within(rows[1]).getAllByRole("cell")[at].textContent).toBe("—");
});

// ---- The Channels disclosure (1C-4b).

it("does not offer a disclosure for a project that targets no channel", () => {
	state.cycles = [READY_MANUAL];
	state.total = 1;
	renderHistory();
	expect(screen.queryByRole("button", { name: /Channels/ })).toBeNull();
});

it("offers it when the project targets a channel even with no rows recorded", async () => {
	// The six whole-run gates in the broadcast write NO ledger row, so a zero
	// count on a chat-targeting project means "refused, or never ran", not
	// "nothing to show" — and that is exactly the case worth opening.
	state.cycles = [READY_MANUAL];
	state.chatChannelsConfigured = true;
	state.total = 1;
	renderHistory();

	await userEvent.click(screen.getByRole("button", { name: /Channels/ }));
	expect(
		screen.getByText(/No per-channel outcome was recorded/),
	).toBeTruthy();
});

it("keeps the topic count out of the disclosure's cell, so it cannot read as a channel count", () => {
	// Observed on staging: the count and the control shared one right-aligned
	// numeric cell, so a row rendered the count immediately followed by the
	// word "Channels" — read as one phrase, and the topic count was taken for
	// the number of channels. Neither value was wrong; they only touched.
	//
	// CHAT_ROW carries topicCount 3 and chatDeliveryCount 2 — deliberately
	// different numbers, so this cannot pass by the two happening to agree.
	state.cycles = [CHAT_ROW];
	state.chatChannelsConfigured = true;
	state.total = 1;
	renderHistory();

	// Exact match, not `getByText`: before the fix this cell's text was
	// "3Channels", so requiring the cell to hold the number ALONE is what
	// makes the assertion fail on the old markup rather than pass on a
	// substring.
	const cells = screen.getAllByRole("cell");
	const countCell = cells.find((c) => c.textContent === "3");
	expect(countCell).toBeTruthy();
	expect(within(countCell as HTMLElement).queryByRole("button")).toBeNull();

	// And the control is still rendered — in a cell that is not that one.
	const channels = screen.getByRole("button", { name: /Channels/ });
	expect(channels.closest("td")).not.toBe(countCell);
});

// The workflow dispatches the broadcast only for a READY cycle, so these rows
// have no deliveries because the activity was never invoked — no refusal, and
// no aggregate log line to send an operator to. Without the status clause,
// selecting "Failed" or "No topics" on a chat-configured project would put a
// confident, wrong causal explanation on every row in the table.
it.each(["NO_TOPICS", "FAILED", "GENERATING", "INSUFFICIENT_CONTEXT"])(
	"offers no disclosure for a %s cycle, which was never eligible to broadcast",
	(status) => {
		state.cycles = [{ ...READY_MANUAL, status }];
		state.chatChannelsConfigured = true;
		state.total = 1;
		renderHistory();
		expect(screen.queryByRole("button", { name: /Channels/ })).toBeNull();
	},
);

it("asks about the cycle that was actually expanded", async () => {
	state.cycles = [
		{ ...CHAT_ROW, id: "c1" },
		{ ...CHAT_ROW, id: "c2" },
	];
	state.total = 2;
	renderHistory();

	// The SECOND row, so a component that always sent the first cycle's id — or
	// an empty one — cannot pass by coincidence.
	const buttons = screen.getAllByRole("button", { name: /Channels/ });
	await userEvent.click(buttons[1]);

	expect(lastChatInput.value).toEqual({
		projectId: "p1",
		organizationId: null,
		cycleId: "c2",
	});
});

it("shows a loading state rather than claiming no channels while fetching", async () => {
	state.cycles = [CHAT_ROW];
	state.total = 1;
	state.chatIsPending = true;
	renderHistory();
	await userEvent.click(screen.getByRole("button", { name: /Channels/ }));

	// Same failure shape as the error branch: "no per-channel outcome" during
	// the first fetch of every expansion would conflate "nothing yet" with
	// "nothing at all".
	expect(screen.getByText("Loading channel detail…")).toBeTruthy();
	expect(screen.queryByText(/No per-channel outcome/)).toBeNull();
});

it("fetches nothing until a row is expanded, and stops on collapse", async () => {
	state.cycles = [CHAT_ROW];
	state.total = 1;
	renderHistory();

	expect(enabledByProcedure.get(CHAT_KEY)).toBe(false);

	await userEvent.click(screen.getByRole("button", { name: /Channels/ }));
	expect(enabledByProcedure.get(CHAT_KEY)).toBe(true);

	await userEvent.click(
		screen.getByRole("button", { name: /Hide channels/ }),
	);
	expect(enabledByProcedure.get(CHAT_KEY)).toBe(false);
});

it.each([
	[
		"Next",
		async () =>
			userEvent.click(screen.getByRole("button", { name: "Next" })),
	],
	[
		"a filter chip",
		async () =>
			userEvent.click(screen.getByRole("button", { name: "Failed" })),
	],
])("closes the disclosure when %s changes the page", async (_label, act) => {
	state.cycles = [CHAT_ROW];
	state.total = 200;
	renderHistory();

	await userEvent.click(screen.getByRole("button", { name: /Channels/ }));
	expect(enabledByProcedure.get(CHAT_KEY)).toBe(true);

	await act();

	// The expanded row is a property of a row ON SCREEN. Left open across a page
	// or filter change it names a cycle the new page does not contain, so nothing
	// renders while the detail query stays enabled and keeps fetching a cycle
	// nobody is looking at — and stepping back re-opens a row the user never
	// re-opened.
	expect(enabledByProcedure.get(CHAT_KEY)).toBe(false);
});

it("shows a retryable error rather than claiming no channels", async () => {
	state.cycles = [CHAT_ROW];
	state.total = 1;
	state.chatIsError = true;
	renderHistory();
	await userEvent.click(screen.getByRole("button", { name: /Channels/ }));

	// Same order, same reason as the outer table: an errored query has undefined
	// data, so an emptiness check placed first would report "no channels" for
	// what is actually a failed read.
	expect(screen.queryByText(/No per-channel outcome/)).toBeNull();
	expect(screen.getByText("Could not load channel detail.")).toBeTruthy();

	await userEvent.click(screen.getByRole("button", { name: "Retry" }));
	expect(refetchChatDeliveries).toHaveBeenCalled();
});

it("renders two channels that differ only by workspace", async () => {
	state.cycles = [CHAT_ROW];
	state.total = 1;
	state.chatDeliveries = [
		{
			platform: "SLACK",
			externalTeamId: "T1",
			channelId: "C1",
			channelName: "release-notes",
			status: "SENT",
			reason: null,
		},
		{
			platform: "SLACK",
			externalTeamId: "T2",
			channelId: "C1",
			channelName: "announcements",
			status: "FAILED",
			reason: "Fabric is not a member of this Slack channel.",
		},
	];
	renderHistory();
	await userEvent.click(screen.getByRole("button", { name: /Channels/ }));

	expect(screen.getByText(/release-notes/)).toBeTruthy();
	expect(screen.getByText(/announcements/)).toBeTruthy();
	expect(
		screen.getByText("Fabric is not a member of this Slack channel."),
	).toBeTruthy();
	// SENT maps to "Delivered" with no reason line; FAILED carries its copy.
	expect(screen.getByText("Delivered")).toBeTruthy();
});

// `platform` is plain TEXT with no enum and no CHECK, so a ternary defaulting
// to "Teams" would not degrade an unrecognised value — it would assert a wrong
// one, telling an operator to go and look in a product the row has nothing to
// do with.
it("names an unrecognised platform instead of calling it Teams", async () => {
	state.cycles = [CHAT_ROW];
	state.total = 1;
	state.chatDeliveries = [
		{
			platform: "DISCORD",
			externalTeamId: "T1",
			channelId: "C1",
			channelName: "general",
			status: "SENT",
			reason: null,
		},
	];
	renderHistory();
	await userEvent.click(screen.getByRole("button", { name: /Channels/ }));

	expect(screen.getByText(/DISCORD/)).toBeTruthy();
	expect(screen.queryByText(/Teams/)).toBeNull();
});

// SKIPPED and SENDING are primary publishing outcomes — the two skip
// classifications are a large part of why this reader exists — but neither was
// rendered by any case, so their badge labels were unexercised end to end.
it("renders every delivery status the ledger can hold", async () => {
	state.cycles = [CHAT_ROW];
	state.total = 1;
	state.chatDeliveries = [
		{
			platform: "SLACK",
			externalTeamId: "T1",
			channelId: "C1",
			channelName: "a",
			status: "SKIPPED",
			reason: "This channel is no longer linked to the project.",
		},
		{
			platform: "TEAMS",
			externalTeamId: "T2",
			channelId: "C2",
			channelName: "b",
			status: "SENDING",
			reason: "Delivery is in progress — this refresh is still broadcasting.",
		},
	];
	renderHistory();
	await userEvent.click(screen.getByRole("button", { name: /Channels/ }));

	expect(screen.getByText("Skipped")).toBeTruthy();
	expect(screen.getByText("Unconfirmed")).toBeTruthy();
});

it("renders no user id — the trigger is a two-value label", () => {
	state.cycles = [{ ...READY_MANUAL, triggeredByUserId: "acting-user-77" }];
	state.total = 1;
	const { container } = renderHistory();

	// The procedure already refuses to send the id; this is the second half of
	// the same guarantee, in case a future change starts passing the row
	// through. Asserted on the whole subtree rather than a named field, since
	// the failure mode is an unexpected field being rendered.
	expect(container.textContent).not.toContain("acting-user-77");
});

/**
 * The notification-outcome column (Fizzy #1850, PO follow-up).
 *
 * The cycle already RECORDS why in-app and email did or did not go out —
 * `notificationOutcome`, nine values, written since 1C-2b — and until now no
 * surface read it. A reader who got the chat message and no bell had no way to
 * tell "nobody was attributed to these topics" from "the recipient lookup
 * threw", which are the two states the vocabulary exists to keep apart.
 */
it("labels the notification outcome, in the row's own cell", () => {
	state.cycles = [READY_MANUAL];
	state.total = 1;
	renderHistory();

	const row = screen.getAllByRole("row")[1];
	expect(within(row).getByText("Sent")).toBeTruthy();
});

it("says nobody was eligible in words, not by leaving the cell blank", () => {
	// The case the PO hit. NO_RECIPIENTS is a resolved, healthy outcome — an
	// empty cell here would be read as "no data", which is the ambiguity this
	// column exists to remove.
	state.cycles = [{ ...READY_MANUAL, notificationOutcome: "NO_RECIPIENTS" }];
	state.total = 1;
	renderHistory();

	expect(screen.getByText("No one to notify")).toBeTruthy();
});

it("marks a cycle that never entered the lifecycle as not applicable, not as missing", () => {
	// NOT_APPLICABLE is the column default and means the question was never
	// asked — distinct from NO_RECIPIENTS, which means it was asked and the
	// answer was nobody. It must not borrow another outcome's label, and it
	// must not render blank either: an empty cell is indistinguishable from a
	// dropped API field or a broken render, which is the ambiguity this column
	// exists to remove. An em dash says "deliberately nothing", matching what
	// `formatDuration` already does for a run with no end time.
	state.cycles = [EMPTY_SCHEDULED];
	state.total = 1;
	const { container } = renderHistory();

	const rows = screen.getAllByRole("row");
	// Located by header text rather than a hard-coded index, so inserting a
	// column ahead of this one moves the assertion with it instead of silently
	// checking the wrong cell.
	const headers = within(rows[0]).getAllByRole("columnheader");
	const at = headers.findIndex((h) => h.textContent === "Notified");
	expect(at).toBeGreaterThanOrEqual(0);

	const cell = within(rows[1]).getAllByRole("cell")[at];
	expect(cell.textContent).toBe("—");
	expect(container.textContent).not.toContain("NOT_APPLICABLE");
	expect(screen.queryByText("No one to notify")).toBeNull();
	expect(screen.queryByText("Sent")).toBeNull();
});

it("does not tell a refresh that produced topics that it produced none", () => {
	// Found by reading the real table on a deployed environment: a row showing
	// Ready and 6 topics carried the tooltip "never reached the notification
	// step — it produced no topics, or it failed before that point". Both halves
	// are contradicted by the two columns sitting next to it.
	//
	// The cause is not a bug in the engine. `notificationOutcome` is NOT NULL
	// with default "NOT_APPLICABLE", so every cycle older than the notification
	// lifecycle carries that value from the backfill — "never entered the
	// lifecycle" is true, and the tooltip's explanation of WHY is not. On a
	// column whose whole purpose is to answer "why was nobody told?", a
	// confidently wrong why is worse than the blank the em dash replaced.
	state.cycles = [{ ...READY_MANUAL, notificationOutcome: "NOT_APPLICABLE" }];
	state.total = 1;
	renderHistory();

	const rows = screen.getAllByRole("row");
	const headers = within(rows[0]).getAllByRole("columnheader");
	const at = headers.findIndex((h) => h.textContent === "Notified");
	const cell = within(rows[1]).getAllByRole("cell")[at];

	// Still an em dash: nothing was delivered and nothing is known, so a
	// distinct marker would imply a state this row does not have.
	expect(cell.textContent).toBe("—");
	const detail = cell.getAttribute("title") ?? "";
	expect(detail).not.toContain("produced no topics");
	expect(detail).not.toContain("failed before that point");
	expect(detail).toContain("did not record notification outcomes");
});

it("keeps the original explanation for a refresh that really did produce nothing", () => {
	// The other half of the split, and the reason it is a split rather than a
	// rewrite: for a NO_TOPICS cycle the original wording is TRUE and useful.
	// Weakening both rows to one vague sentence would have traded a wrong
	// explanation for no explanation, which is not the trade being made here.
	state.cycles = [EMPTY_SCHEDULED];
	state.total = 1;
	renderHistory();

	const rows = screen.getAllByRole("row");
	const headers = within(rows[0]).getAllByRole("columnheader");
	const at = headers.findIndex((h) => h.textContent === "Notified");
	const detail =
		within(rows[1]).getAllByRole("cell")[at].getAttribute("title") ?? "";

	expect(detail).toContain("produced no topics");
	expect(detail).not.toContain("did not record notification outcomes");
});

it("says what Sent actually promises, since the word alone overstates it", () => {
	// SENT means "every owed row terminal, at least one confirmed delivered" —
	// so a refresh that reached one contributor and skipped three is SENT. The
	// label stays short to keep the column scannable, so the cell has to carry
	// the qualification somewhere a reader can reach it.
	state.cycles = [READY_MANUAL];
	state.total = 1;
	renderHistory();

	const cell = screen.getByText("Sent").closest("td");
	expect(cell?.getAttribute("title")).toContain("At least one");
});

it("qualifies Sent with the reach when some recipients were not reached", () => {
	// The case the label alone gets wrong: the cycle is SENT because at least
	// one delivery landed, while three of the five people owed one were
	// skipped. Without the number a reader cannot tell this apart from a
	// refresh that reached everybody.
	state.cycles = [
		{
			...READY_MANUAL,
			notifiedRecipients: { owed: 5, delivered: 2 },
		},
	];
	state.total = 1;
	renderHistory();

	const rows = screen.getAllByRole("row");
	const headers = within(rows[0]).getAllByRole("columnheader");
	const at = headers.findIndex((h) => h.textContent === "Notified");
	const cell = within(rows[1]).getAllByRole("cell")[at];

	expect(cell.textContent).toContain("2 of 5");
	// Not flush against the label. A bare number touching a word is how this
	// table once made a topic count read as a channel count.
	expect(cell.textContent).not.toContain("Sent2");
});

it("prints no reach count when everyone owed a notification got one", () => {
	// READY_MANUAL is 2 of 2. A number that only ever restates the label is
	// noise, and it would compete with the one that carries information.
	state.cycles = [READY_MANUAL];
	state.total = 1;
	renderHistory();

	const rows = screen.getAllByRole("row");
	const headers = within(rows[0]).getAllByRole("columnheader");
	const at = headers.findIndex((h) => h.textContent === "Notified");
	const cell = within(rows[1]).getAllByRole("cell")[at];

	expect(cell.textContent).toBe("Sent");
});

it("echoes an unrecognised outcome instead of mislabelling it", () => {
	// NEGATIVE CONTROL on the `Object.hasOwn` lookup, mirroring `describeStatus`.
	// `notification_outcome` is TEXT under a CHECK, not a Postgres enum, so a
	// value this build has never heard of can reach the table — and the failure
	// that matters is not a blank cell but a CONFIDENT WRONG LABEL. A bare
	// `LABELS[value] ?? fallback` also resolves "toString" to a function, which
	// is truthy and defeats the fallback.
	state.cycles = [
		{ ...READY_MANUAL, notificationOutcome: "SOME_FUTURE_OUTCOME" },
	];
	state.total = 1;
	renderHistory();

	expect(screen.getByText("SOME_FUTURE_OUTCOME")).toBeTruthy();
	expect(screen.queryByText("Sent")).toBeNull();
});

it("gives every body row exactly as many cells as the table has headers", () => {
	// A STRUCTURAL guard, and the generalisation of the defect fixed in #3018:
	// the topic count and the chat control shared one cell, so the count read as
	// a channel count. Nothing then stopped the next column from misaligning the
	// same way, and a `colSpan` left at its old value is invisible in every
	// content assertion in this file.
	state.cycles = [READY_MANUAL, EMPTY_SCHEDULED];
	state.total = 2;
	renderHistory();

	const rows = screen.getAllByRole("row");
	const headers = within(rows[0]).getAllByRole("columnheader").length;
	for (const row of rows.slice(1)) {
		expect(within(row).getAllByRole("cell")).toHaveLength(headers);
	}
});

it("spans the expanded chat detail across every column", async () => {
	// The other half of the same guard. The detail row is ONE cell carrying a
	// hard-coded `colSpan`, so it is the one place a new column cannot break
	// loudly — it just stops reaching the right edge. Deriving the expectation
	// from the header count rather than restating a literal is what makes this
	// survive the next column.
	state.cycles = [CHAT_ROW];
	state.chatChannelsConfigured = true;
	state.total = 1;
	renderHistory();
	await userEvent.click(screen.getByRole("button", { name: /Channels/ }));

	const headers = within(screen.getAllByRole("row")[0]).getAllByRole(
		"columnheader",
	).length;
	const detail = screen
		.getAllByRole("cell")
		.find((cell) => cell.hasAttribute("colspan"));
	expect(detail?.getAttribute("colspan")).toBe(String(headers));
});
