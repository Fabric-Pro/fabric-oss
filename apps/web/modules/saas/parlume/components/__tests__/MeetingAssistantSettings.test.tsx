import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
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
import { MeetingAssistantSettings } from "../MeetingAssistantSettings";

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	update: vi.fn(),
	testAttendee: vi.fn(),
	testRealtimeVoice: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { parlumeSettings: mocks },
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function settings(
	overrides: {
		attendee?: object;
		voice?: object;
		guests?: object;
		channel?: object;
	} = {},
) {
	return {
		attendee: {
			maskedApiKey: "••••1234",
			hasWebhookSecret: true,
			baseUrl: null,
			teamsLoginMode: null,
			teamsLoginGroup: null,
			effectiveSource: "organization",
			...overrides.attendee,
		},
		voice: { realtimeDeployment: null, ...overrides.voice },
		guests: { policy: "NOTES_ONLY", ...overrides.guests },
		channel: { integrationId: null, connections: [], ...overrides.channel },
		defaults: {
			attendeeBaseUrl: "https://app.attendee.dev",
			realtimeDeployment: "gpt-realtime-2.1",
		},
		updatedAt: null,
	};
}

function showSettings(readOnly = false) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<MeetingAssistantSettings
				organizationId="org-1"
				aiProvidersHref="/app/example-org/settings/ai-providers"
				readOnly={readOnly}
			/>
		</QueryClientProvider>,
	);
}

const keyField = () => screen.findByLabelText("Attendee API key");
const saveButtons = () => screen.getAllByRole("button", { name: "Save" });

beforeAll(() => {
	Element.prototype.hasPointerCapture ??= () => false;
	Element.prototype.setPointerCapture ??= () => undefined;
	Element.prototype.releasePointerCapture ??= () => undefined;
});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.get.mockResolvedValue(settings());
	mocks.update.mockResolvedValue(settings());
});

afterEach(cleanup);

describe("MeetingAssistantSettings", () => {
	it("shows the saved key only by its last four characters, in an empty field", async () => {
		showSettings();

		const field = await keyField();
		expect(field).toHaveValue("");
		expect(field).toHaveAttribute("type", "password");
		expect(field).toHaveAttribute(
			"placeholder",
			"Saved key ••••1234. Leave empty to keep it.",
		);
		expect(screen.getByTestId("attendee-source")).toHaveTextContent(
			"Invitations use your organization's Attendee key.",
		);
	});

	it("saves with the key field empty so the stored key is kept", async () => {
		const user = userEvent.setup();
		mocks.get.mockResolvedValue(
			settings({ attendee: { baseUrl: "https://attendee.example.com" } }),
		);
		showSettings();
		await keyField();

		await user.click(screen.getByLabelText(/Sign in when the meeting/));
		await user.click(saveButtons()[0]);

		expect(mocks.update).toHaveBeenCalledWith({
			organizationId: "org-1",
			attendeeApiKey: "",
			attendeeWebhookSecret: "",
			attendeeBaseUrl: "https://attendee.example.com",
			teamsLoginMode: "only_if_required",
			teamsLoginGroup: null,
		});
	});

	it("asks for the key again before the saved key is used with a new URL", async () => {
		const user = userEvent.setup();
		showSettings();
		const field = await keyField();
		expect(field).not.toBeRequired();

		await user.type(
			screen.getByLabelText("Attendee URL"),
			"https://attendee.example.com",
		);

		expect(field).toBeRequired();
		expect(field).toHaveAccessibleDescription(
			"Enter the key again to use it with a different Attendee URL.",
		);
		expect(saveButtons()[0]).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "Test connection" }),
		).toBeDisabled();

		await user.type(field, "typed-attendee-key");
		await user.click(saveButtons()[0]);

		expect(mocks.update).toHaveBeenCalledWith({
			organizationId: "org-1",
			attendeeApiKey: "typed-attendee-key",
			attendeeWebhookSecret: "",
			attendeeBaseUrl: "https://attendee.example.com",
			teamsLoginMode: null,
			teamsLoginGroup: null,
		});
	});

	it("saves the Teams login group a signed-in bot uses, and hides it for an anonymous bot", async () => {
		const user = userEvent.setup();
		showSettings();
		await keyField();

		expect(screen.queryByLabelText("Teams login group")).toBeNull();
		await user.click(screen.getByLabelText(/^Always sign in/));
		await user.type(
			screen.getByLabelText("Teams login group"),
			"example-org bot",
		);
		await user.click(saveButtons()[0]);

		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({
				teamsLoginMode: "always",
				teamsLoginGroup: "example-org bot",
			}),
		);
	});

	it("shows the saved Teams login group", async () => {
		mocks.get.mockResolvedValue(
			settings({
				attendee: {
					teamsLoginMode: "always",
					teamsLoginGroup: "example-org bot",
				},
			}),
		);
		showSettings();
		await keyField();

		expect(screen.getByLabelText("Teams login group")).toHaveValue(
			"example-org bot",
		);
	});

	it("chooses the shared Microsoft connection Parlume replies in channels with", async () => {
		const user = userEvent.setup();
		mocks.get.mockResolvedValue(
			settings({
				channel: {
					integrationId: null,
					connections: [
						{
							id: "shared-1",
							name: "Microsoft 365",
							connectedBy: "Dana Admin",
						},
					],
				},
			}),
		);
		showSettings();
		await keyField();

		expect(
			screen.getByLabelText(/^The inviter's own Microsoft connection/),
		).toBeChecked();
		await user.click(screen.getByLabelText(/^Microsoft 365/));
		await user.click(saveButtons()[3]);

		expect(mocks.update).toHaveBeenCalledWith({
			organizationId: "org-1",
			channelIntegrationId: "shared-1",
		});
	});

	it("says how to share a Parlume account when the organization shares none", async () => {
		showSettings();
		await keyField();

		expect(
			screen.getByText(
				/Your organization shares no Microsoft connection yet/,
			),
		).toBeInTheDocument();
	});

	it("saves a typed webhook secret and never shows the saved one", async () => {
		const user = userEvent.setup();
		showSettings();
		await keyField();

		const field = screen.getByLabelText("Attendee webhook secret");
		expect(field).toHaveValue("");
		expect(field).toHaveAttribute("type", "password");
		expect(field).toHaveAttribute(
			"placeholder",
			"Saved. Leave empty to keep it.",
		);

		const secret = btoa("example-webhook-secret");
		await user.type(field, secret);
		await user.click(saveButtons()[0]);

		expect(mocks.update).toHaveBeenCalledWith(
			expect.objectContaining({ attendeeWebhookSecret: secret }),
		);
	});

	it("removes the saved key on request", async () => {
		const user = userEvent.setup();
		showSettings();
		await keyField();

		await user.click(
			screen.getByRole("button", { name: "Remove the saved key" }),
		);

		expect(mocks.update).toHaveBeenCalledWith({
			organizationId: "org-1",
			clearAttendeeApiKey: true,
		});
	});

	it("tests the typed key and says when Attendee rejects it", async () => {
		const user = userEvent.setup();
		mocks.testAttendee.mockResolvedValue({
			status: "invalid_key",
			httpStatus: 401,
		});
		showSettings();

		await user.type(await keyField(), "typed-attendee-key");
		await user.click(
			screen.getByRole("button", { name: "Test connection" }),
		);

		expect(
			await screen.findByText("Attendee rejected the key (HTTP 401)."),
		).toBeInTheDocument();
		expect(mocks.testAttendee).toHaveBeenCalledWith({
			organizationId: "org-1",
			attendeeApiKey: "typed-attendee-key",
			attendeeBaseUrl: null,
		});
	});

	it("says when no meeting bot is configured anywhere", async () => {
		mocks.get.mockResolvedValue(
			settings({
				attendee: { maskedApiKey: null, effectiveSource: null },
			}),
		);
		showSettings();

		await keyField();
		expect(screen.getByTestId("attendee-source")).toHaveTextContent(
			"No meeting bot is configured.",
		);
		expect(
			screen.queryByRole("button", { name: "Remove the saved key" }),
		).not.toBeInTheDocument();
	});

	it("reports the realtime deployment by name", async () => {
		const user = userEvent.setup();
		mocks.get.mockResolvedValue(
			settings({ voice: { realtimeDeployment: "example-realtime" } }),
		);
		mocks.testRealtimeVoice.mockResolvedValue({
			hosts: [
				{
					provider: "AZURE_AI_FOUNDRY",
					model: "example-realtime",
					ok: false,
					status: 404,
					message: "Deployment not found",
				},
			],
		});
		showSettings();
		await keyField();

		await user.click(
			screen.getByRole("button", { name: "Test realtime voice" }),
		);

		expect(
			await screen.findByText(
				"Azure AI Foundry (example-realtime) refused (HTTP 404: Deployment not found).",
			),
		).toBeInTheDocument();
	});

	it("says Parlume keeps its standard voice until a realtime deployment is named", async () => {
		const user = userEvent.setup();
		mocks.testRealtimeVoice.mockResolvedValue({ hosts: [] });
		showSettings();
		await keyField();

		await user.click(
			screen.getByRole("button", { name: "Test realtime voice" }),
		);

		expect(
			await screen.findByText(
				"Parlume uses its standard voice. Name a realtime deployment in your Azure AI Foundry resource to use the realtime voice.",
			),
		).toBeInTheDocument();
	});

	it("saves what Parlume does when a guest is in the meeting", async () => {
		const user = userEvent.setup();
		mocks.update.mockResolvedValue(
			settings({ guests: { policy: "INTERNAL_ONLY" } }),
		);
		showSettings();
		await keyField();

		expect(screen.getByLabelText(/^Notes only/)).toBeChecked();
		await user.click(screen.getByLabelText(/^Internal meetings only/));
		await user.click(saveButtons()[2]);

		expect(mocks.update).toHaveBeenCalledWith({
			organizationId: "org-1",
			guestPolicy: "INTERNAL_ONLY",
		});
	});

	// The bare model name in an empty field read as a deployment already set.
	it("shows an empty realtime deployment field as an example, not a value", async () => {
		showSettings();
		await keyField();

		const field = screen.getByLabelText("Azure realtime deployment");
		expect(field).toHaveValue("");
		expect(field).toHaveAttribute(
			"placeholder",
			"For example, gpt-realtime-2.1",
		);
	});

	it("asks to save a changed deployment name before testing it", async () => {
		const user = userEvent.setup();
		showSettings();
		await keyField();

		await user.type(
			screen.getByLabelText("Azure realtime deployment"),
			"example-realtime",
		);

		expect(
			screen.getByRole("button", { name: "Test realtime voice" }),
		).toBeDisabled();
		await user.click(saveButtons()[1]);
		expect(mocks.update).toHaveBeenCalledWith({
			organizationId: "org-1",
			realtimeDeployment: "example-realtime",
		});
	});

	it("is read-only for members who cannot change it", async () => {
		showSettings(true);

		expect(await keyField()).toBeDisabled();
		expect(
			screen.getByText(
				"Only organization owners and admins can change these settings.",
			),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Save" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "Remove the saved key" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "AI providers" }),
		).toHaveAttribute("href", "/app/example-org/settings/ai-providers");
	});
});
