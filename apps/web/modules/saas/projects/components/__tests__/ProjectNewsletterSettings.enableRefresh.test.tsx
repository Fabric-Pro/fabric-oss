import { fireEvent, render, screen } from "@testing-library/react";
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

// Unlike the embed test (which discards onSuccess), pass the update mutation's
// options through so the real updateSettings.onSuccess runs and we can assert
// which queries it invalidates. queryKey builders stamp a recognizable first
// element so the spy assertions can identify each invalidated query.
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
					mutationOptions: (opts: unknown) => ({
						...(opts as object),
						__m: "update",
					}),
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

// Module-scope spy referenced lazily by the mock factory (the factory runs at
// import time, after this const is initialized — same pattern as the embed test).
const invalidateSpy = vi.fn();
const queryData: Record<string, unknown> = {};
vi.mock("@tanstack/react-query", () => ({
	useQuery: (opts: { __q?: string }) => ({
		data: queryData[opts.__q ?? ""],
		isLoading: false,
	}),
	// Invoke onSuccess(data, variables) on mutate; settings mutations pass the
	// changed fields as variables, which onSuccess inspects to decide whether to
	// also refresh the subscriber list.
	useMutation: (opts: {
		onSuccess?: (data: unknown, variables: unknown) => void;
	}) => ({
		isPending: false,
		mutate: (variables: unknown) => opts.onSuccess?.(undefined, variables),
	}),
	useQueryClient: () => ({ invalidateQueries: invalidateSpy }),
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

// The first element of each invalidated query key identifies the query.
function invalidatedKeys() {
	return invalidateSpy.mock.calls
		.map(([arg]) => (arg as { queryKey?: unknown[] })?.queryKey?.[0])
		.filter(Boolean);
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

describe("ProjectNewsletterSettings — refresh subscribers on enable", () => {
	it("invalidates the subscribers query when the newsletter is enabled (off -> on)", () => {
		setSettings({ enabled: false });
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		fireEvent.click(
			screen.getByRole("switch", { name: "Enable newsletter" }),
		);

		// Enabling backfills current members server-side, so the list must refresh.
		expect(invalidatedKeys()).toContain("settings");
		expect(invalidatedKeys()).toContain("subscribers");
	});

	it("does not refresh subscribers when the newsletter is disabled (on -> off)", () => {
		setSettings({ enabled: true });
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		fireEvent.click(
			screen.getByRole("switch", { name: "Enable newsletter" }),
		);

		// Disabling enrolls nobody; only the settings query needs invalidation.
		expect(invalidatedKeys()).toContain("settings");
		expect(invalidatedKeys()).not.toContain("subscribers");
	});
});
