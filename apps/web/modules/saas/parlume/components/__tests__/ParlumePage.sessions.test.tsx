import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";
import { ParlumePage } from "../ParlumePage";
import {
	liveSession,
	PROJECT_BASE_PATH,
	SETTINGS_BASE_PATH,
	session,
} from "./fixtures";

const mocks = vi.hoisted(() => ({
	listAgents: vi.fn(),
	listSessions: vi.fn(),
	start: vi.fn(),
	stop: vi.fn(),
	deleteSession: vi.fn(),
	regenerateNotes: vi.fn(),
	proposeActionItem: vi.fn(),
	history: vi.fn(),
	usage: vi.fn(),
	setConfidential: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { parlume: mocks } },
}));

function page(
	sessions: ReturnType<typeof session>[],
	extra: { total?: number; nextCursor?: unknown } = {},
) {
	return {
		sessions,
		total: extra.total ?? sessions.length,
		nextCursor: extra.nextCursor ?? null,
	};
}

const olderCursor = { id: "s5", createdAt: new Date("2026-09-30T08:00:00Z") };

function newestFive(overrides: Parameters<typeof session>[0] = {}) {
	return Array.from({ length: 5 }, (_, index) =>
		session({
			id: `s${index + 1}`,
			agentLabel: `Assistant ${index + 1}`,
			...(index === 0 ? overrides : {}),
		}),
	);
}

beforeAll(() => {
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.setPointerCapture ??= () => undefined;
	Element.prototype.releasePointerCapture ??= () => undefined;
});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.listAgents.mockResolvedValue({ agents: [], operatorReady: true });
	mocks.listSessions.mockResolvedValue(page([]));
	mocks.history.mockResolvedValue({ items: [], total: 0, nextCursor: null });
	mocks.usage.mockResolvedValue({
		totalCostMicroUsd: 0,
		calls: 0,
		sessions: [],
	});
	mocks.stop.mockResolvedValue({});
});
afterEach(cleanup);

function showPage(canEdit = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	render(
		<QueryClientProvider client={client}>
			<ParlumePage
				projectId="example-project"
				projectBasePath={PROJECT_BASE_PATH}
				settingsBasePath={SETTINGS_BASE_PATH}
				canEdit={canEdit}
			/>
		</QueryClientProvider>,
	);
}

const sessionsTable = async () => screen.findByRole("table");
const rowOf = (text: RegExp | string) =>
	screen.getByText(text).closest("tr") as HTMLElement;

describe("ParlumePage sessions table", () => {
	it("marks a session auto-join started with its series", async () => {
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "auto",
					trigger: "AUTO",
					linkedMeeting: { subject: "Weekly sync" },
				}),
				session({ id: "manual", agentLabel: "Invited by hand" }),
			]),
		);
		showPage();
		await sessionsTable();

		expect(
			await screen.findByText("Auto-joined · Weekly sync"),
		).toBeInTheDocument();
		expect(
			within(rowOf("Invited by hand")).queryByText(/Auto-joined/),
		).not.toBeInTheDocument();
	});

	it.each([
		["STOPPED", "Stopped by admin"],
		["REMOVED", "Removed from meeting"],
		["IDLE", "Ended after 3 min of silence"],
		["ACCESS_REVOKED", "Inviter lost access"],
		["STREAM_ERROR", "Transcription failed"],
		["MAX_DURATION", "Reached 4-hour limit"],
		["PROVIDER_FAILED", "Provider failed"],
		["START_FAILED", "Never joined"],
		["NOT_ADMITTED", "Not admitted from the lobby"],
		["EXTERNAL_GUEST", "Left when a guest joined"],
		["ATTENDEE_NOT_AUTHORIZED", "Left for an unconfirmed attendee"],
	])("labels end reason %s as the outcome", async (endReason, label) => {
		mocks.listSessions.mockResolvedValue(
			page([session({ endReason: endReason as "STOPPED" })]),
		);
		showPage();
		expect(await screen.findByText(label)).toBeInTheDocument();
	});

	it("says nobody admitted Parlume when it timed out in the lobby", async () => {
		const reason =
			"Nobody admitted Parlume from the lobby within 5 minutes.";
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					status: "FAILED",
					endReason: "NOT_ADMITTED",
					lastError: reason,
				}),
			]),
		);
		const user = userEvent.setup();
		showPage();
		await screen.findByText("Not admitted from the lobby");
		await user.click(
			within(rowOf("Not admitted from the lobby")).getByRole("button"),
		);
		expect(await screen.findByText(reason)).toBeInTheDocument();
	});

	it("shows when, which agent, mode, length, outcome and cost for each session", async () => {
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "a",
					agentLabel: "Assistant A",
					toolsReadOnly: false,
					endReason: "STOPPED",
				}),
				session({
					id: "b",
					agentLabel: "Assistant B",
					status: "FAILED",
				}),
			]),
		);
		mocks.usage.mockResolvedValue({
			totalCostMicroUsd: 12_300,
			calls: 4,
			sessions: [{ sessionId: "a", costMicroUsd: 12_300, calls: 4 }],
		});
		showPage();
		const table = within(await sessionsTable());

		expect(
			table.getAllByRole("columnheader").map((cell) => cell.textContent),
		).toEqual(["Session", "Mode", "Length", "Outcome", "Cost", "Details"]);
		const first = within(rowOf("Assistant A"));
		expect(first.getByText("Actions")).toBeInTheDocument();
		expect(first.getByText("30 min")).toBeInTheDocument();
		expect(first.getByText("Stopped by admin")).toBeInTheDocument();
		expect(await first.findByText("$0.01")).toBeInTheDocument();
		const second = within(rowOf("Assistant B"));
		expect(second.getByText("Read-only")).toBeInTheDocument();
		expect(second.getByText("Failed")).toBeInTheDocument();
		expect(second.getByText("—", { selector: "td" })).toBeInTheDocument();
	});

	it("shows a viewer who cannot invite Parlume the sessions without any spend", async () => {
		mocks.listSessions.mockResolvedValue(
			page([
				liveSession({ id: "live", agentLabel: "Live assistant" }),
				session({ id: "a", agentLabel: "Assistant A" }),
			]),
		);
		showPage(false);
		const table = within(await sessionsTable());

		expect(
			table.getAllByRole("columnheader").map((cell) => cell.textContent),
		).toEqual(["Session", "Mode", "Length", "Outcome", "Details"]);
		expect(rowOf("Assistant A")).toBeInTheDocument();
		expect(screen.queryByText("Spend so far")).toBeNull();
		expect(screen.queryByText("Costliest sessions")).toBeNull();
		expect(mocks.usage).not.toHaveBeenCalled();
	});

	it("puts the live session first and does not expand it", async () => {
		mocks.listSessions.mockResolvedValue(
			page([
				liveSession({ agentLabel: "Live assistant" }),
				session({
					id: "old",
					agentLabel: "Earlier assistant",
					transcriptContextId: "ctx1",
				}),
			]),
		);
		showPage();
		const table = within(await sessionsTable());
		const rows = table.getAllByRole("row");
		expect(rows[1]).toHaveTextContent("Live assistant");
		expect(rows[1]).toHaveTextContent("In meeting");
		expect(within(rows[1]).queryByRole("button")).toBeNull();
		expect(rows[2]).toHaveTextContent("Earlier assistant");
		expect(
			within(rows[2]).getByRole("button", { expanded: false }),
		).toBeInTheDocument();
	});

	it("marks a live session's cost as spend so far, and a finished one's as final", async () => {
		mocks.listSessions.mockResolvedValue(
			page([
				liveSession({ id: "live", agentLabel: "Live assistant" }),
				session({ id: "done", agentLabel: "Earlier assistant" }),
			]),
		);
		mocks.usage.mockResolvedValue({
			totalCostMicroUsd: 42_000,
			calls: 6,
			sessions: [
				{ sessionId: "live", costMicroUsd: 30_000, calls: 4 },
				{ sessionId: "done", costMicroUsd: 12_000, calls: 2 },
			],
		});
		showPage();
		const rows = within(await sessionsTable()).getAllByRole("row");

		// The live card names the agent too, so the row is found by position.
		const live = within(rows[1]);
		expect(rows[1]).toHaveTextContent("Live assistant");
		expect(await live.findByText("$0.03")).toBeInTheDocument();
		expect(live.getByText("so far")).toBeInTheDocument();
		const done = within(rowOf("Earlier assistant"));
		expect(await done.findByText("$0.01")).toBeInTheDocument();
		expect(done.queryByText("so far")).toBeNull();
	});

	it("opens a finished session to its error, notes and a link to the transcript", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "a",
					agentLabel: "Assistant A",
					status: "FAILED",
					lastError: "Bot crashed",
					transcriptContextId: "ctx1",
					notes: "Decided to ship.",
				}),
			]),
		);
		showPage();
		await sessionsTable();
		const toggle = within(rowOf("Assistant A")).getByRole("button");

		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByText("Bot crashed")).toHaveClass("text-destructive");
		expect(screen.getByText("Meeting notes")).toBeInTheDocument();
		expect(screen.getByText("Decided to ship.")).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Open transcript" }),
		).toHaveAttribute("href", `${PROJECT_BASE_PATH}/contexts/ctx1`);

		await user.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "false");
		expect(screen.queryByText("Decided to ship.")).toBeNull();
	});

	it("renders meeting notes as formatted markdown, not raw markup", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "a",
					agentLabel: "Assistant A",
					notes: "### Discussion\n- Asked about the roadmap.\n- **Agreed** to ship.",
				}),
			]),
		);
		showPage();
		await sessionsTable();

		await user.click(within(rowOf("Assistant A")).getByRole("button"));

		expect(
			screen.getByRole("heading", { name: "Discussion" }),
		).toBeInTheDocument();
		expect(screen.getByText("Asked about the roadmap.").tagName).toBe("LI");
		expect(screen.getByText("Agreed").tagName).toBe("STRONG");
		expect(screen.queryByText(/###/)).toBeNull();
	});

	const anchoredNotes = {
		transcriptContextId: "ctx1",
		notes: "### Decisions\n- Ship the draft on Friday.",
		notesStatus: "COMPLETED",
		notesItems: [
			{
				kind: "decision" as const,
				text: "Ship the draft on Friday.",
				anchorLine: 4,
			},
			{
				kind: "action" as const,
				text: "Write the release notes.",
				anchorLine: 7,
				tentativeOwnerName: "Dev One",
				dueHint: "by Friday",
			},
		],
	};

	it("links each anchored note to the transcript line it rests on", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "a",
					agentLabel: "Assistant A",
					...anchoredNotes,
				}),
			]),
		);
		showPage();
		await sessionsTable();

		await user.click(within(rowOf("Assistant A")).getByRole("button"));

		expect(
			screen.getByRole("heading", { name: "Decisions" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "Action items" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("(Owner: Dev One, Due: by Friday)"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Open the transcript at line 4" }),
		).toHaveAttribute("href", `${PROJECT_BASE_PATH}/contexts/ctx1#t-4`);
		expect(
			screen.getByRole("link", { name: "Open the transcript at line 7" }),
		).toHaveAttribute("href", `${PROJECT_BASE_PATH}/contexts/ctx1#t-7`);
		expect(screen.queryByText(/###/)).toBeNull();
		// Proposing is for a member the list says may.
		expect(screen.queryByRole("button", { name: /^Propose / })).toBeNull();
	});

	it("shows anchored notes without transcript links to a reader who may not open the transcript", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "a",
					agentLabel: "Assistant A",
					...anchoredNotes,
					canReadTranscript: false,
					canDeleteSession: false,
				}),
			]),
		);
		showPage();
		await sessionsTable();

		await user.click(within(rowOf("Assistant A")).getByRole("button"));

		expect(
			screen.getByText("Ship the draft on Friday."),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: /Open the transcript at line/ }),
		).toBeNull();
	});

	it("proposes an action item to the Proposal Inbox for a member who may", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "a",
					agentLabel: "Assistant A",
					...anchoredNotes,
					canProposeActionItems: true,
				}),
			]),
		);
		mocks.proposeActionItem.mockResolvedValue({
			status: "proposed",
			proposalId: "proposal-1",
		});
		showPage();
		await sessionsTable();
		await user.click(within(rowOf("Assistant A")).getByRole("button"));

		// Only the action item, not the decision, can be proposed.
		const propose = screen.getAllByRole("button", { name: /^Propose / });
		expect(propose).toHaveLength(1);
		await user.click(
			screen.getByRole("button", {
				name: 'Propose "Write the release notes." as a ticket',
			}),
		);

		expect(mocks.proposeActionItem).toHaveBeenCalledWith({
			projectId: "example-project",
			sessionId: "a",
			anchorLine: 7,
			text: "Write the release notes.",
		});
		expect(
			await screen.findByText("Proposed to the Proposal Inbox."),
		).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /^Propose / })).toBeNull();
	});

	it("says why an action item could not be proposed, and lets the reader try again", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "a",
					agentLabel: "Assistant A",
					...anchoredNotes,
					canProposeActionItems: true,
				}),
			]),
		);
		mocks.proposeActionItem.mockRejectedValue(
			new Error("This action item is no longer in the meeting's notes."),
		);
		showPage();
		await sessionsTable();
		await user.click(within(rowOf("Assistant A")).getByRole("button"));

		await user.click(screen.getByRole("button", { name: /^Propose / }));

		expect(
			await screen.findByText(
				"This action item is no longer in the meeting's notes.",
			),
		).toHaveAttribute("role", "alert");
		expect(screen.getByRole("button", { name: /^Propose / })).toBeEnabled();
	});

	it("writes the notes again when someone who may delete the session asks", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "a",
					agentLabel: "Assistant A",
					...anchoredNotes,
					canRegenerateNotes: true,
				}),
			]),
		);
		mocks.regenerateNotes.mockResolvedValue({ notesStatus: "PENDING" });
		showPage();
		await sessionsTable();
		await user.click(within(rowOf("Assistant A")).getByRole("button"));
		const listedBefore = mocks.listSessions.mock.calls.length;

		await user.click(
			screen.getByRole("button", { name: "Regenerate notes" }),
		);

		expect(mocks.regenerateNotes).toHaveBeenCalledWith({
			projectId: "example-project",
			sessionId: "a",
		});
		await waitFor(() =>
			expect(mocks.listSessions.mock.calls.length).toBeGreaterThan(
				listedBefore,
			),
		);
	});

	it("offers no regenerate to a reader who may not, and says when the notes are being written again", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "a",
					agentLabel: "Assistant A",
					...anchoredNotes,
					notesStatus: "PENDING",
				}),
			]),
		);
		showPage();
		await sessionsTable();

		await user.click(within(rowOf("Assistant A")).getByRole("button"));

		expect(
			screen.getByText("Writing the notes again…"),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Regenerate notes" }),
		).toBeNull();
	});

	it("says when writing the notes again failed and keeps the earlier notes", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "a",
					agentLabel: "Assistant A",
					...anchoredNotes,
					notesStatus: "FAILED",
					canRegenerateNotes: true,
				}),
			]),
		);
		mocks.regenerateNotes.mockRejectedValue(
			new Error("Parlume is still writing the notes of this meeting."),
		);
		showPage();
		await sessionsTable();
		await user.click(within(rowOf("Assistant A")).getByRole("button"));

		expect(
			screen.getByText(
				"The notes could not be written again. These are the earlier notes.",
			),
		).toBeInTheDocument();
		expect(
			screen.getByText("Ship the draft on Friday."),
		).toBeInTheDocument();

		await user.click(
			screen.getByRole("button", { name: "Regenerate notes" }),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Parlume is still writing the notes of this meeting.",
		);
	});

	it("opens and closes with the keyboard", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "a",
					agentLabel: "Assistant A",
					lastError: "Bot crashed",
				}),
			]),
		);
		showPage();
		await sessionsTable();
		const toggle = within(rowOf("Assistant A")).getByRole("button");

		toggle.focus();
		await user.keyboard("{Enter}");
		expect(screen.getByText("Bot crashed")).toBeInTheDocument();
		await user.keyboard(" ");
		expect(screen.queryByText("Bot crashed")).toBeNull();
	});

	it("says where the notes are, and shows no notes block for a session with no transcript", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "preparing",
					agentLabel: "Assistant Preparing",
					transcriptContextId: "ctx1",
				}),
				session({
					id: "failed",
					agentLabel: "Assistant Failed",
					transcriptContextId: "ctx2",
					notesStatus: "FAILED",
				}),
				session({
					id: "empty",
					agentLabel: "Assistant Empty",
					lastError: "No final speech segments were received.",
				}),
			]),
		);
		showPage();
		await sessionsTable();

		// One session is open at a time, so each click replaces the last.
		await user.click(
			within(rowOf("Assistant Preparing")).getByRole("button"),
		);
		expect(screen.getByText("Meeting notes")).toBeInTheDocument();
		expect(
			screen.getByText("Preparing meeting notes…"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Open transcript" }),
		).toBeInTheDocument();

		await user.click(within(rowOf("Assistant Failed")).getByRole("button"));
		expect(screen.queryByText("Preparing meeting notes…")).toBeNull();
		expect(
			screen.getByText("Meeting notes are unavailable."),
		).toBeInTheDocument();

		await user.click(within(rowOf("Assistant Empty")).getByRole("button"));
		expect(
			screen.getByText("No final speech segments were received."),
		).toBeInTheDocument();
		expect(screen.queryByText("Meeting notes")).toBeNull();
		expect(
			screen.queryByRole("link", { name: "Open transcript" }),
		).toBeNull();
	});

	it("keeps the transcript from a reader who did not invite Parlume and does not manage the project", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "a",
					agentLabel: "Assistant A",
					transcriptContextId: "ctx1",
					notes: "Decided to ship.",
					canReadTranscript: false,
					canDeleteSession: false,
				}),
			]),
		);
		showPage();
		await sessionsTable();

		await user.click(within(rowOf("Assistant A")).getByRole("button"));

		expect(screen.getByText("Decided to ship.")).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "Open transcript" }),
		).toBeNull();
		expect(
			screen.getByText(
				"Only the people invited to this meeting, the person who invited Parlume and project managers can open the transcript.",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Delete session" }),
		).toBeNull();
	});

	it("lets a member the meeting invited open the transcript, but not delete it for everyone", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "a",
					agentLabel: "Assistant A",
					transcriptContextId: "ctx1",
					notes: "Decided to ship.",
					canReadTranscript: true,
					canDeleteSession: false,
				}),
			]),
		);
		showPage();
		await sessionsTable();

		await user.click(within(rowOf("Assistant A")).getByRole("button"));

		expect(
			screen.getByRole("link", { name: "Open transcript" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Delete session" }),
		).toBeNull();
	});

	it("says a deleted transcript is gone and keeps the notes", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "a",
					agentLabel: "Assistant A",
					transcriptContextId: "ctx1",
					transcriptDeletedAt: new Date("2026-10-01T10:00:00Z"),
					notes: "Decided to ship.",
				}),
			]),
		);
		showPage();
		await sessionsTable();

		await user.click(within(rowOf("Assistant A")).getByRole("button"));

		expect(screen.getByText("Decided to ship.")).toBeInTheDocument();
		expect(
			screen.getByText("The transcript was deleted. The notes stay."),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "Open transcript" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Delete session" }),
		).toBeNull();
	});

	it("deletes a finished session only after the reader confirms", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "a",
					agentLabel: "Assistant A",
					transcriptContextId: "ctx1",
					notes: "Decided to ship.",
				}),
			]),
		);
		mocks.deleteSession.mockResolvedValue({
			session: session({ id: "a" }),
		});
		showPage();
		await sessionsTable();
		await user.click(within(rowOf("Assistant A")).getByRole("button"));
		const listedBefore = mocks.listSessions.mock.calls.length;

		await user.click(
			screen.getByRole("button", { name: "Delete session" }),
		);
		expect(mocks.deleteSession).not.toHaveBeenCalled();
		const confirm = screen.getByRole("group", { name: "Confirm deletion" });
		expect(
			within(confirm).getByRole("button", { name: "Keep session" }),
		).toHaveFocus();

		await user.click(
			within(confirm).getByRole("button", { name: "Delete now" }),
		);

		expect(mocks.deleteSession).toHaveBeenCalledWith({
			projectId: "example-project",
			sessionId: "a",
		});
		await waitFor(() =>
			expect(mocks.listSessions.mock.calls.length).toBeGreaterThan(
				listedBefore,
			),
		);
	});

	it("shows why a session could not be deleted", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "a",
					agentLabel: "Assistant A",
					transcriptContextId: "ctx1",
				}),
			]),
		);
		mocks.deleteSession.mockRejectedValue(
			new Error(
				"Parlume is still writing the notes of this meeting. Delete the session when they are ready.",
			),
		);
		showPage();
		await sessionsTable();
		await user.click(within(rowOf("Assistant A")).getByRole("button"));

		await user.click(
			screen.getByRole("button", { name: "Delete session" }),
		);
		await user.click(screen.getByRole("button", { name: "Delete now" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Parlume is still writing the notes of this meeting.",
		);
	});

	it("offers each session's requests only when it has some", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "one",
					agentLabel: "Assistant One",
					requestCount: 1,
				}),
				session({
					id: "many",
					agentLabel: "Assistant Many",
					requestCount: 3,
				}),
				session({
					id: "none",
					agentLabel: "Assistant None",
					requestCount: 0,
				}),
			]),
		);
		showPage();
		await sessionsTable();

		await user.click(within(rowOf("Assistant One")).getByRole("button"));
		expect(
			screen.getByRole("button", { name: "View 1 request" }),
		).toBeInTheDocument();
		await user.click(within(rowOf("Assistant Many")).getByRole("button"));
		expect(
			screen.getByRole("button", { name: "View 3 requests" }),
		).toBeInTheDocument();
		// With nothing to show, the row has nothing to open.
		expect(
			within(rowOf("Assistant None")).queryByRole("button"),
		).toBeNull();
	});

	it("jumps to the Requests tab, filtered to that session", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "a",
					agentLabel: "Assistant A",
					requestCount: 2,
				}),
				session({
					id: "b",
					agentLabel: "Assistant B",
					requestCount: 1,
				}),
			]),
		);
		showPage();
		await sessionsTable();
		await user.click(within(rowOf("Assistant B")).getByRole("button"));
		await user.click(
			screen.getByRole("button", { name: "View 1 request" }),
		);

		expect(screen.getByRole("tab", { name: /Requests/ })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(
			screen.getByRole("combobox", { name: "Session" }),
		).toHaveTextContent(/Assistant B/);
		await waitFor(() =>
			expect(mocks.history).toHaveBeenLastCalledWith({
				projectId: "example-project",
				sessionId: "b",
				before: undefined,
			}),
		);
	});
});

describe("ParlumePage session pages", () => {
	it("shows the newest sessions and appends the next page on request", async () => {
		let finishOlderPage: (page: unknown) => void = () => {};
		mocks.listSessions
			.mockResolvedValueOnce(
				page(newestFive(), { total: 6, nextCursor: olderCursor }),
			)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					finishOlderPage = resolve;
				}),
			);
		showPage();
		const table = within(await sessionsTable());
		expect(table.getAllByRole("row")).toHaveLength(6);
		expect(mocks.listSessions).toHaveBeenLastCalledWith({
			projectId: "example-project",
			before: undefined,
		});

		await userEvent.click(
			screen.getByRole("button", { name: "Show older sessions" }),
		);
		expect(
			await screen.findByRole("button", { name: "Loading…" }),
		).toBeDisabled();
		expect(mocks.listSessions).toHaveBeenLastCalledWith({
			projectId: "example-project",
			before: olderCursor,
		});

		finishOlderPage({
			sessions: [session({ id: "s6", agentLabel: "Assistant 6" })],
			total: null,
			nextCursor: null,
		});
		await waitFor(() => expect(table.getAllByRole("row")).toHaveLength(7));
		expect(table.getByText("Assistant 6")).toBeInTheDocument();
		expect(table.getByText("Assistant 1")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /older sessions/ }),
		).toBeNull();
	});

	it("offers no older sessions when everything fits on one page", async () => {
		mocks.listSessions.mockResolvedValue(page(newestFive()));
		showPage();
		expect(within(await sessionsTable()).getAllByRole("row")).toHaveLength(
			6,
		);
		expect(
			screen.queryByRole("button", { name: /older sessions/ }),
		).toBeNull();
	});

	it("keeps the live session and the request filter working once older sessions are loaded", async () => {
		mocks.listSessions
			.mockResolvedValueOnce(
				page(
					newestFive({
						status: "ACTIVE",
						endedAt: null,
						joinedAt: new Date(Date.now() - 5 * 60_000),
					}),
					{ total: 6, nextCursor: olderCursor },
				),
			)
			.mockResolvedValueOnce(
				page([session({ id: "s6", agentLabel: "Assistant 6" })]),
			);
		showPage();
		await sessionsTable();
		await userEvent.click(
			await screen.findByRole("button", { name: "Show older sessions" }),
		);
		await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(7));

		expect(screen.getAllByText("Live in meeting")).toHaveLength(1);
		await userEvent.click(screen.getByRole("tab", { name: /Requests/ }));
		await userEvent.click(
			screen.getByRole("combobox", { name: "Session" }),
		);
		const options = await screen.findAllByRole("option");
		expect(options).toHaveLength(7);
		await userEvent.click(
			screen.getByRole("option", { name: /Assistant 6/ }),
		);
		await waitFor(() =>
			expect(mocks.history).toHaveBeenLastCalledWith({
				projectId: "example-project",
				sessionId: "s6",
				before: undefined,
			}),
		);
	});

	it("says so when older sessions cannot be loaded and lets the reader try again", async () => {
		mocks.listSessions
			.mockResolvedValueOnce(
				page(newestFive(), { total: 6, nextCursor: olderCursor }),
			)
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(
				page([session({ id: "s6", agentLabel: "Assistant 6" })]),
			);
		showPage();
		await sessionsTable();
		await userEvent.click(
			screen.getByRole("button", { name: "Show older sessions" }),
		);
		expect(
			await screen.findByText(/Could not load older sessions/),
		).toHaveAttribute("role", "alert");
		expect(screen.getAllByRole("row")).toHaveLength(6);

		await userEvent.click(
			screen.getByRole("button", { name: "Show older sessions" }),
		);
		await waitFor(() => expect(screen.getAllByRole("row")).toHaveLength(7));
	});

	it("lets the reader retry when the first page cannot be loaded", async () => {
		mocks.listSessions
			.mockRejectedValueOnce(new Error("offline"))
			.mockResolvedValueOnce(page(newestFive()));
		showPage();
		expect(
			await screen.findByText("Could not load Parlume sessions."),
		).toHaveAttribute("role", "alert");
		await userEvent.click(
			screen.getByRole("button", { name: "Retry sessions" }),
		);
		expect(await sessionsTable()).toBeInTheDocument();
	});

	it("says there are no sessions yet", async () => {
		showPage();
		expect(
			await screen.findByText("No Parlume sessions yet."),
		).toBeInTheDocument();
	});
});

describe("ParlumePage confidential meetings", () => {
	it("tells a reader who was not in a confidential meeting that its content is kept to the people in it", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "c",
					agentLabel: "Confidential sync",
					transcriptContextId: "ctx1",
					confidential: true,
					contentWithheld: true,
					canReadTranscript: false,
					canDeleteSession: false,
				}),
			]),
		);
		showPage(false);
		await sessionsTable();

		await user.click(
			within(rowOf("Confidential sync")).getByRole("button"),
		);

		expect(
			screen.getByText(
				"This meeting is confidential. Its notes, requests, suggestions and transcript are kept to the people in it and the project's managers.",
			),
		).toBeInTheDocument();
		expect(screen.queryByText("Meeting notes")).toBeNull();
		expect(
			screen.queryByRole("link", { name: "Open transcript" }),
		).toBeNull();
		expect(
			screen.queryByRole("button", { name: "Remove confidential mark" }),
		).toBeNull();
	});

	it("lets someone who was in a finished meeting mark it confidential", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "m",
					agentLabel: "Planning",
					transcriptContextId: "ctx1",
					notes: "Decided to ship.",
					canMarkConfidential: true,
				}),
			]),
		);
		mocks.setConfidential.mockResolvedValue({});
		showPage();
		await sessionsTable();

		await user.click(within(rowOf("Planning")).getByRole("button"));
		await user.click(
			screen.getByRole("button", { name: "Mark meeting confidential" }),
		);

		expect(mocks.setConfidential).toHaveBeenCalledWith({
			projectId: "example-project",
			sessionId: "m",
			confidential: true,
		});
	});
});
