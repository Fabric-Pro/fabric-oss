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
import { liveSession, PROJECT_BASE_PATH, session } from "./fixtures";

const mocks = vi.hoisted(() => ({
	listAgents: vi.fn(),
	listSessions: vi.fn(),
	start: vi.fn(),
	stop: vi.fn(),
	history: vi.fn(),
	usage: vi.fn(),
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
				canEdit={canEdit}
			/>
		</QueryClientProvider>,
	);
}

const sessionsTable = async () => screen.findByRole("table");
const rowOf = (text: RegExp | string) =>
	screen.getByText(text).closest("tr") as HTMLElement;

describe("ParlumePage sessions table", () => {
	it.each([
		["STOPPED", "Stopped by admin"],
		["REMOVED", "Removed from meeting"],
		["IDLE", "Ended after 3 min of silence"],
		["ACCESS_REVOKED", "Inviter lost access"],
		["STREAM_ERROR", "Transcription failed"],
		["MAX_DURATION", "Reached 4-hour limit"],
		["PROVIDER_FAILED", "Provider failed"],
		["START_FAILED", "Never joined"],
	])("labels end reason %s as the outcome", async (endReason, label) => {
		mocks.listSessions.mockResolvedValue(
			page([session({ endReason: endReason as "STOPPED" })]),
		);
		showPage();
		expect(await screen.findByText(label)).toBeInTheDocument();
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
		expect(
			first.getByText("Actions with confirmation"),
		).toBeInTheDocument();
		expect(first.getByText("30 min")).toBeInTheDocument();
		expect(first.getByText("Stopped by admin")).toBeInTheDocument();
		expect(await first.findByText("$0.01")).toBeInTheDocument();
		const second = within(rowOf("Assistant B"));
		expect(second.getByText("Read-only")).toBeInTheDocument();
		expect(second.getByText("Failed")).toBeInTheDocument();
		expect(second.getByText("—", { selector: "td" })).toBeInTheDocument();
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
