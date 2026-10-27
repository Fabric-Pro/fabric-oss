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

function settings(overrides: { attendee?: object; voice?: object } = {}) {
	return {
		attendee: {
			maskedApiKey: "••••1234",
			baseUrl: null,
			teamsLoginMode: null,
			effectiveSource: "organization",
			...overrides.attendee,
		},
		voice: { realtimeDeployment: null, ...overrides.voice },
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
			attendeeBaseUrl: "https://attendee.example.com",
			teamsLoginMode: "only_if_required",
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
			attendeeBaseUrl: "https://attendee.example.com",
			teamsLoginMode: null,
		});
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

	it("reports each realtime voice host by name and deployment", async () => {
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
				{
					provider: "OPENAI_DIRECT",
					model: "gpt-realtime-2.1",
					ok: true,
					status: null,
					message: null,
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
		expect(
			screen.getByText(
				"OpenAI (gpt-realtime-2.1): ready for realtime voice.",
			),
		).toBeInTheDocument();
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
