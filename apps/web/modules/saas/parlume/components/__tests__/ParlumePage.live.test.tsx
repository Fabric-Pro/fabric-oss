import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatShortDate } from "../../lib/parlume-format";
import { ParlumePage } from "../ParlumePage";
import {
	liveSession,
	PROJECT_BASE_PATH,
	request,
	SETTINGS_BASE_PATH,
	session,
} from "./fixtures";

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

function sessionsPage(
	sessions: ReturnType<typeof session>[],
	total = sessions.length,
) {
	return { sessions, total, nextCursor: null };
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.listAgents.mockResolvedValue({ agents: [], operatorReady: true });
	mocks.listSessions.mockResolvedValue(sessionsPage([]));
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

const step = (name: string) =>
	screen.getByText(name).closest("li") as HTMLElement;

describe("ParlumePage while the bot is joining", () => {
	it("says the invite is going out, and replaces the invite form", async () => {
		mocks.listSessions.mockResolvedValue(
			sessionsPage([
				liveSession({
					id: "joining1",
					status: "PENDING",
					joinedAt: null,
				}),
			]),
		);
		showPage();

		expect(
			await screen.findByRole("heading", { name: "Sending the invite…" }),
		).toBeInTheDocument();
		expect(step("Invite sent")).toHaveAttribute("aria-current", "step");
		expect(step("Waiting in lobby")).not.toHaveAttribute("aria-current");
		expect(step("Listening")).not.toHaveAttribute("aria-current");
		expect(screen.queryByLabelText("Teams meeting link")).toBeNull();
		expect(screen.queryByText("Live in meeting")).toBeNull();
	});

	it("waits in the lobby once the invite is out, with the organizer's instruction", async () => {
		mocks.listSessions.mockResolvedValue(
			sessionsPage([
				liveSession({
					id: "joining1",
					status: "JOINING",
					joinedAt: null,
				}),
			]),
		);
		showPage();

		expect(
			await screen.findByRole("heading", {
				name: "Waiting in the lobby…",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByText(/Ask the organizer to admit “Fabric Parlume”/),
		).toBeInTheDocument();
		expect(step("Invite sent")).not.toHaveAttribute("aria-current");
		expect(step("Waiting in lobby")).toHaveAttribute(
			"aria-current",
			"step",
		);
		expect(step("Listening")).not.toHaveAttribute("aria-current");
	});

	it("cancels through the stop request", async () => {
		mocks.listSessions.mockResolvedValue(
			sessionsPage([
				liveSession({
					id: "joining1",
					status: "JOINING",
					joinedAt: null,
				}),
			]),
		);
		showPage();
		fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
		await waitFor(() =>
			expect(mocks.stop).toHaveBeenCalledWith({
				projectId: "example-project",
				sessionId: "joining1",
			}),
		);
	});

	it("shows the progress but no Cancel to a reader who cannot stop it", async () => {
		mocks.listSessions.mockResolvedValue(
			sessionsPage([
				liveSession({
					id: "joining1",
					status: "JOINING",
					joinedAt: null,
				}),
			]),
		);
		showPage(false);
		await screen.findByRole("heading", { name: "Waiting in the lobby…" });
		expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
	});

	it("reports a cancel that is under way and one that failed", async () => {
		mocks.listSessions.mockResolvedValue(
			sessionsPage([
				liveSession({
					id: "joining1",
					status: "LEAVING",
					joinedAt: null,
				}),
			]),
		);
		showPage();
		expect(
			await screen.findByRole("heading", {
				name: "Leaving the meeting…",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "Cancelling…" }),
		).toBeDisabled();
		cleanup();

		mocks.listSessions.mockResolvedValue(
			sessionsPage([
				liveSession({
					id: "joining1",
					status: "STOP_FAILED",
					joinedAt: null,
				}),
			]),
		);
		showPage();
		expect(
			await screen.findByText(/could not confirm it left the meeting/),
		).toHaveAttribute("role", "alert");
		expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
	});
});

describe("ParlumePage live session", () => {
	beforeEach(() => {
		mocks.listSessions.mockResolvedValue(sessionsPage([liveSession()]));
	});

	it("shows the live card, hides the invite form, and removes the bot only after a confirmation", async () => {
		showPage();
		await screen.findByRole("heading", { name: "Live in meeting" });
		expect(screen.queryByLabelText("Teams meeting link")).toBeNull();
		expect(screen.getByRole("timer")).toHaveTextContent(/^0[45]:\d{2}$/);

		fireEvent.click(
			screen.getByRole("button", { name: "Remove from meeting" }),
		);
		expect(mocks.stop).not.toHaveBeenCalled();
		const confirm = screen.getByRole("group", { name: "Confirm removal" });
		expect(confirm).toHaveTextContent(
			"Parlume will leave the meeting and save the transcript to project Context.",
		);

		fireEvent.click(
			within(confirm).getByRole("button", { name: "Keep in meeting" }),
		);
		expect(
			screen.queryByRole("group", { name: "Confirm removal" }),
		).toBeNull();
		expect(mocks.stop).not.toHaveBeenCalled();

		fireEvent.click(
			screen.getByRole("button", { name: "Remove from meeting" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Remove now" }));
		await waitFor(() =>
			expect(mocks.stop).toHaveBeenCalledWith({
				projectId: "example-project",
				sessionId: "live1",
			}),
		);
	});

	it("omits Remove for non-editors", async () => {
		showPage(false);
		await screen.findByRole("heading", { name: "Live in meeting" });
		expect(
			screen.queryByRole("button", { name: "Remove from meeting" }),
		).toBeNull();
	});

	it("alerts when removing fails", async () => {
		mocks.stop.mockRejectedValue(new Error("nope"));
		showPage();
		fireEvent.click(
			await screen.findByRole("button", { name: "Remove from meeting" }),
		);
		fireEvent.click(screen.getByRole("button", { name: "Remove now" }));
		expect(
			await screen.findByText(/could not leave the meeting/),
		).toHaveAttribute("role", "alert");
	});

	it("lists the agent, mode and spend so far, and the latest requests of this session", async () => {
		mocks.listSessions.mockResolvedValue(
			sessionsPage([liveSession({ toolsReadOnly: false })]),
		);
		mocks.usage.mockResolvedValue({
			totalCostMicroUsd: 91_200,
			calls: 3,
			sessions: [{ sessionId: "live1", costMicroUsd: 91_200, calls: 3 }],
		});
		mocks.history.mockResolvedValue({
			items: [1, 2, 3, 4].map((n) =>
				request({
					id: `t${n}`,
					sessionId: "live1",
					requestText: `Live question ${n}`,
					responseText: `Live answer ${n}`,
				}),
			),
			total: 4,
			nextCursor: null,
		});
		showPage();

		const live = (
			await screen.findByRole("heading", { name: "Live in meeting" })
		).closest("div[class*=rounded]") as HTMLElement;
		const definitions = within(live);
		expect(
			definitions.getByText("Agent").nextElementSibling,
		).toHaveTextContent("Fabric Agent — this project");
		expect(
			definitions.getByText("Mode").nextElementSibling,
		).toHaveTextContent(/^Actions$/);
		await waitFor(() =>
			expect(
				definitions.getByText("Spend so far").nextElementSibling,
			).toHaveTextContent("$0.09"),
		);
		expect(
			definitions.getByText("Listening for “Hey Fabric”"),
		).toBeInTheDocument();
		await within(live).findByText("Live question 1");
		expect(within(live).getByText("Live question 3")).toBeInTheDocument();
		expect(within(live).queryByText("Live question 4")).toBeNull();
		expect(mocks.history).toHaveBeenCalledWith({
			projectId: "example-project",
			sessionId: "live1",
		});
	});

	it("invites any attendee to ask while nothing has been asked yet", async () => {
		showPage();
		expect(
			await screen.findByText(
				"No requests yet. Any attendee can say “Hey Fabric” to ask a question.",
			),
		).toBeInTheDocument();
	});

	it("asks the server for the session's state again every 10 seconds", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			showPage();
			await screen.findByRole("heading", { name: "Live in meeting" });
			expect(mocks.listSessions).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(10_000);

			await waitFor(() =>
				expect(mocks.listSessions).toHaveBeenCalledTimes(2),
			);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("ParlumePage spend", () => {
	it("totals the project's spend in cents, without a call count", async () => {
		mocks.usage.mockResolvedValue({
			totalCostMicroUsd: 1_234_567_890,
			calls: 37,
			sessions: [],
		});
		showPage();
		expect(await screen.findByText("$1,234.57")).toBeInTheDocument();
		expect(screen.queryByText(/calls?\b/)).toBeNull();
		expect(
			screen.getByText(
				"Covers agent turns, realtime voice, speech, live transcription, meeting notes and meeting-provider bot time. A live meeting's bot and transcription time are added when it ends.",
			),
		).toBeInTheDocument();
	});

	it("counts the project's sessions, not only the ones on screen", async () => {
		mocks.listSessions.mockResolvedValue({
			sessions: [session({ id: "a" })],
			total: 12,
			nextCursor: null,
		});
		showPage();
		const spend = (await screen.findByText("This project")).closest(
			"div[class*=rounded]",
		) as HTMLElement;
		expect(
			await within(spend).findByText("12 sessions"),
		).toBeInTheDocument();
	});

	it("ranks the three costliest loaded sessions, each with a proportional bar", async () => {
		const costs: Record<string, number> = {
			a: 2_000_000,
			b: 500_000,
			c: 1_000_000,
			d: 250_000,
			unloaded: 9_000_000,
		};
		mocks.listSessions.mockResolvedValue(
			sessionsPage(
				["a", "b", "c", "d"].map((id, index) =>
					session({
						id,
						agentLabel: `Assistant ${id.toUpperCase()}`,
						createdAt: new Date(`2026-09-0${index + 1}T10:00:00Z`),
					}),
				),
			),
		);
		mocks.usage.mockResolvedValue({
			totalCostMicroUsd: 12_750_000,
			calls: 20,
			sessions: Object.entries(costs).map(
				([sessionId, costMicroUsd]) => ({
					sessionId,
					costMicroUsd,
					calls: 1,
				}),
			),
		});
		showPage();

		const list = await screen.findByRole("list", {
			name: "Costliest sessions",
		});
		const rows = within(list).getAllByRole("listitem");
		expect(rows).toHaveLength(3);
		const label = (id: string, index: number) =>
			`${formatShortDate(new Date(`2026-09-0${index + 1}T10:00:00Z`))} · Assistant ${id.toUpperCase()}`;
		expect(rows[0]).toHaveTextContent(label("a", 0));
		expect(rows[0]).toHaveTextContent("$2.00");
		expect(rows[1]).toHaveTextContent(label("c", 2));
		expect(rows[1]).toHaveTextContent("$1.00");
		expect(rows[2]).toHaveTextContent(label("b", 1));
		expect(rows[2]).toHaveTextContent("$0.50");
		expect(within(list).queryByText(/Assistant D/)).toBeNull();
		expect(list).not.toHaveTextContent("$9.00");

		const bars = within(list).getAllByRole("progressbar", { hidden: true });
		expect(
			bars.map(
				(bar) => (bar.firstElementChild as HTMLElement).style.transform,
			),
		).toEqual(["translateX(-0%)", "translateX(-50%)", "translateX(-75%)"]);
	});

	it("floors a session under one cent instead of showing $0.00", async () => {
		mocks.listSessions.mockResolvedValue(
			sessionsPage([session({ id: "a" })]),
		);
		mocks.usage.mockResolvedValue({
			totalCostMicroUsd: 4_000,
			calls: 1,
			sessions: [{ sessionId: "a", costMicroUsd: 4_000, calls: 1 }],
		});
		showPage();
		const list = await screen.findByRole("list", {
			name: "Costliest sessions",
		});
		expect(within(list).getByText("< $0.01")).toBeInTheDocument();
	});
});
