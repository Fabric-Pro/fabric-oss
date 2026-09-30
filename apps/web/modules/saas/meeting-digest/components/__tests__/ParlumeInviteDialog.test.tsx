import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ParlumeInviteDialog } from "../ParlumeInviteDialog";

const mocks = vi.hoisted(() => ({
	listAgents: vi.fn(),
	listSessions: vi.fn(),
	start: vi.fn(),
	stop: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { parlume: mocks } },
}));

const builtIn = {
	kind: "FABRIC_AGENT",
	label: "Fabric Agent — this project",
	agentInstanceSId: null,
	version: null,
};
const custom = {
	kind: "TEMPLATE_INSTANCE",
	label: "Example assistant",
	agentInstanceSId: "example-agent",
	version: 2,
};
const meetingUrl = "https://teams.microsoft.com/l/meetup-join/example";

beforeEach(() => {
	vi.resetAllMocks();
	mocks.listAgents.mockResolvedValue({
		agents: [builtIn],
		operatorReady: true,
	});
	mocks.listSessions.mockResolvedValue({ sessions: [] });
	mocks.start.mockResolvedValue({});
});
afterEach(cleanup);

function showDialog() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	render(
		<QueryClientProvider client={client}>
			<ParlumeInviteDialog
				projectId="example-project"
				open
				onOpenChange={vi.fn()}
			/>
		</QueryClientProvider>,
	);
}

async function enterMeeting() {
	await screen.findByRole("option", { name: "Fabric Agent — this project" });
	fireEvent.change(screen.getByLabelText("Teams meeting link"), {
		target: { value: meetingUrl },
	});
}

describe("Parlume invitation selection", () => {
	it("defaults to the built-in agent when there are no custom agents", async () => {
		showDialog();
		await enterMeeting();
		expect(screen.getByLabelText("Fabric Agent")).toHaveValue(
			"FABRIC_AGENT",
		);
		fireEvent.click(screen.getByRole("button", { name: "Invite Parlume" }));
		await waitFor(() =>
			expect(mocks.start).toHaveBeenCalledWith({
				projectId: "example-project",
				agentKind: "FABRIC_AGENT",
				meetingUrl,
			}),
		);
		expect(mocks.listAgents).toHaveBeenCalledWith({
			projectId: "example-project",
			includeBuiltIn: true,
		});
	});

	it("submits the selected custom instance without changing the built-in default", async () => {
		mocks.listAgents.mockResolvedValue({
			agents: [builtIn, custom],
			operatorReady: true,
		});
		showDialog();
		await enterMeeting();
		fireEvent.change(screen.getByLabelText("Fabric Agent"), {
			target: { value: "custom:example-agent" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Invite Parlume" }));
		await waitFor(() =>
			expect(mocks.start).toHaveBeenCalledWith({
				projectId: "example-project",
				agentKind: "TEMPLATE_INSTANCE",
				agentInstanceSId: "example-agent",
				meetingUrl,
			}),
		);
	});

	it("shows missing operator setup and prevents invitations", async () => {
		mocks.listAgents.mockResolvedValue({
			agents: [builtIn],
			operatorReady: false,
		});
		showDialog();
		await enterMeeting();
		expect(screen.getByRole("alert")).toHaveTextContent(
			"not configured for invitations",
		);
		expect(
			screen.getByRole("button", { name: "Invite Parlume" }),
		).toBeDisabled();
		expect(mocks.start).not.toHaveBeenCalled();
	});
});
