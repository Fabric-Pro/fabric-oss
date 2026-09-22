/**
 * Project Settings → Newsletter renders the release-notes gate (Fizzy #1930,
 * B6). Send now was gated at the door, but the only sign on this page was an
 * error toast after the click.
 *
 * The harness is the one the other `ProjectNewsletterSettings.*` suites use.
 */
import { render, screen } from "@testing-library/react";
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

// The gate this page reads, driven per test. The banner renders from the same
// selection, through its real component.
const gateRef = { current: null as CapabilityGateSelection | null };
vi.mock(
	"@saas/projects/components/capability-gates/useCapabilityGates",
	() => ({
		useCapabilityGate: () =>
			gateRef.current ?? { gate: null, view: null, blocked: false },
		useCapabilityGates: () => ({
			projectId: "p-1",
			suppress: vi.fn(),
			linkFor: () => null,
			codebaseRetryFor: () => undefined,
			codebaseRetrying: false,
		}),
		SNOOZE_DURATIONS: ["session", "1d", "7d", "30d", "forever"] as const,
	}),
);

import type { CapabilityGateSelection } from "@saas/projects/components/capability-gates/useCapabilityGates";
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

describe("ProjectNewsletterSettings — the release-notes gate", () => {
	it("explains the block above Send now and disables it", () => {
		gateRef.current = {
			gate: null,
			view: {
				capabilityKey: "release-notes.generate",
				state: "HARD_BLOCK",
				reasonKey: "codebase.credentials-expired",
				tone: "destructive",
				title: "reason.codebase.credentials-expired.title",
				body: "reason.codebase.credentials-expired.body",
				params: { dependency: "valid repository credentials" },
				ctaLabel: "remedy.reconnectCredential",
				ctaKind: "navigate",
				ctaTarget: "repository",
				blocksAction: true,
				dismissible: false,
				retry: {
					supported: false,
					permitted: false,
					available: false,
					targetId: null,
				},
			},
			blocked: true,
		};
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		expect(screen.getByRole("alert")).toHaveTextContent(
			"reason.codebase.credentials-expired.title",
		);
		expect(screen.getByRole("button", { name: "Send now" })).toBeDisabled();
	});

	it("leaves Send now alone when nothing is gated", () => {
		gateRef.current = null;
		render(
			<ProjectNewsletterSettings projectId="p-1" organizationId={null} />,
		);

		expect(screen.getByRole("button", { name: "Send now" })).toBeEnabled();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
