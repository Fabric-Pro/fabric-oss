/**
 * Settings saves on the real React Query: they run one at a time, in the
 * order they were made, and a chat channel list stays locked until its last
 * save has been loaded again, so the next tick cannot build on an older list.
 *
 * Each save waits until the test resolves it, which applies it to the fake
 * server read by the settings query.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Save = {
	input: Record<string, unknown>;
	resolve: (value: unknown) => void;
};

const { server, saves } = vi.hoisted(() => ({
	server: {} as Record<string, unknown>,
	saves: [] as Save[],
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@repo/utils", () => ({
	getBaseUrl: () => "https://app.example.com",
}));

vi.mock("@shared/lib/orpc-query-utils", () => {
	const query = (name: string) => ({
		queryOptions: (o: { input: unknown }) => ({
			queryKey: [name, o.input],
			queryFn: async () => server[name] ?? null,
		}),
		queryKey: (o: { input: unknown }) => [name, o.input],
	});
	return {
		orpc: {
			newsletter: {
				settings: {
					get: query("settings"),
					update: {
						mutationOptions: (opts: object) => ({
							...opts,
							mutationFn: (input: Record<string, unknown>) =>
								new Promise((resolve) => {
									saves.push({ input, resolve });
								}),
						}),
					},
					regenerateEmbedToken: {
						mutationOptions: (opts: object) => ({
							...opts,
							mutationFn: async () => ({}),
						}),
					},
				},
				subscribers: { list: query("subscribers") },
				sends: {
					list: query("sends"),
					pending: query("pending"),
					recipientPreview: query("recipientPreview"),
					chatDeliveries: query("chatDeliveries"),
				},
			},
			projects: {
				environments: { list: query("environments") },
				repositoryIntegrations: { list: query("repos") },
				teamsChannelMonitor: {
					listLinkedChannels: query("teamsLinked"),
				},
				slackChannelMonitor: {
					listLinkedChannels: query("slackLinked"),
				},
			},
		},
	};
});

vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));

import { ProjectNewsletterSettings } from "../ProjectNewsletterSettings";

function setSettings(over: Record<string, unknown> = {}) {
	server.settings = {
		settings: {
			enabled: false,
			cadence: "WEEKLY",
			dayOfWeek: 1,
			dayOfMonth: 1,
			sendHourUtc: 9,
			lookbackDays: null,
			requireApproval: false,
			screenshotsEnabled: false,
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

function currentSettings(): Record<string, unknown> {
	const stored = server.settings as { settings: Record<string, unknown> };
	return stored.settings;
}

/** Lets the save finish, as the server would store it. */
async function resolveSave(save: Save) {
	const {
		projectId: _projectId,
		organizationId: _orgId,
		...fields
	} = save.input;
	setSettings({ ...currentSettings(), ...fields });
	await act(async () => {
		save.resolve({});
	});
}

function findSave(field: string): Save | undefined {
	return saves.find((save) => field in save.input);
}

function channelNames(save: Save | undefined): unknown {
	const channels = save?.input.chatChannels as
		| { channelName?: string }[]
		| undefined;
	return channels?.map((channel) => channel.channelName);
}

/** Gives a save that could start now the chance to do so. */
async function settle() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function renderSettings() {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<NuqsTestingAdapter>
				<ProjectNewsletterSettings
					projectId="p-1"
					organizationId={null}
				/>
			</NuqsTestingAdapter>
		</QueryClientProvider>,
	);
}

beforeEach(() => {
	saves.length = 0;
	setSettings();
	server.subscribers = { subscribers: [] };
	server.sends = { sends: [], total: 0 };
	server.pending = { sends: [] };
	server.repos = { integrations: [] };
	server.environments = [];
	server.teamsLinked = [];
	server.slackLinked = [];
});

describe("ProjectNewsletterSettings saves", () => {
	it("runs saves one at a time, in the order they were made", async () => {
		const user = userEvent.setup();
		renderSettings();
		const enable = await screen.findByRole("switch", {
			name: "Enable newsletter",
		});
		// The controls stay disabled until the settings have loaded.
		await waitFor(() => expect(enable).toBeEnabled());

		await user.click(enable);
		await waitFor(() => expect(saves).toHaveLength(1));
		await user.click(
			screen.getByRole("switch", {
				name: "Require review before sending",
			}),
		);
		await settle();

		expect(saves).toHaveLength(1);
		expect(saves[0]?.input).toMatchObject({ enabled: true });

		await resolveSave(saves[0] as Save);
		await waitFor(() => expect(saves).toHaveLength(2));
		expect(saves[1]?.input).toMatchObject({ requireApproval: true });
	});

	it("keeps a channel list locked until its save is loaded again", async () => {
		setSettings({ deliveryDestination: "CHAT" });
		server.teamsLinked = [
			{ teamId: "team-1", channelId: "chan-a", channelName: "Alpha" },
			{ teamId: "team-1", channelId: "chan-b", channelName: "Beta" },
		];
		const user = userEvent.setup();
		renderSettings();

		await user.click(
			await screen.findByRole("checkbox", { name: "TEAMS: Alpha" }),
		);
		await waitFor(() => expect(findSave("chatChannels")).toBeDefined());
		const alphaSave = findSave("chatChannels") as Save;
		expect(channelNames(alphaSave)).toEqual(["Alpha"]);

		// Another setting changes and, where it runs at once, finishes first.
		await user.click(
			screen.getByRole("switch", { name: "Enable newsletter" }),
		);
		await settle();
		const earlyEnableSave = findSave("enabled");
		if (earlyEnableSave) {
			await resolveSave(earlyEnableSave);
		}

		const beta = screen.getByRole("checkbox", { name: "TEAMS: Beta" });
		expect(beta).toBeDisabled();

		// The channel save lands last; the list opens once it is loaded.
		await resolveSave(alphaSave);
		await waitFor(() => expect(beta).toBeEnabled());
		const enableSave = await waitFor(() => {
			const save = findSave("enabled");
			expect(save).toBeDefined();
			return save as Save;
		});
		if (enableSave !== earlyEnableSave) {
			await resolveSave(enableSave);
		}

		await user.click(beta);

		await waitFor(() =>
			expect(channelNames(saves.at(-1))).toEqual(["Alpha", "Beta"]),
		);
	});
});
