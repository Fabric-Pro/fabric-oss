/**
 * A failed settings read must be visible, not silently rendered as defaults.
 *
 * Every field in the panel reads `settingsQuery.data?.settings` with a `??`
 * fallback, so before this the error path produced a complete, confident-looking
 * form: newsletter off, no subscribers, weekly at 09:00. That is exactly what a
 * project with no newsletter looks like, which is how an access failure stayed
 * invisible until someone tried to save and got "Project not found".
 *
 * Run with: pnpm --filter web test ProjectNewsletterSettings.readError
 */
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

// Module-scope spies referenced lazily by the mock factory (the factory runs at
// import time, after these consts are initialized — same pattern as the sibling
// suites).
const queryData: Record<string, unknown> = {};
const refetchSpy = vi.fn();
const queryError: Record<string, boolean> = {};

vi.mock("@tanstack/react-query", () => ({
	useQuery: (opts: { __q?: string }) => {
		const key = opts.__q ?? "";
		const isError = queryError[key] === true;
		return {
			// react-query leaves `data` undefined on error — modelling that is the
			// point, since the component's `??` defaults are what used to hide it.
			data: isError ? undefined : queryData[key],
			isLoading: false,
			isFetching: false,
			isError,
			refetch: refetchSpy,
		};
	},
	useMutation: () => ({ isPending: false, mutate: vi.fn() }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { ProjectNewsletterSettings } from "../ProjectNewsletterSettings";

beforeEach(() => {
	vi.clearAllMocks();
	for (const k of Object.keys(queryError)) {
		delete queryError[k];
	}
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
		},
	};
	queryData.subscribers = { subscribers: [] };
	queryData.sends = { sends: [], total: 0 };
	queryData.pending = { sends: [] };
	queryData.repos = { integrations: [] };
	queryData.teamsLinked = [];
	queryData.slackLinked = [];
});

describe("ProjectNewsletterSettings — failed settings read", () => {
	it("shows an error instead of the settings form", () => {
		queryError.settings = true;
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		expect(
			screen.getByText("Newsletter settings could not be loaded"),
		).toBeInTheDocument();
		// The load-bearing half: none of the misleading defaults are on screen.
		expect(
			screen.queryByRole("switch", { name: "Enable newsletter" }),
		).toBeNull();
		expect(screen.queryByText("No active subscribers yet.")).toBeNull();
	});

	it("offers a retry that refetches", () => {
		queryError.settings = true;
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		fireEvent.click(screen.getByRole("button", { name: "Try again" }));
		expect(refetchSpy).toHaveBeenCalledTimes(1);
	});

	it("renders the form normally when the read succeeds", () => {
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		// Negative control for the two tests above: without the error flag the
		// panel is intact, so their assertions are about the error path and not
		// about the panel failing to render at all.
		expect(
			screen.getByRole("switch", { name: "Enable newsletter" }),
		).toBeInTheDocument();
		expect(
			screen.queryByText("Newsletter settings could not be loaded"),
		).toBeNull();
	});
});
