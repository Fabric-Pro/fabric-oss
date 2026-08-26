import { render, screen, within } from "@testing-library/react";
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

describe("ProjectNewsletterSettings — detail level", () => {
	it("renders the three detail-level options in the settings select", async () => {
		const user = userEvent.setup();
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		const trigger = document.getElementById("newsletter-detail-level");
		expect(trigger).not.toBeNull();
		await user.click(trigger as HTMLElement);

		expect(
			await screen.findByRole("option", { name: "Brief" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("option", { name: "Standard" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("option", { name: "Detailed" }),
		).toBeInTheDocument();
	});

	it("calls updateSettings.mutate with the chosen detail level", async () => {
		const user = userEvent.setup();
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		const trigger = document.getElementById(
			"newsletter-detail-level",
		) as HTMLElement;
		await user.click(trigger);
		await user.click(await screen.findByRole("option", { name: "Brief" }));

		expect(updateMutate).toHaveBeenCalledWith({
			projectId: "p-1",
			organizationId: null,
			detailLevel: "BRIEF",
		});
	});

	it("pre-fills the Send-now dialog selector from the persisted value and forwards the override on send", async () => {
		setSettings({ detailLevel: "DETAILED" });
		const user = userEvent.setup();
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		// Before the dialog opens, its (portal-rendered) select isn't mounted.
		expect(
			document.getElementById("newsletter-send-now-detail-level"),
		).toBeNull();

		await user.click(screen.getByRole("button", { name: "Send now" }));

		const dialog = screen.getByRole("alertdialog");
		const dialogTrigger = document.getElementById(
			"newsletter-send-now-detail-level",
		) as HTMLElement;
		expect(dialogTrigger).not.toBeNull();
		// Seeded from the persisted `detailLevel: "DETAILED"` setting, not the
		// select's own default of "STANDARD".
		expect(dialogTrigger.textContent).toContain("Detailed");

		await user.click(dialogTrigger);
		await user.click(await screen.findByRole("option", { name: "Brief" }));
		await user.click(
			within(dialog).getByRole("button", { name: "Send now" }),
		);

		expect(sendNowMutate).toHaveBeenCalledWith("BRIEF");
	});
});
