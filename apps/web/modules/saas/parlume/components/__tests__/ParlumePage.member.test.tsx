import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
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
	request,
	SETTINGS_BASE_PATH,
	type session,
	suggestion,
} from "./fixtures";

const mocks = vi.hoisted(() => ({
	listAgents: vi.fn(),
	listSessions: vi.fn(),
	start: vi.fn(),
	stop: vi.fn(),
	history: vi.fn(),
	usage: vi.fn(),
	suggestions: vi.fn(),
	transcript: vi.fn(),
	ask: vi.fn(),
	saySuggestion: vi.fn(),
	dismissSuggestion: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { parlume: mocks } },
}));

function page(sessions: ReturnType<typeof session>[]) {
	return { sessions, total: sessions.length, nextCursor: null };
}

beforeAll(() => {
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.setPointerCapture ??= () => undefined;
	Element.prototype.releasePointerCapture ??= () => undefined;
	Element.prototype.scrollIntoView ??= () => undefined;
});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.listAgents.mockResolvedValue({ agents: [], operatorReady: true });
	mocks.listSessions.mockResolvedValue(page([liveSession()]));
	mocks.history.mockResolvedValue({ items: [], total: 0, nextCursor: null });
	mocks.usage.mockResolvedValue({
		totalCostMicroUsd: 0,
		calls: 0,
		sessions: [],
	});
	mocks.suggestions.mockResolvedValue({ items: [] });
	mocks.transcript.mockResolvedValue({ readable: true, segments: [] });
	mocks.ask.mockResolvedValue({ turnId: "turn-1" });
	mocks.saySuggestion.mockResolvedValue({ spoken: true });
	mocks.dismissSuggestion.mockResolvedValue({ dismissed: true });
});
afterEach(() => {
	cleanup();
	window.history.replaceState(null, "", "/");
});

function showPage(canAct: boolean) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	render(
		<QueryClientProvider client={client}>
			<ParlumePage
				projectId="example-project"
				projectBasePath={PROJECT_BASE_PATH}
				settingsBasePath={SETTINGS_BASE_PATH}
				canEdit={false}
				canAct={canAct}
			/>
		</QueryClientProvider>,
	);
}

const suggestionsSection = async () =>
	(await screen.findByRole("heading", { name: "Suggestions" })).closest(
		"section",
	) as HTMLElement;

describe("ParlumePage live transcript", () => {
	it("shows what the meeting said, with chat lines and pauses marked", async () => {
		mocks.transcript.mockResolvedValue({
			readable: true,
			segments: [
				{
					id: "line-1",
					source: "SPEECH",
					speakerName: "Attendee One",
					text: "Let's look at the export.",
					createdAt: new Date("2026-11-21T10:01:00Z"),
				},
				{
					id: "line-2",
					source: "CHAT",
					speakerName: "Attendee Two",
					text: "Link in a minute",
					createdAt: new Date("2026-11-21T10:02:00Z"),
				},
				{
					id: "line-3",
					source: "EVENT",
					speakerName: null,
					text: "Listening paused by Attendee One",
					createdAt: new Date("2026-11-21T10:03:00Z"),
				},
			],
		});
		showPage(false);

		const heading = await screen.findByRole("heading", {
			name: "Live transcript",
		});
		const transcript = within(heading.closest("section") as HTMLElement);
		expect(
			await transcript.findByText(/Let's look at the export\./),
		).toBeInTheDocument();
		const lines = transcript.getAllByRole("listitem");
		expect(lines).toHaveLength(3);
		expect(within(lines[1]).getByText("Chat")).toBeInTheDocument();
		expect(within(lines[0]).queryByText("Chat")).toBeNull();
		expect(
			within(lines[2]).getByText("Listening paused by Attendee One"),
		).toBeInTheDocument();
		expect(mocks.transcript).toHaveBeenCalledWith({
			projectId: "example-project",
			sessionId: "live1",
		});
	});

	it("shows no transcript to a reader who may not read it", async () => {
		mocks.listSessions.mockResolvedValue(
			page([liveSession({ canReadTranscript: false })]),
		);
		showPage(false);

		await screen.findByText("Live in meeting");
		expect(
			screen.queryByRole("heading", { name: "Live transcript" }),
		).toBeNull();
		expect(mocks.transcript).not.toHaveBeenCalled();
	});
});

describe("ParlumePage questions asked on the page", () => {
	it("lets a member ask Parlume a question that only the page answers", async () => {
		const user = userEvent.setup();
		mocks.history.mockResolvedValue({
			items: [
				request({
					id: "page-turn",
					sessionId: "live1",
					replyChannel: "PAGE",
					speakerName: "Member One",
					requestText: "What did we decide about the release?",
					responseText: "The release moves to Thursday.",
				}),
				request({ id: "voice-turn", sessionId: "live1" }),
			],
			total: 2,
			nextCursor: null,
		});
		showPage(true);

		const box = await screen.findByLabelText("Ask Parlume here");
		await user.type(box, "  Who owns the migration?  ");
		await user.click(screen.getByRole("button", { name: "Ask" }));

		expect(mocks.ask).toHaveBeenCalledWith({
			projectId: "example-project",
			sessionId: "live1",
			text: "Who owns the migration?",
		});
		expect(
			await screen.findByText("Asked. The answer appears below."),
		).toBeInTheDocument();
		expect(box).toHaveValue("");
		const asked = within(
			screen.getByRole("list", { name: "Questions asked on this page" }),
		);
		expect(asked.getAllByRole("listitem")).toHaveLength(1);
		expect(
			asked.getByText("The release moves to Thursday."),
		).toBeInTheDocument();
	});

	it("shows the server's reason when Parlume cannot take the question", async () => {
		const user = userEvent.setup();
		mocks.ask.mockRejectedValue(
			new Error("Parlume is still answering your last question."),
		);
		showPage(true);

		await user.type(
			await screen.findByLabelText("Ask Parlume here"),
			"And the budget?",
		);
		await user.click(screen.getByRole("button", { name: "Ask" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Parlume is still answering your last question.",
		);
	});

	it("gives a project viewer no composer", async () => {
		showPage(false);

		await screen.findByText("Live in meeting");
		expect(screen.queryByLabelText("Ask Parlume here")).toBeNull();
	});
});

describe("ParlumePage suggestion buttons", () => {
	it("has Parlume say a member's chosen suggestion in the meeting", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([liveSession({ suggestionsEnabled: true })]),
		);
		mocks.suggestions.mockResolvedValue({ items: [suggestion()] });
		showPage(true);

		const list = within(await suggestionsSection());
		await user.click(
			await list.findByRole("button", { name: "Say in meeting" }),
		);

		expect(mocks.saySuggestion).toHaveBeenCalledWith({
			projectId: "example-project",
			sessionId: "live1",
			suggestionId: "suggestion-1",
		});
		expect(
			await list.findByText("Parlume is saying it in the meeting."),
		).toBeInTheDocument();
	});

	it("dismisses a suggestion and reloads the list without it", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([liveSession({ suggestionsEnabled: true })]),
		);
		mocks.suggestions
			.mockResolvedValueOnce({ items: [suggestion()] })
			.mockResolvedValue({ items: [] });
		showPage(true);

		const list = within(await suggestionsSection());
		await user.click(await list.findByRole("button", { name: "Dismiss" }));

		expect(mocks.dismissSuggestion).toHaveBeenCalledWith({
			projectId: "example-project",
			sessionId: "live1",
			suggestionId: "suggestion-1",
		});
		expect(
			await list.findByText("No suggestions yet."),
		).toBeInTheDocument();
	});

	it("turns Say in meeting off while a guest is in the meeting", async () => {
		mocks.listSessions.mockResolvedValue(
			page([
				liveSession({ suggestionsEnabled: true, guestsPresent: true }),
			]),
		);
		mocks.suggestions.mockResolvedValue({ items: [suggestion()] });
		showPage(true);

		const list = within(await suggestionsSection());
		expect(
			await list.findByRole("button", { name: "Say in meeting" }),
		).toBeDisabled();
		expect(list.getByRole("button", { name: "Dismiss" })).toBeEnabled();
		expect(
			list.getByText(
				"A guest is in this meeting, so Parlume says nothing from this page.",
			),
		).toBeInTheDocument();
	});

	it("gives the recap and a project viewer no buttons", async () => {
		mocks.listSessions.mockResolvedValue(
			page([liveSession({ suggestionsEnabled: true })]),
		);
		mocks.suggestions.mockResolvedValue({
			items: [suggestion({ id: "recap", kind: "RECAP", chatTag: "P1" })],
		});
		showPage(true);

		const list = within(await suggestionsSection());
		await list.findByText("Recap");
		expect(
			list.queryByRole("button", { name: "Say in meeting" }),
		).toBeNull();

		cleanup();
		mocks.suggestions.mockResolvedValue({ items: [suggestion()] });
		showPage(false);
		const viewerList = within(await suggestionsSection());
		await viewerList.findByText("Suggestion");
		expect(
			viewerList.queryByRole("button", { name: "Dismiss" }),
		).toBeNull();
	});

	it("opens on the suggestion a Say it link in the meeting chat named", async () => {
		window.history.replaceState(null, "", "/parlume?suggestion=P2");
		mocks.listSessions.mockResolvedValue(
			page([liveSession({ suggestionsEnabled: true })]),
		);
		mocks.suggestions.mockResolvedValue({
			items: [
				suggestion({
					id: "other",
					chatTag: "P1",
					text: "Another one.",
				}),
				suggestion(),
			],
		});
		showPage(true);

		const list = within(await suggestionsSection());
		await list.findByText("Another one.");
		const items = list.getAllByRole("listitem");
		expect(items[1]).toHaveAttribute("aria-current", "true");
		expect(items[0]).not.toHaveAttribute("aria-current");
	});
});
