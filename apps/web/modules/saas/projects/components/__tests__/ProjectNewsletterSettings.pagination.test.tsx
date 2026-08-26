import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal next-intl mock: return the bare key so we can assert against the key
// (matches the embed test convention for namespaced lookups).
vi.mock("next-intl", () => ({
	useTranslations: (namespace?: string) => (key: string) =>
		namespace ? `${namespace}.${key}` : key,
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

// getBaseUrl is called during snippet building; pin it for a deterministic snippet.
vi.mock("@repo/utils", () => ({
	getBaseUrl: () => "https://app.example.com",
}));

// The orpc query-utils proxy: each procedure exposes queryOptions/queryKey/
// mutationOptions. The pagination tests drive useQuery off the `__q` marker; the
// mutationOptions just need stable shapes.
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
					update: undefined,
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

// Drive each useQuery by the marker stamped in queryOptions above. useMutation
// invokes its onSuccess synchronously on mutate() with a one-added result, which
// lets the add-resets-to-page-1 test exercise the real onSuccess wiring. The
// settings update/regenerate mutations go through mutationOptions (no onSuccess
// on the mocked options object), so their mutate() is a harmless no-op.
const queryData: Record<string, unknown> = {};
vi.mock("@tanstack/react-query", () => ({
	useQuery: (opts: { __q?: string }) => ({
		data: queryData[opts.__q ?? ""],
		isLoading: false,
	}),
	useMutation: (opts: { onSuccess?: (result: unknown) => void }) => ({
		isPending: false,
		mutate: () => opts.onSuccess?.({ added: 1 }),
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

type SubStatus = "ACTIVE" | "UNSUBSCRIBED";

function makeSubscriber(email: string, status: SubStatus) {
	return {
		id: email,
		email,
		name: null,
		status,
		unsubscribeToken: `tok-${email}`,
		createdAt: new Date("2026-01-01T00:00:00Z"),
		unsubscribedAt:
			status === "UNSUBSCRIBED" ? new Date("2026-01-02T00:00:00Z") : null,
	};
}

function setSubscribers(active: number, unsubscribed = 0) {
	queryData.subscribers = {
		subscribers: [
			...Array.from({ length: active }, (_, i) =>
				makeSubscriber(`active${i}`, "ACTIVE"),
			),
			...Array.from({ length: unsubscribed }, (_, i) =>
				makeSubscriber(`unsub${i}`, "UNSUBSCRIBED"),
			),
		],
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	setSettings();
	queryData.subscribers = { subscribers: [] };
	// Keep the sends-history pager from rendering — it uses generic "Next page"/
	// "Previous page" labels and would otherwise collide with role queries.
	queryData.sends = { sends: [], total: 0 };
	queryData.pending = { sends: [] };
	queryData.repos = { integrations: [] };
	queryData.teamsLinked = [];
	queryData.slackLinked = [];
});

describe("ProjectNewsletterSettings — subscriber pagination", () => {
	it("shows only the first 10 active subscribers with a pager when over page size", () => {
		setSubscribers(25);
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		expect(screen.getByText("active0")).toBeInTheDocument();
		expect(screen.getByText("active9")).toBeInTheDocument();
		expect(screen.queryByText("active10")).not.toBeInTheDocument();
		expect(screen.getByText(/1 - 10 of 25/)).toBeInTheDocument();
	});

	it("renders no pager when active subscribers fit on one page", () => {
		setSubscribers(10);
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		expect(
			screen.queryByRole("button", {
				name: "Next page, active subscribers",
			}),
		).toBeNull();
	});

	it("advances to the next page of active subscribers", () => {
		setSubscribers(25);
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Next page, active subscribers",
			}),
		);

		expect(screen.getByText("active10")).toBeInTheDocument();
		expect(screen.queryByText("active0")).not.toBeInTheDocument();
		expect(screen.getByText(/11 - 20 of 25/)).toBeInTheDocument();
	});

	it("paginates the unsubscribed list independently when revealed", () => {
		setSubscribers(2, 15);
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		fireEvent.click(
			screen.getByRole("button", { name: "Show unsubscribed (15)" }),
		);

		expect(screen.getByText("unsub0")).toBeInTheDocument();
		expect(screen.queryByText("unsub10")).not.toBeInTheDocument();
		expect(screen.getByText(/1 - 10 of 15/)).toBeInTheDocument();

		fireEvent.click(
			screen.getByRole("button", {
				name: "Next page, unsubscribed subscribers",
			}),
		);

		expect(screen.getByText("unsub10")).toBeInTheDocument();
		expect(screen.getByText(/11 - 15 of 15/)).toBeInTheDocument();
	});

	it("resets the active list to page 1 after adding subscribers", () => {
		setSubscribers(25);
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Next page, active subscribers",
			}),
		);
		expect(screen.getByText("active10")).toBeInTheDocument();

		// Typing enables the Add button; clicking it fires the mocked onSuccess,
		// which resets the active list to page 1.
		fireEvent.change(screen.getByLabelText("Add subscribers"), {
			target: { value: "new@example.com" },
		});
		fireEvent.click(screen.getByRole("button", { name: "Add 1" }));

		expect(screen.getByText("active0")).toBeInTheDocument();
		expect(screen.queryByText("active10")).not.toBeInTheDocument();
		expect(screen.getByText(/1 - 10 of 25/)).toBeInTheDocument();
	});

	it("clamps the active page when the list shrinks so the user is never stranded", () => {
		setSubscribers(25);
		const { rerender } = render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		// Advance to the last page (page 3 = active20..active24).
		fireEvent.click(
			screen.getByRole("button", {
				name: "Next page, active subscribers",
			}),
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Next page, active subscribers",
			}),
		);
		expect(screen.getByText("active20")).toBeInTheDocument();
		expect(screen.getByText(/21 - 25 of 25/)).toBeInTheDocument();

		// The list shrinks to 12 (two pages). The view must clamp to the last
		// valid page (page 2 = active10..active11) rather than strand on an empty
		// page 3.
		setSubscribers(12);
		rerender(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		expect(screen.getByText("active10")).toBeInTheDocument();
		expect(screen.getByText("active11")).toBeInTheDocument();
		expect(screen.getByText(/11 - 12 of 12/)).toBeInTheDocument();
		expect(screen.queryByText(/of 25/)).not.toBeInTheDocument();
	});
});
