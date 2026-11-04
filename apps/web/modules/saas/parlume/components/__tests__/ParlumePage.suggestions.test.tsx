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
import { ParlumeSuggestionsList } from "../ParlumeSuggestionsList";
import {
	liveSession,
	PROJECT_BASE_PATH,
	SETTINGS_BASE_PATH,
	session,
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
	mocks.suggestions.mockResolvedValue({ items: [] });
});
afterEach(cleanup);

function showPage(canEdit = false) {
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

const suggestionsSection = async () =>
	(await screen.findByRole("heading", { name: "Suggestions" })).closest(
		"section",
	) as HTMLElement;

describe("ParlumePage suggestions", () => {
	// Readers see what Parlume offered, including what the meeting never saw.
	it("lists the live session's suggestions, missed questions and recap, with where each went", async () => {
		mocks.listSessions.mockResolvedValue(
			page([liveSession({ suggestionsEnabled: true })]),
		);
		mocks.suggestions.mockResolvedValue({
			items: [
				suggestion({
					id: "missed",
					kind: "MISSED_QUESTION",
					audience: "TEAM",
					text: "Who signs off the migration?",
					speaker: "Attendee Two",
					quote: "we move the data in March",
					topic: "Data migration",
					chatTag: null,
				}),
				suggestion({ id: "answer" }),
				suggestion({
					id: "recap",
					kind: "RECAP",
					text: "Since last time: the export shipped.",
					speaker: null,
					quote: null,
					topic: null,
					chatTag: "P1",
				}),
			],
		});
		showPage();

		const list = within(await suggestionsSection());
		expect(
			await list.findByText("Who signs off the migration?"),
		).toBeInTheDocument();
		const items = list.getAllByRole("listitem");
		expect(items).toHaveLength(3);
		expect(
			within(items[0]).getByText("Possibly missed question"),
		).toBeInTheDocument();
		expect(
			within(items[0]).getByText("Data migration"),
		).toBeInTheDocument();
		expect(
			within(items[0]).getByText(
				"Re Attendee Two: “we move the data in March”",
			),
		).toBeInTheDocument();
		expect(within(items[0]).getByText(/Team only/)).toBeInTheDocument();
		expect(within(items[1]).getByText("Suggestion")).toBeInTheDocument();
		expect(
			within(items[1]).getByText(/Sent to the chat as P2/),
		).toBeInTheDocument();
		expect(within(items[2]).getByText("Recap")).toBeInTheDocument();
		expect(within(items[2]).queryByText(/^Re /)).toBeNull();
		expect(mocks.suggestions).toHaveBeenCalledWith({
			projectId: "example-project",
			sessionId: "live1",
		});
		// A card of its own, titled like the cards beside it.
		expect(
			screen.getByRole("heading", { name: "Suggestions", level: 3 }),
		).toBeInTheDocument();
	});

	it("says a meeting suggestion the chat did not take was not posted", async () => {
		mocks.listSessions.mockResolvedValue(
			page([liveSession({ suggestionsEnabled: true })]),
		);
		mocks.suggestions.mockResolvedValue({
			items: [suggestion({ chatTag: null, audience: "MEETING" })],
		});
		showPage();

		const list = within(await suggestionsSection());
		expect(
			await list.findByText(/Not posted: the chat did not take it/),
		).toBeInTheDocument();
	});

	it("shows no suggestions list for a live session with suggestions off", async () => {
		mocks.listSessions.mockResolvedValue(
			page([liveSession({ suggestionsEnabled: false })]),
		);
		showPage();

		await screen.findByText("Live in meeting");
		expect(
			screen.queryByRole("heading", { name: "Suggestions" }),
		).toBeNull();
		expect(mocks.suggestions).not.toHaveBeenCalled();
	});

	it("opens a finished session to its suggestions when it has some", async () => {
		const user = userEvent.setup();
		mocks.listSessions.mockResolvedValue(
			page([
				session({
					id: "ended",
					agentLabel: "Assistant Ended",
					suggestionCount: 1,
				}),
			]),
		);
		mocks.suggestions.mockResolvedValue({ items: [suggestion()] });
		showPage();
		await screen.findByRole("table");

		await user.click(
			within(
				screen
					.getByText("Assistant Ended")
					.closest("tr") as HTMLElement,
			).getByRole("button"),
		);

		const list = within(await suggestionsSection());
		expect(
			await list.findByText("EX-12 already covers the export."),
		).toBeInTheDocument();
		expect(mocks.suggestions).toHaveBeenCalledWith({
			projectId: "example-project",
			sessionId: "ended",
		});
		// A labelled block like the session's other details.
		expect(
			screen.getByRole("heading", { name: "Suggestions", level: 4 }),
		).toBeInTheDocument();
	});
});

describe("ParlumeSuggestionsList refresh", () => {
	// A failed poll keeps its data in React Query; it must not hide the list.
	it("keeps the suggestions it has when a later refresh fails, and says so", async () => {
		mocks.suggestions
			.mockResolvedValueOnce({ items: [suggestion()] })
			.mockRejectedValue(new Error("offline"));
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: 0 } },
		});
		render(
			<QueryClientProvider client={client}>
				<ParlumeSuggestionsList
					projectId="example-project"
					sessionId="live1"
					refetchInterval={20}
					variant="card"
				/>
			</QueryClientProvider>,
		);

		expect(
			await screen.findByText(/Couldn't refresh suggestions/),
		).toBeInTheDocument();
		expect(
			screen.getByText("EX-12 already covers the export."),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Suggestions could not be loaded."),
		).toBeNull();
	});

	it("says the suggestions could not be loaded when it has none", async () => {
		mocks.suggestions.mockRejectedValue(new Error("offline"));
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, gcTime: 0 } },
		});
		render(
			<QueryClientProvider client={client}>
				<ParlumeSuggestionsList
					projectId="example-project"
					sessionId="live1"
					refetchInterval={false}
					variant="details"
				/>
			</QueryClientProvider>,
		);

		expect(
			await screen.findByText("Suggestions could not be loaded."),
		).toBeInTheDocument();
	});
});
