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
import { formatClock } from "../../lib/parlume-format";
import { ParlumePage } from "../ParlumePage";
import { action, PROJECT_BASE_PATH, request, session } from "./fixtures";

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

function historyPage(
	items: ReturnType<typeof request>[],
	extra: { total?: number | null; nextCursor?: unknown } = {},
) {
	return {
		items,
		total: extra.total === undefined ? items.length : extra.total,
		nextCursor: extra.nextCursor ?? null,
	};
}

beforeAll(() => {
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.setPointerCapture ??= () => undefined;
	Element.prototype.releasePointerCapture ??= () => undefined;
});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.listAgents.mockResolvedValue({ agents: [], operatorReady: true });
	mocks.listSessions.mockResolvedValue({
		sessions: [session({ id: "s1" }), session({ id: "s2" })],
		total: 2,
		nextCursor: null,
	});
	mocks.history.mockResolvedValue(historyPage([]));
	mocks.usage.mockResolvedValue({
		totalCostMicroUsd: 0,
		calls: 0,
		sessions: [],
	});
});
afterEach(cleanup);

function showPage() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	render(
		<QueryClientProvider client={client}>
			<ParlumePage
				projectId="example-project"
				projectBasePath={PROJECT_BASE_PATH}
				canEdit
			/>
		</QueryClientProvider>,
	);
}

async function openRequests() {
	const user = userEvent.setup();
	showPage();
	await user.click(await screen.findByRole("tab", { name: /Requests/ }));
	return user;
}

const question = (id: string, text: string) =>
	request({ id, requestText: text, responseText: `Answer to ${text}` });
const actionRequest = (id: string, text: string) =>
	request({
		id,
		requestText: text,
		responseText: `Answer to ${text}`,
		actions: [action({ id: `${id}-action` })],
	});

describe("ParlumePage panel tabs", () => {
	it("counts the project's sessions and requests on the tabs", async () => {
		mocks.listSessions.mockResolvedValue({
			sessions: [session({ id: "s1" })],
			total: 12,
			nextCursor: null,
		});
		mocks.history.mockResolvedValue(
			historyPage([question("t1", "One")], { total: 42 }),
		);
		showPage();

		expect(
			await screen.findByRole("tab", { name: "Sessions 12" }),
		).toHaveAttribute("aria-selected", "true");
		expect(
			await screen.findByRole("tab", { name: "Requests 42" }),
		).toHaveAttribute("aria-selected", "false");
	});

	it("keeps the request count while another session's requests load", async () => {
		mocks.history
			.mockResolvedValueOnce(
				historyPage([question("t1", "One")], { total: 42 }),
			)
			.mockReturnValueOnce(new Promise(() => undefined));
		const user = await openRequests();
		await screen.findByRole("tab", { name: "Requests 42" });

		await user.click(screen.getByRole("combobox", { name: "Session" }));
		const options = await screen.findAllByRole("option");
		await user.click(options[1]);
		await waitFor(() => expect(mocks.history).toHaveBeenCalledTimes(2));

		expect(
			screen.getByRole("tab", { name: "Requests 42" }),
		).toBeInTheDocument();
	});

	it("moves between the tabs with the arrow keys", async () => {
		const user = userEvent.setup();
		showPage();
		const sessionsTab = await screen.findByRole("tab", {
			name: /Sessions/,
		});
		sessionsTab.focus();

		await user.keyboard("{ArrowRight}");
		expect(screen.getByRole("tab", { name: /Requests/ })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(screen.getByRole("tabpanel")).toHaveAccessibleName(/Requests/);

		await user.keyboard("{ArrowLeft}");
		expect(sessionsTab).toHaveAttribute("aria-selected", "true");
	});

	it("refreshes sessions, spend and requests together", async () => {
		const user = userEvent.setup();
		showPage();
		await screen.findByRole("tab", { name: /Sessions/ });
		await waitFor(() => expect(mocks.usage).toHaveBeenCalledTimes(1));

		await user.click(
			screen.getByRole("button", {
				name: "Refresh sessions and requests",
			}),
		);

		await waitFor(() => {
			expect(mocks.listSessions).toHaveBeenCalledTimes(2);
			expect(mocks.usage).toHaveBeenCalledTimes(2);
			expect(mocks.history).toHaveBeenCalledTimes(2);
		});
	});
});

describe("ParlumePage requests", () => {
	it("lists each request with who asked, when, in which mode, and the answer", async () => {
		mocks.history.mockResolvedValue(
			historyPage([
				request({
					id: "t1",
					requestText: "What is the status?",
					responseText: "On track.",
					session: {
						agentLabel: "Fabric Agent",
						toolsReadOnly: false,
					},
				}),
			]),
		);
		await openRequests();

		const item = (await screen.findByText("What is the status?")).closest(
			"li",
		) as HTMLElement;
		expect(within(item).getByText("Attendee One")).toBeInTheDocument();
		expect(within(item).getByText("AO")).toBeInTheDocument();
		expect(
			within(item).getByText(/Actions with confirmation/),
		).toBeInTheDocument();
		expect(within(item).getByText("On track.")).toBeInTheDocument();
		expect(within(item).queryByText("Exact action details")).toBeNull();
	});

	it("says which requests are still running or failed", async () => {
		mocks.history.mockResolvedValue(
			historyPage([
				request({
					id: "t1",
					requestText: "Broken one",
					responseText: null,
					status: "FAILED",
					error: "The agent could not answer.",
				}),
			]),
		);
		await openRequests();

		const item = (await screen.findByText("Broken one")).closest(
			"li",
		) as HTMLElement;
		expect(within(item).getByText(/· failed/)).toBeInTheDocument();
		expect(
			within(item).getByText("The agent could not answer."),
		).toHaveClass("text-destructive");
	});

	it("filters to questions or to actions without reloading", async () => {
		mocks.history.mockResolvedValue(
			historyPage([
				question("t1", "Plain question"),
				actionRequest("t2", "Do the thing"),
			]),
		);
		const user = await openRequests();
		await screen.findByText("Plain question");
		const all = screen.getByRole("button", { name: "All" });
		const questions = screen.getByRole("button", { name: "Questions" });
		const actions = screen.getByRole("button", { name: "Actions" });
		expect(all).toHaveAttribute("aria-pressed", "true");

		await user.click(questions);
		expect(questions).toHaveAttribute("aria-pressed", "true");
		expect(screen.getByText("Plain question")).toBeInTheDocument();
		expect(screen.queryByText("Do the thing")).toBeNull();

		await user.click(actions);
		expect(screen.queryByText("Plain question")).toBeNull();
		expect(screen.getByText("Do the thing")).toBeInTheDocument();

		await user.click(all);
		expect(screen.getByText("Plain question")).toBeInTheDocument();
		expect(screen.getByText("Do the thing")).toBeInTheDocument();
		expect(mocks.history).toHaveBeenCalledTimes(1);
	});

	it("says nothing matches when a filter leaves no requests", async () => {
		mocks.history.mockResolvedValue(
			historyPage([question("t1", "Plain question")]),
		);
		const user = await openRequests();
		await screen.findByText("Plain question");

		await user.click(screen.getByRole("button", { name: "Actions" }));

		expect(
			screen.getByText("No requests match this filter."),
		).toBeInTheDocument();
	});

	it("flags an unidentified speaker only where actions are blocked for it", async () => {
		mocks.history.mockResolvedValue(
			historyPage([
				request({
					id: "blocked",
					requestText: "Unknown asks in actions mode",
					speakerId: null,
					speakerName: null,
					session: {
						agentLabel: "Fabric Agent",
						toolsReadOnly: false,
					},
				}),
				request({
					id: "readonly",
					requestText: "Unknown asks in read-only mode",
					speakerId: null,
					speakerName: null,
				}),
				request({
					id: "known",
					requestText: "Known asks in actions mode",
					session: {
						agentLabel: "Fabric Agent",
						toolsReadOnly: false,
					},
				}),
			]),
		);
		await openRequests();
		const itemOf = async (text: string) =>
			(await screen.findByText(text)).closest("li") as HTMLElement;
		const badge = "Speaker not identified · actions blocked";

		const blocked = within(await itemOf("Unknown asks in actions mode"));
		expect(blocked.getByText(badge)).toBeInTheDocument();
		expect(blocked.getByText("Unidentified attendee")).toBeInTheDocument();
		expect(blocked.getByText("?")).toBeInTheDocument();
		expect(
			within(await itemOf("Unknown asks in read-only mode")).queryByText(
				badge,
			),
		).toBeNull();
		expect(
			within(await itemOf("Known asks in actions mode")).queryByText(
				badge,
			),
		).toBeNull();
	});

	it("shows an action's status, steps, outcome and exact arguments", async () => {
		mocks.history.mockResolvedValue(
			historyPage([actionRequest("t1", "Move EX-1")]),
		);
		const user = await openRequests();

		const block = (
			await screen.findByText("Move EX-1 to Sprint 2.")
		).closest("div[class*=rounded]") as HTMLElement;
		const view = within(block);
		expect(view.getByText("Completed")).toBeInTheDocument();
		const steps = view
			.getAllByRole("listitem")
			.map((step) => step.textContent);
		expect(steps).toEqual([
			expect.stringMatching(
				new RegExp(
					`^Requested\\s+${formatClock("2026-09-30T10:05:00Z")}`,
				),
			),
			expect.stringMatching(/^Confirmed\s/),
			expect.stringMatching(/^Finished\s/),
		]);
		expect(view.getByText("Moved EX-1.")).toBeInTheDocument();

		const details = view.getByText("Exact action details");
		expect(view.queryByText(/"itemKey"/)).not.toBeVisible();
		await user.click(details);
		expect(view.getByText(/"itemKey": "EX-1"/)).toBeVisible();
	});

	it("reads a proposal nobody confirmed in time as expired", async () => {
		mocks.history.mockResolvedValue(
			historyPage([
				request({
					id: "t1",
					requestText: "Move EX-1",
					actions: [
						action({
							status: "AWAITING_CONFIRMATION",
							confirmedAt: null,
							completedAt: null,
							outcome: null,
							expiresAt: new Date("2026-09-30T10:07:00Z"),
						}),
					],
				}),
			]),
		);
		await openRequests();

		const block = (
			await screen.findByText("Move EX-1 to Sprint 2.")
		).closest("div[class*=rounded]") as HTMLElement;
		const view = within(block);
		expect(view.getAllByText("Expired")[0]).toBeInTheDocument();
		expect(
			view
				.getAllByRole("listitem")
				.map((step) => step.textContent?.split(" ")[0]),
		).toEqual(["Requested", "Expired"]);
	});

	it("marks a failed action", async () => {
		mocks.history.mockResolvedValue(
			historyPage([
				request({
					id: "t1",
					requestText: "Move EX-1",
					actions: [
						action({
							status: "FAILED",
							outcome: "The move failed.",
						}),
					],
				}),
			]),
		);
		await openRequests();

		const block = (
			await screen.findByText("Move EX-1 to Sprint 2.")
		).closest("div[class*=rounded]") as HTMLElement;
		const view = within(block);
		expect(
			view.getByText("Failed", { selector: "span[class*=border]" }),
		).toBeInTheDocument();
		expect(view.getByText("The move failed.")).toBeInTheDocument();
	});

	it("loads the session filter's options from the loaded sessions and asks for that session", async () => {
		const user = await openRequests();

		await user.click(screen.getByRole("combobox", { name: "Session" }));
		const options = await screen.findAllByRole("option");
		expect(
			options.map((option) => option.textContent?.split(" · ")[0]),
		).toEqual(["All sessions", expect.any(String), expect.any(String)]);
		await user.click(options[2]);

		await waitFor(() =>
			expect(mocks.history).toHaveBeenLastCalledWith({
				projectId: "example-project",
				sessionId: "s2",
				before: undefined,
			}),
		);
	});

	it("pages older requests in on request", async () => {
		const cursor = {
			id: "t1",
			createdAt: new Date("2026-09-30T10:00:00Z"),
		};
		mocks.history
			.mockResolvedValueOnce(
				historyPage([question("t1", "Newest")], { nextCursor: cursor }),
			)
			.mockResolvedValueOnce(
				historyPage([question("t0", "Older")], { total: null }),
			);
		const user = await openRequests();
		await screen.findByText("Newest");

		await user.click(
			screen.getByRole("button", { name: "Load older requests" }),
		);

		expect(await screen.findByText("Older")).toBeInTheDocument();
		expect(screen.getByText("Newest")).toBeInTheDocument();
		expect(mocks.history).toHaveBeenLastCalledWith({
			projectId: "example-project",
			sessionId: undefined,
			before: cursor,
		});
		expect(
			screen.queryByRole("button", { name: "Load older requests" }),
		).toBeNull();
	});

	it("says when nothing has been asked yet", async () => {
		await openRequests();
		expect(
			await screen.findByText("No Parlume requests yet."),
		).toBeInTheDocument();
	});

	it("says when the requests cannot be loaded", async () => {
		mocks.history.mockRejectedValue(new Error("offline"));
		await openRequests();
		expect(
			await screen.findByText(
				"Could not load Parlume requests. Try refreshing.",
			),
		).toHaveAttribute("role", "alert");
	});
});
