import { render as baseRender, screen, within } from "@testing-library/react";
import { NuqsTestingAdapter } from "nuqs/adapters/testing";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const render = (ui: ReactElement) =>
	baseRender(ui, {
		wrapper: ({ children }) => (
			<NuqsTestingAdapter>{children}</NuqsTestingAdapter>
		),
	});

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

// Same orpc stub shape as ProjectNewsletterSettings.pagination.test.tsx: each
// procedure stamps a `__q` marker that the useQuery mock below resolves.
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
				recipientPreview: {
					queryOptions: (o: { input: unknown }) => ({
						__q: "recipientPreview",
						...o,
					}),
				},
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
	keepPreviousData: (previous: unknown) => previous,
	useQuery: (opts: { __q?: string }) => ({
		data: queryData[opts.__q ?? ""],
		isLoading: false,
	}),
	useMutation: () => ({ isPending: false, mutate: vi.fn() }),
	useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));

import { ProjectNewsletterSettings } from "../ProjectNewsletterSettings";

const REASON = [
	"example-org/example-repo: GitHub API error: Not Found",
	"example-org/other-repo: No access token on integration (not yet authorized?)",
].join("\n");

function send(over: Record<string, unknown>) {
	return {
		id: "example-send",
		createdAt: "2026-01-01",
		status: "SKIPPED_EMPTY",
		skipReason: "INCOMPLETE_SCAN",
		trigger: "SCHEDULED",
		sentCount: 0,
		recipientCount: 0,
		failedCount: 0,
		deliveryDestination: "EMAIL",
		requireApproval: false,
		incompleteScanReason: null,
		...over,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
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
	queryData.pending = { sends: [] };
	queryData.repos = { integrations: [] };
	queryData.teamsLinked = [];
	queryData.slackLinked = [];
});

describe("ProjectNewsletterSettings — incomplete-scan reason in send history", () => {
	it("shows which repositories failed under an incomplete-scan send's status", () => {
		queryData.sends = {
			sends: [send({ incompleteScanReason: REASON })],
			total: 1,
		};
		render(
			<ProjectNewsletterSettings
				projectId="example-project"
				organizationId={null}
			/>,
		);

		const badge = screen.getByText("Scan incomplete");
		const cell = badge.closest("td");
		if (!cell) {
			throw new Error("Expected the status cell");
		}
		// Plain visible text in the same cell, so a screen reader reads it with
		// the status rather than behind a hover-only tooltip.
		const reason = within(cell).getByText(
			/example-org\/example-repo: GitHub API error: Not Found/,
		);
		expect(reason.textContent).toBe(REASON);
	});

	it("shows nothing extra for an incomplete-scan send without a recorded reason", () => {
		queryData.sends = { sends: [send({})], total: 1 };
		render(
			<ProjectNewsletterSettings
				projectId="example-project"
				organizationId={null}
			/>,
		);

		const cell = screen.getByText("Scan incomplete").closest("td");
		if (!cell) {
			throw new Error("Expected the status cell");
		}
		expect(cell.textContent).toBe("Scan incomplete");
		expect(screen.queryByText(/GitHub API error/)).not.toBeInTheDocument();
	});
});
