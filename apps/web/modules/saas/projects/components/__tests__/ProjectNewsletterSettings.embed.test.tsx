import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Minimal next-intl mock: return the bare key so we can assert against the key
// (matches the EmbedSnippet.test.tsx convention for namespaced lookups).
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

// Capture the update mutation's input so we can assert the toggle wiring.
const updateMutate = vi.fn();
const regenerateMutate = vi.fn();

// The orpc query-utils proxy: each procedure exposes queryOptions/queryKey/
// mutationOptions. We only need stable identities + the mutationOptions object
// (the mocked useMutation below returns a `mutate` keyed off which options it got).
vi.mock("@shared/lib/orpc-query-utils", () => {
	const q = (input: unknown) => ({ input, queryKey: [input] });
	return {
		orpc: {
			newsletter: {
				settings: {
					get: {
						queryOptions: (o: { input: unknown }) => ({
							__q: "settings",
							...o,
						}),
						queryKey: (o: { input: unknown }) => [
							"settings",
							o.input,
						],
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
					// Declared unconditionally by the component (the
					// lazily-enabled per-channel chat delivery panel, Fizzy
					// #2013) so the stub has to exist even though no row is
					// expanded in these tests.
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
	};
});

vi.mock("@shared/lib/orpc-client", () => ({ orpcClient: {} }));

// Drive each useQuery by the marker we stamped in queryOptions above.
const queryData: Record<string, unknown> = {};
vi.mock("@tanstack/react-query", () => ({
	useQuery: (opts: { __q?: string }) => ({
		data: queryData[opts.__q ?? ""],
		isLoading: false,
	}),
	useMutation: (opts: {
		__m?: string;
		mutationFn?: () => Promise<unknown>;
	}) => ({
		isPending: false,
		mutate: (...args: unknown[]) => {
			if (opts.__m === "update") {
				updateMutate(...args);
			} else if (opts.__m === "regenerate") {
				regenerateMutate(...args);
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

describe("ProjectNewsletterSettings — embed section", () => {
	it("renders the Embed-on-your-site section heading", () => {
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		expect(
			screen.getByText("newsletter.embed.widgetHeading"),
		).toBeInTheDocument();
	});

	it("shows the disabled hint and no snippet when the widget is off", () => {
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		expect(
			screen.getByText("newsletter.embed.disabledHint"),
		).toBeInTheDocument();
		expect(
			screen.queryByText(/embed\/release-notes/),
		).not.toBeInTheDocument();
	});

	it("toggling the widget Switch calls update with publicWidgetEnabled", () => {
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		// The widget enable Switch is labelled with the enableLabel key.
		fireEvent.click(
			screen.getByRole("switch", {
				name: "newsletter.embed.enableLabel",
			}),
		);
		expect(updateMutate).toHaveBeenCalledWith({
			projectId: "p-1",
			organizationId: null,
			publicWidgetEnabled: true,
		});
	});

	it("renders the snippet + copy control once enabled with a token", () => {
		setSettings({
			publicWidgetEnabled: true,
			publicEmbedToken: "TOK123",
		});
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		const code = document.getElementById("widget-snippet");
		expect(code?.textContent).toContain(
			"https://app.example.com/embed/release-notes?t=TOK123",
		);
		expect(
			screen.getByRole("button", { name: "newsletter.embed.copy" }),
		).toBeInTheDocument();
	});

	it("Save appearance sends the theme/accent/config payload", () => {
		setSettings({
			publicWidgetEnabled: true,
			publicEmbedToken: "TOK123",
			publicWidgetTheme: "dark",
			publicWidgetAccent: "#123456",
			publicWidgetConfig: {
				font: "serif",
				radius: 8,
				width: "640",
				density: "compact",
			},
		});
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		fireEvent.click(
			screen.getByRole("button", { name: "newsletter.embed.save" }),
		);
		expect(updateMutate).toHaveBeenCalledWith({
			projectId: "p-1",
			organizationId: null,
			publicWidgetTheme: "dark",
			publicWidgetAccent: "#123456",
			publicWidgetConfig: {
				font: "serif",
				radius: 8,
				width: "640",
				density: "compact",
			},
		});
	});

	it("flags an invalid accent hex with an inline error + aria-invalid", () => {
		setSettings({
			publicWidgetEnabled: true,
			publicEmbedToken: "TOK123",
			publicWidgetAccent: "not-a-hex",
		});
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);
		expect(
			screen.getByText("newsletter.embed.accentInvalid"),
		).toBeInTheDocument();
		const hexInput = screen.getByLabelText(
			"newsletter.embed.accentHexLabel",
		);
		expect(hexInput).toHaveAttribute("aria-invalid", "true");
	});
});
