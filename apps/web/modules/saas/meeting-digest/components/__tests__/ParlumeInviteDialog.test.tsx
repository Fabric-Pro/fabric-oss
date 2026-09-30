import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Button } from "@ui/components/button";
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

function showDialog(open = true) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, gcTime: 0 } },
	});
	render(
		<QueryClientProvider client={client}>
			<ParlumeInviteDialog projectId="example-project">
				<Button>Open Parlume</Button>
			</ParlumeInviteDialog>
		</QueryClientProvider>,
	);
	if (open) {
		fireEvent.click(screen.getByRole("button", { name: "Open Parlume" }));
	}
}

async function enterMeeting() {
	await screen.findByRole("option", { name: "Fabric Agent — this project" });
	fireEvent.change(screen.getByLabelText("Teams meeting link"), {
		target: { value: meetingUrl },
	});
}

describe("Parlume invitation selection", () => {
	it.each(["Escape", "Cancel", "Close"])(
		"returns keyboard focus to the invitation trigger after %s",
		async (dismissal) => {
			const user = userEvent.setup();
			showDialog(false);
			const trigger = screen.getByRole("button", {
				name: "Open Parlume",
			});
			await user.tab();
			expect(trigger).toHaveFocus();
			await user.keyboard("{Enter}");
			await screen.findByRole("option", {
				name: "Fabric Agent — this project",
			});
			if (dismissal === "Escape") {
				await user.keyboard("{Escape}");
			} else {
				await user.click(
					screen.getByRole("button", { name: dismissal }),
				);
			}
			await waitFor(() =>
				expect(screen.queryByRole("dialog")).toBeNull(),
			);
			expect(trigger).toHaveFocus();
			await user.keyboard("{Enter}");
			expect(await screen.findByRole("dialog")).toBeInTheDocument();
		},
	);

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
				toolsReadOnly: true,
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
				toolsReadOnly: true,
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

	it("opts into confirmed actions and restores read-only for the next invite", async () => {
		showDialog();
		await enterMeeting();
		const mode = screen.getByRole("switch", { name: "Read-only" });
		expect(mode).toBeChecked();
		fireEvent.click(mode);
		expect(mode).not.toBeChecked();
		fireEvent.click(screen.getByRole("button", { name: "Invite Parlume" }));
		await waitFor(() =>
			expect(mocks.start).toHaveBeenCalledWith(
				expect.objectContaining({ toolsReadOnly: false }),
			),
		);
		await waitFor(() =>
			expect(
				screen.getByRole("switch", { name: "Read-only" }),
			).toBeChecked(),
		);
		fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
		fireEvent.click(screen.getByRole("button", { name: "Open Parlume" }));
		expect(
			await screen.findByRole("switch", { name: "Read-only" }),
		).toBeChecked();
	});
});
