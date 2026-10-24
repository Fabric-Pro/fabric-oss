import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	fireEvent,
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
import { PROJECT_BASE_PATH } from "./fixtures";

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
const builtIn = {
	kind: "FABRIC_AGENT",
	label: "Fabric Agent — this project",
	description: "Uses this project's current knowledge and behavior.",
	agentInstanceSId: null,
	version: null,
};
const custom = {
	kind: "TEMPLATE_INSTANCE",
	label: "Example release assistant",
	description: null,
	agentInstanceSId: "agent-stable-1",
	version: 3,
};

beforeAll(() => {
	// Radix Select and Tooltip lean on pointer capture, which jsdom lacks.
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.setPointerCapture ??= () => undefined;
	Element.prototype.releasePointerCapture ??= () => undefined;
});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.listAgents.mockResolvedValue({
		agents: [builtIn, custom],
		operatorReady: true,
	});
	mocks.listSessions.mockResolvedValue({
		sessions: [],
		total: 0,
		nextCursor: null,
	});
	mocks.history.mockResolvedValue({ items: [], total: 0, nextCursor: null });
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
			<ParlumePage
				projectId="example-project"
				projectBasePath={PROJECT_BASE_PATH}
				canEdit={canEdit}
			/>
		</QueryClientProvider>,
	);
}

const linkField = () => screen.getByLabelText("Teams meeting link");
const inviteButton = () =>
	screen.getByRole("button", { name: "Invite Parlume" });

async function readyToInvite() {
	await screen.findByRole("combobox", { name: "Agent" });
	fireEvent.change(linkField(), { target: { value: `  ${meetingUrl}  ` } });
}

describe("ParlumePage header", () => {
	it("opens with the editorial label, the page title and what Parlume is", async () => {
		showPage();
		expect(
			await screen.findByText("Voice agent · Microsoft Teams"),
		).toHaveClass("app-editorial-label");
		expect(
			screen.getByRole("heading", { level: 1, name: "Fabric Parlume" }),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				"Your project's voice agent for Microsoft Teams meetings.",
			),
		).toBeInTheDocument();
	});
});

describe("ParlumePage invitation", () => {
	it("invites with read-only tools by default and trims the link", async () => {
		showPage();
		await readyToInvite();
		fireEvent.click(inviteButton());
		await waitFor(() =>
			expect(mocks.start).toHaveBeenCalledWith({
				projectId: "example-project",
				agentKind: "FABRIC_AGENT",
				meetingUrl,
				toolsReadOnly: true,
				suggestionsEnabled: true,
			}),
		);
	});

	it("enables Invite as soon as there is a meeting link, with no acknowledgement to tick", async () => {
		showPage();
		await screen.findByRole("combobox", { name: "Agent" });
		expect(inviteButton()).toBeDisabled();
		expect(inviteButton()).toHaveAccessibleDescription(
			"Paste a Teams meeting link first",
		);

		fireEvent.change(linkField(), { target: { value: meetingUrl } });

		expect(inviteButton()).toBeEnabled();
		expect(screen.queryByRole("checkbox")).toBeNull();
		expect(
			screen.getByText(/Parlume records and transcribes the meeting/),
		).toBeInTheDocument();
	});

	it("links the recording notice to the in-the-meeting card", async () => {
		showPage();
		const link = await screen.findByRole("link", {
			name: "What Parlume does in a meeting",
		});
		expect(link).toHaveAttribute("href", "#pr-how");
		expect(document.getElementById("pr-how")).toHaveTextContent(
			"In the meeting",
		);
	});

	it("guides the link field from empty to valid or invalid", async () => {
		showPage();
		await screen.findByRole("combobox", { name: "Agent" });
		expect(
			screen.getByText(/Copy the join link from the meeting invite/),
		).toBeInTheDocument();
		expect(inviteButton()).toBeDisabled();
		expect(inviteButton()).toHaveAccessibleDescription(
			"Paste a Teams meeting link first",
		);

		fireEvent.change(linkField(), {
			target: { value: "https://example.com/meeting" },
		});
		expect(
			screen.getByText("This doesn't look like a Teams meeting link."),
		).toHaveAttribute("role", "alert");
		expect(linkField()).toBeInvalid();
		expect(inviteButton()).toBeDisabled();

		fireEvent.change(linkField(), { target: { value: meetingUrl } });
		expect(
			screen.getByText("Teams meeting link", { selector: "p" }),
		).toBeInTheDocument();
		expect(
			screen.queryByText("This doesn't look like a Teams meeting link."),
		).not.toBeInTheDocument();
		expect(linkField()).toBeValid();
	});

	it("accepts a Teams link from another Microsoft cloud", async () => {
		showPage();
		await screen.findByRole("combobox", { name: "Agent" });
		fireEvent.change(linkField(), {
			target: {
				value: "https://teams.microsoft.us/l/meetup-join/example",
			},
		});
		expect(
			screen.getByText("Teams meeting link", { selector: "p" }),
		).toBeInTheDocument();
	});

	it("offers the two modes as radios and sends the chosen one", async () => {
		showPage();
		await readyToInvite();
		const readOnly = screen.getByRole("radio", { name: "Read-only" });
		const actions = screen.getByRole("radio", { name: "Actions" });
		expect(readOnly).toBeChecked();
		expect(actions).not.toBeChecked();
		expect(
			screen.getByText(
				/Makes the changes attendees ask for, with your permissions, as soon as they ask/,
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/confirm/i)).toBeNull();

		fireEvent.click(actions);
		expect(actions).toBeChecked();
		expect(readOnly).not.toBeChecked();
		fireEvent.click(inviteButton());

		await waitFor(() =>
			expect(mocks.start).toHaveBeenCalledWith(
				expect.objectContaining({ toolsReadOnly: false }),
			),
		);
	});

	it("picks a custom agent from the list and sends its stable reference", async () => {
		const user = userEvent.setup();
		showPage();
		const picker = await screen.findByRole("combobox", { name: "Agent" });
		expect(picker).toHaveTextContent("Fabric Agent — this project");
		expect(picker).toHaveTextContent("Built-in");

		await user.click(picker);
		const option = await screen.findByRole("option", {
			name: /Example release assistant/,
		});
		expect(option).toHaveTextContent("v3");
		expect(option).toHaveTextContent("Custom agent bound to this project.");
		await user.click(option);

		expect(picker).toHaveTextContent("Example release assistant");
		expect(picker).toHaveTextContent("v3");
		fireEvent.change(linkField(), { target: { value: meetingUrl } });
		fireEvent.click(inviteButton());
		await waitFor(() =>
			expect(mocks.start).toHaveBeenCalledWith({
				projectId: "example-project",
				agentKind: "TEMPLATE_INSTANCE",
				agentInstanceSId: "agent-stable-1",
				meetingUrl,
				toolsReadOnly: true,
				suggestionsEnabled: true,
			}),
		);
	});

	it("shows an alert and disables invitations when the operator is not ready", async () => {
		mocks.listAgents.mockResolvedValue({
			agents: [builtIn],
			operatorReady: false,
		});
		showPage();
		expect(
			await screen.findByText(
				/An operator must complete its media setup/,
			),
		).toHaveAttribute("role", "alert");
		fireEvent.change(linkField(), { target: { value: meetingUrl } });
		expect(inviteButton()).toBeDisabled();
	});

	it("lets the reader retry when the project agents cannot be loaded", async () => {
		mocks.listAgents.mockRejectedValueOnce(new Error("offline"));
		showPage();
		expect(
			await screen.findByText("Could not load project agents."),
		).toHaveAttribute("role", "alert");
		fireEvent.change(linkField(), { target: { value: meetingUrl } });
		expect(inviteButton()).toBeDisabled();

		fireEvent.click(screen.getByRole("button", { name: "Retry agents" }));
		await screen.findByRole("combobox", { name: "Agent" });
		expect(inviteButton()).toBeEnabled();
	});

	it("invites without chat suggestions when the inviter turns them off", async () => {
		showPage();
		await readyToInvite();
		fireEvent.click(screen.getByRole("switch", { name: "label" }));
		fireEvent.click(inviteButton());
		await waitFor(() =>
			expect(mocks.start).toHaveBeenCalledWith(
				expect.objectContaining({ suggestionsEnabled: false }),
			),
		);
	});

	it("reports a failed invitation", async () => {
		mocks.start.mockRejectedValue(new Error("bad link"));
		showPage();
		await readyToInvite();
		fireEvent.click(inviteButton());
		expect(
			await screen.findByText(/could not join this meeting/),
		).toHaveAttribute("role", "alert");
	});

	it("hides the invite form from non-editors and says why", async () => {
		showPage(false);
		const locked = await screen.findByText("Parlume is not in a meeting");
		expect(
			within(locked.closest("section") as HTMLElement).getByText(
				"Only project administrators can invite or remove Parlume.",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Invite Parlume" }),
		).not.toBeInTheDocument();
		expect(mocks.listAgents).not.toHaveBeenCalled();
	});
});
