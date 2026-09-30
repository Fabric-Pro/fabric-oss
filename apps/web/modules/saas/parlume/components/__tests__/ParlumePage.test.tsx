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
import { ParlumePage } from "../ParlumePage";

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

const meetingUrl = "https://teams.microsoft.com/l/meetup-join/example";

function session(overrides: Record<string, unknown> = {}) {
	return {
		id: "s1",
		agentKind: "FABRIC_AGENT",
		agentLabel: "Fabric Agent — this project",
		status: "ENDED",
		toolsReadOnly: true,
		endReason: null,
		lastError: null,
		joinedAt: new Date("2026-09-30T10:00:00Z"),
		hardStopAt: null,
		leaveRequestedAt: null,
		endedAt: new Date("2026-09-30T10:30:00Z"),
		transcriptContextId: null,
		createdAt: new Date("2026-09-30T09:59:00Z"),
		updatedAt: new Date("2026-09-30T10:30:00Z"),
		notes: null,
		notesStatus: null,
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.listAgents.mockResolvedValue({
		agents: [
			{
				kind: "FABRIC_AGENT",
				label: "Fabric Agent — this project",
				agentInstanceSId: null,
				version: null,
			},
		],
		operatorReady: true,
	});
	mocks.listSessions.mockResolvedValue({ sessions: [] });
	mocks.history.mockResolvedValue({ items: [], nextCursor: null });
	mocks.usage.mockResolvedValue({
		totalCostMicroUsd: 0,
		calls: 0,
		sessions: [],
	});
	mocks.start.mockResolvedValue({});
	mocks.stop.mockResolvedValue({});
});
afterEach(cleanup);

function showPage(canEdit = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	render(
		<QueryClientProvider client={client}>
			<ParlumePage projectId="example-project" canEdit={canEdit} />
		</QueryClientProvider>,
	);
}

describe("ParlumePage invitation", () => {
	it("invites with read-only tools by default and trims the link", async () => {
		showPage();
		await screen.findByRole("option", {
			name: "Fabric Agent — this project",
		});
		fireEvent.change(screen.getByLabelText("Teams meeting link"), {
			target: { value: `  ${meetingUrl}  ` },
		});
		fireEvent.click(screen.getByRole("button", { name: "Invite Parlume" }));
		await waitFor(() =>
			expect(mocks.start).toHaveBeenCalledWith({
				projectId: "example-project",
				agentKind: "FABRIC_AGENT",
				meetingUrl,
				toolsReadOnly: true,
			}),
		);
	});

	it("explains action mode when read-only is switched off", async () => {
		showPage();
		await screen.findByRole("option", {
			name: "Fabric Agent — this project",
		});
		fireEvent.click(screen.getByRole("switch", { name: "Read-only" }));
		expect(
			screen.getByText(/waits for that requester to confirm/),
		).toBeInTheDocument();
	});

	it("shows an alert and disables invitations when the operator is not ready", async () => {
		mocks.listAgents.mockResolvedValue({
			agents: [
				{
					kind: "FABRIC_AGENT",
					label: "Fabric Agent — this project",
					agentInstanceSId: null,
					version: null,
				},
			],
			operatorReady: false,
		});
		showPage();
		expect(
			await screen.findByText(/not configured for invitations/),
		).toHaveAttribute("role", "alert");
		fireEvent.change(screen.getByLabelText("Teams meeting link"), {
			target: { value: meetingUrl },
		});
		expect(
			screen.getByRole("button", { name: "Invite Parlume" }),
		).toBeDisabled();
	});

	it("reports a failed invitation", async () => {
		mocks.start.mockRejectedValue(new Error("bad link"));
		showPage();
		await screen.findByRole("option", {
			name: "Fabric Agent — this project",
		});
		fireEvent.change(screen.getByLabelText("Teams meeting link"), {
			target: { value: meetingUrl },
		});
		fireEvent.click(screen.getByRole("button", { name: "Invite Parlume" }));
		expect(
			await screen.findByText(/could not join this meeting/),
		).toHaveAttribute("role", "alert");
	});

	it("hides the invite form from non-editors", async () => {
		showPage(false);
		expect(
			await screen.findByText(/Only project administrators/),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Invite Parlume" }),
		).not.toBeInTheDocument();
		expect(mocks.listAgents).not.toHaveBeenCalled();
	});
});

describe("ParlumePage live session", () => {
	beforeEach(() => {
		mocks.listSessions.mockResolvedValue({
			sessions: [
				session({
					id: "live1",
					status: "ACTIVE",
					endedAt: null,
					joinedAt: new Date(Date.now() - 5 * 60_000),
				}),
			],
		});
	});

	it("shows the live card, blocks a second invitation and stops the session", async () => {
		showPage();
		const card = (await screen.findByText("Live session")).closest("div");
		expect(card).not.toBeNull();
		fireEvent.change(screen.getByLabelText("Teams meeting link"), {
			target: { value: meetingUrl },
		});
		expect(
			screen.getByRole("button", { name: "Invite Parlume" }),
		).toBeDisabled();
		fireEvent.click(screen.getByRole("button", { name: "Stop" }));
		await waitFor(() =>
			expect(mocks.stop).toHaveBeenCalledWith({
				projectId: "example-project",
				sessionId: "live1",
			}),
		);
	});

	it("omits Stop for non-editors", async () => {
		showPage(false);
		await screen.findByText("Live session");
		expect(
			screen.queryByRole("button", { name: "Stop" }),
		).not.toBeInTheDocument();
	});

	it("alerts when stopping fails", async () => {
		mocks.stop.mockRejectedValue(new Error("nope"));
		showPage();
		fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
		expect(
			await screen.findByText(/could not leave the meeting/),
		).toHaveAttribute("role", "alert");
	});
});

describe("ParlumePage sessions and usage", () => {
	it.each([
		["STOPPED", "Stopped by admin"],
		["REMOVED", "Removed from meeting"],
		["IDLE", "Ended after 3 min of silence"],
		["ACCESS_REVOKED", "Inviter lost access"],
		["STREAM_ERROR", "Transcription failed"],
		["MAX_DURATION", "Reached 4-hour limit"],
		["PROVIDER_FAILED", "Provider failed"],
		["START_FAILED", "Never joined"],
	])("labels end reason %s", async (endReason, label) => {
		mocks.listSessions.mockResolvedValue({
			sessions: [session({ endReason })],
		});
		showPage();
		expect(await screen.findByText(label)).toBeInTheDocument();
	});

	it("shows per-session cost, the project total, and a dash when cost is absent", async () => {
		mocks.listSessions.mockResolvedValue({
			sessions: [
				session({
					id: "a",
					lastError: "Bot crashed",
					transcriptContextId: "ctx1",
					notes: "Decided to ship.",
				}),
				session({ id: "b", agentLabel: "Example assistant" }),
			],
		});
		mocks.usage.mockResolvedValue({
			totalCostMicroUsd: 12_300,
			calls: 4,
			sessions: [{ sessionId: "a", costMicroUsd: 12_300, calls: 4 }],
		});
		showPage();
		const sessionsCard = (await screen.findByText("Sessions")).closest(
			"div[class*=rounded]",
		) as HTMLElement;
		const items = await within(sessionsCard).findAllByRole("listitem");
		expect(
			within(items[0]).getByText(/Cost \$0\.0123/),
		).toBeInTheDocument();
		expect(within(items[0]).getByText("Bot crashed")).toBeInTheDocument();
		expect(within(items[0]).getByText("Meeting notes")).toBeInTheDocument();
		expect(
			within(items[0]).getByText(/Transcript saved in project Context/),
		).toBeInTheDocument();
		expect(within(items[1]).getByText(/Cost —/)).toBeInTheDocument();
		expect(await screen.findByText("$0.0123")).toBeInTheDocument();
		expect(screen.getByText(/4 calls in this project/)).toBeInTheDocument();
	});
});

describe("ParlumePage requests", () => {
	it("filters history by session", async () => {
		mocks.listSessions.mockResolvedValue({
			sessions: [session({ id: "s1" }), session({ id: "s2" })],
		});
		mocks.history.mockResolvedValue({
			items: [
				{
					id: "t1",
					speakerName: "Ada",
					createdAt: new Date("2026-09-30T10:05:00Z"),
					requestText: "What is the status?",
					responseText: "On track.",
					error: null,
					status: "COMPLETED",
					session: {
						agentLabel: "Fabric Agent — this project",
						toolsReadOnly: true,
					},
					actions: [],
				},
			],
			nextCursor: null,
		});
		showPage();
		expect(
			await screen.findByText("What is the status?"),
		).toBeInTheDocument();
		expect(mocks.history).toHaveBeenLastCalledWith({
			projectId: "example-project",
			sessionId: undefined,
			before: undefined,
		});
		const select = screen.getByLabelText("Session");
		await waitFor(() =>
			expect(
				within(select).getAllByRole("option").length,
			).toBeGreaterThan(2),
		);
		fireEvent.change(select, { target: { value: "s2" } });
		await waitFor(() =>
			expect(mocks.history).toHaveBeenLastCalledWith({
				projectId: "example-project",
				sessionId: "s2",
				before: undefined,
			}),
		);
	});
});
