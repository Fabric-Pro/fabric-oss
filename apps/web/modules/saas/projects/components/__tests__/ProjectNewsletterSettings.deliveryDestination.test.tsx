import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
	useTranslations: (namespace?: string) => (key: string) =>
		namespace ? `${namespace}.${key}` : key,
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@repo/utils", () => ({
	getBaseUrl: () => "https://app.example.com",
}));

// Capture what each mutation was called with. Routed by the ACTUAL mutate
// argument shape (not by inspecting mutationFn source, which is brittle):
// sendNow is always called with a single detail-level string, while
// updateSettings is always called with an options object.
const updateMutate = vi.fn();
const sendNowMutate = vi.fn();

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		newsletter: {
			settings: {
				get: {
					queryOptions: (o: { input: unknown }) => ({
						__q: "settings",
						...o,
					}),
					queryKey: (o: { input: unknown }) => ["settings", o.input],
				},
				update: {
					mutationOptions: () => ({ __m: "update" }),
				},
				regenerateEmbedToken: {
					mutationOptions: () => ({ __m: "regenerate" }),
				},
			},
			subscribers: {
				list: {
					queryOptions: (o: { input: unknown }) => ({
						__q: "subscribers",
						...o,
					}),
					queryKey: (o: { input: unknown }) => [
						"subscribers",
						o.input,
					],
				},
			},
			sends: {
				list: {
					queryOptions: (o: { input: unknown }) => ({
						__q: "sends",
						...o,
					}),
				},
				pending: {
					queryOptions: (o: { input: unknown }) => ({
						__q: "pending",
						...o,
					}),
				},
				// Declared unconditionally by the component (the lazily-enabled
				// per-channel chat delivery panel, Fizzy #2013) so the stub has
				// to exist even though no row is expanded in these tests.
				chatDeliveries: {
					queryOptions: (o: { input: unknown }) => ({
						__q: "chatDeliveries",
						...o,
					}),
				},
			},
		},
		projects: {
			repositoryIntegrations: {
				list: {
					queryOptions: (o: { input: unknown }) => ({
						__q: "repos",
						...o,
					}),
				},
			},
			teamsChannelMonitor: {
				listLinkedChannels: {
					queryOptions: (o: {
						input: unknown;
						enabled?: boolean;
					}) => ({
						__q: "teamsLinked",
						...o,
					}),
				},
			},
			slackChannelMonitor: {
				listLinkedChannels: {
					queryOptions: (o: {
						input: unknown;
						enabled?: boolean;
					}) => ({
						__q: "slackLinked",
						...o,
					}),
				},
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));

const queryData: Record<string, unknown> = {};
vi.mock("@tanstack/react-query", () => ({
	useQuery: (opts: { __q?: string }) => ({
		data: queryData[opts.__q ?? ""],
		isLoading: false,
	}),
	useMutation: (opts: {
		__m?: string;
		mutationFn?: (...args: unknown[]) => unknown;
	}) => ({
		isPending: false,
		mutate: (...args: unknown[]) => {
			const [arg] = args;
			if (typeof arg === "string") {
				sendNowMutate(...args);
			} else if (typeof arg === "object" && arg !== null) {
				updateMutate(...args);
			}
		},
	}),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { ProjectNewsletterSettings } from "../ProjectNewsletterSettings";

function setSettings(over: Record<string, unknown> = {}) {
	queryData.settings = {
		settings: {
			enabled: false,
			cadence: "WEEKLY",
			dayOfWeek: 1,
			dayOfMonth: 1,
			sendHourUtc: 9,
			lookbackDays: null,
			detailLevel: "STANDARD",
			deliveryDestination: "EMAIL",
			chatChannels: [],
			publicWidgetEnabled: false,
			publicEmbedToken: null,
			publicEmbedTokenVersion: 1,
			publicWidgetTheme: null,
			publicWidgetAccent: null,
			publicWidgetConfig: null,
			...over,
		},
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	setSettings();
	queryData.subscribers = { subscribers: [] };
	queryData.sends = { sends: [], total: 0 };
	queryData.pending = { sends: [] };
	queryData.repos = { integrations: [] };
	queryData.teamsLinked = [];
	queryData.slackLinked = [];
});

describe("ProjectNewsletterSettings — delivery destination", () => {
	it("renders the three destination options in the settings select", async () => {
		const user = userEvent.setup();
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		const trigger = document.getElementById(
			"newsletter-delivery-destination",
		);
		expect(trigger).not.toBeNull();
		await user.click(trigger as HTMLElement);

		expect(
			await screen.findByRole("option", { name: "Email" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("option", { name: "Chat channel" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("option", { name: "Both" }),
		).toBeInTheDocument();
	});

	it("calls updateSettings.mutate with the chosen destination", async () => {
		const user = userEvent.setup();
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		const trigger = document.getElementById(
			"newsletter-delivery-destination",
		) as HTMLElement;
		await user.click(trigger);
		await user.click(await screen.findByRole("option", { name: "Both" }));
		expect(updateMutate).toHaveBeenCalledWith({
			projectId: "p-1",
			organizationId: null,
			deliveryDestination: "BOTH",
		});
	});

	it("shows the connect-a-channel CTA when Chat is selected and none are connected", async () => {
		setSettings({ deliveryDestination: "CHAT" });
		// teamsLinked/slackLinked mocked empty
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		expect(
			await screen.findByText(/connect a Teams or Slack channel/i),
		).toBeInTheDocument();
	});

	it("does not render the channel picker or CTA when Email is selected", () => {
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		expect(
			screen.queryByText(/connect a Teams or Slack channel/i),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("checkbox", { name: /TEAMS:|SLACK:/ }),
		).not.toBeInTheDocument();
	});

	it("renders linked Teams and Slack channels as a checklist when Chat is selected", async () => {
		setSettings({ deliveryDestination: "CHAT" });
		queryData.teamsLinked = [
			{ teamId: "team-1", channelId: "chan-1", channelName: "General" },
		];
		queryData.slackLinked = [
			{
				slackTeamId: "T123",
				channelId: "C456",
				channelName: "eng-updates",
			},
		];
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		expect(
			await screen.findByRole("checkbox", { name: "TEAMS: General" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", { name: "SLACK: eng-updates" }),
		).toBeInTheDocument();
	});

	it("calls updateSettings.mutate with the rebuilt chatChannels array when a channel is toggled on", async () => {
		setSettings({ deliveryDestination: "CHAT", chatChannels: [] });
		queryData.teamsLinked = [
			{ teamId: "team-1", channelId: "chan-1", channelName: "General" },
		];
		queryData.slackLinked = [];
		const user = userEvent.setup();
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		await user.click(
			await screen.findByRole("checkbox", { name: "TEAMS: General" }),
		);

		expect(updateMutate).toHaveBeenCalledWith({
			projectId: "p-1",
			organizationId: null,
			chatChannels: [
				{
					platform: "TEAMS",
					teamId: "team-1",
					channelId: "chan-1",
					channelName: "General",
				},
			],
		});
	});

	it("removes a channel from chatChannels when its checkbox is toggled off", async () => {
		setSettings({
			deliveryDestination: "CHAT",
			chatChannels: [
				{
					platform: "TEAMS",
					teamId: "team-1",
					channelId: "chan-1",
					channelName: "General",
				},
			],
		});
		queryData.teamsLinked = [
			{ teamId: "team-1", channelId: "chan-1", channelName: "General" },
		];
		queryData.slackLinked = [];
		const user = userEvent.setup();
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		const checkbox = await screen.findByRole("checkbox", {
			name: "TEAMS: General",
		});
		expect(checkbox).toBeChecked();
		await user.click(checkbox);

		expect(updateMutate).toHaveBeenCalledWith({
			projectId: "p-1",
			organizationId: null,
			chatChannels: [],
		});
	});
});
