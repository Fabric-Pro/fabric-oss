/**
 * Backlog INTEGRATION-card tests for ProjectContextsList
 * (unified-project-setup spec §4.5 / D8 / AC#4, Task 2.1 / 2.3).
 *
 * A connected backlog is persisted as one INTEGRATION ProjectContext with
 * `metadata = { provider: <UPPERCASE PM token>, kind: "backlog", containerName,
 * sourceTitle, ... }`. This surface asserts the list renders that row with:
 *   1. A recognizable provider label/badge (not the generic "Integration"
 *      fallback) when the provider is a known PM tool (AZURE_DEVOPS, JIRA, …).
 *   2. The board/container name as the card title (`sourceTitle`).
 *   3. The status paired with an icon + a visible label (never color-only).
 *   4. A graceful fallback to the generic Integration badge for an unknown
 *      provider string.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { render, screen, within } from "@testing-library/react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── jsdom polyfills ──────────────────────────────────────────────────────
beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
	if (typeof Element.prototype.hasPointerCapture === "undefined") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => undefined;
	}
});

// ── Module mocks ─────────────────────────────────────────────────────────

const { contextsListMock, trackEventMock } = vi.hoisted(() => ({
	contextsListMock: vi.fn(),
	trackEventMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { contexts: {} } },
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				list: {
					queryOptions: ({
						input,
						refetchInterval,
					}: {
						input: unknown;
						refetchInterval?: unknown;
					}) => ({
						queryKey: ["projects.contexts.list", input] as const,
						queryFn: () => contextsListMock(input),
						refetchInterval,
					}),
					queryKey: ({ input }: { input: unknown }) => [
						"projects.contexts.list",
						input,
					],
				},
				delete: { call: vi.fn() },
				createDownloadUrl: { call: vi.fn() },
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		basePath: "/app",
	}),
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: trackEventMock }),
}));

vi.mock("next-intl", () => {
	function makeT() {
		const t = (key: string) => key;
		(t as unknown as { raw: (k: string) => unknown }).raw = (
			k: string,
		) => ({
			label: `${k}.label`,
			warning: `${k}.warning`,
		});
		return t;
	}
	return {
		useTranslations: () => makeT(),
		useLocale: () => "en",
		useFormatter: () => ({
			dateTime: (d: Date) => d.toISOString(),
			number: (n: number) => String(n),
			relativeTime: (d: Date) => d.toISOString(),
		}),
		useMessages: () => ({}),
		NextIntlClientProvider: ({ children }: { children: React.ReactNode }) =>
			children,
	};
});

vi.mock("next/link", () => ({
	default: ({
		children,
		href,
		...rest
	}: {
		children: React.ReactNode;
		href: string;
	} & Record<string, unknown>) => (
		<a href={href} {...rest}>
			{children}
		</a>
	),
}));

vi.mock("../ContextUploaderDialog", () => ({
	ContextUploaderDialog: () => null,
}));
vi.mock("../DownloadAllContextsButton", () => ({
	DownloadAllContextsButton: () => null,
}));
vi.mock("../ProjectSectionHero", () => ({
	ProjectSectionHero: () => null,
}));

import { ProjectContextsList } from "../ProjectContextsList";

// ── Helpers ──────────────────────────────────────────────────────────────

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<FeatureFlagProvider value={{}}>{ui}</FeatureFlagProvider>
		</QueryClientProvider>,
	);
}

function makeBacklogContext(
	metadata: Record<string, unknown>,
	overrides: Record<string, unknown> = {},
) {
	return {
		id: "ctx_backlog_1",
		type: "INTEGRATION",
		content: "",
		sourceUrl: null,
		sourceTitle: null,
		extractionStatus: null,
		extractionError: null,
		embeddedAt: null,
		createdAt: new Date("2026-05-27T10:00:00Z"),
		metadata,
		...overrides,
	};
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("ProjectContextsList — backlog INTEGRATION card (D8 / AC#4)", () => {
	beforeEach(() => {
		contextsListMock.mockReset();
		trackEventMock.mockReset();
	});

	it("renders a connected Azure DevOps backlog with a recognizable label + board title", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeBacklogContext({
					provider: "AZURE_DEVOPS",
					kind: "backlog",
					containerId: "board-7",
					containerName: "Mobile Board",
					sourceTitle: "Mobile Board",
				}),
			],
			total: 1,
			hasMore: false,
		});

		wrap(<ProjectContextsList projectId="proj_1" />);

		// The board/container name is the card title.
		const title = await screen.findByText("Mobile Board");
		const card = title.closest("[class*='rounded']") as HTMLElement;

		// Recognizable provider label (NOT the generic "Integration" fallback).
		expect(within(card).getByText("Azure DevOps")).toBeInTheDocument();
	});

	it("renders a connected Jira backlog with the Jira label", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeBacklogContext({
					provider: "JIRA",
					kind: "backlog",
					containerId: "PROJ",
					containerName: "Platform",
					sourceTitle: "Platform",
				}),
			],
			total: 1,
			hasMore: false,
		});

		wrap(<ProjectContextsList projectId="proj_1" />);

		expect(await screen.findByText("Platform")).toBeInTheDocument();
		expect(screen.getByText("Jira")).toBeInTheDocument();
	});

	it("pairs the integration status with an icon + visible 'Connected' label (never color-only)", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeBacklogContext({
					provider: "GITLAB",
					kind: "backlog",
					containerId: "42",
					containerName: "infra/platform",
					sourceTitle: "infra/platform",
				}),
			],
			total: 1,
			hasMore: false,
		});

		wrap(<ProjectContextsList projectId="proj_1" />);

		const title = await screen.findByText("infra/platform");
		const card = title.closest("[class*='rounded']") as HTMLElement;
		// Status carries a text label, not only a color — a11y requirement.
		// "Connected" replaced "Live": a backlog link is connected, and "Live"
		// both overstated that and clashed with the URL sources' real Live mode.
		expect(within(card).getByText("Connected")).toBeInTheDocument();
		expect(within(card).queryByText("Live")).not.toBeInTheDocument();
		expect(within(card).getByText("GitLab")).toBeInTheDocument();
	});

	it("falls back to the generic 'Integration' badge for an unknown provider string", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeBacklogContext({
					provider: "SOME_UNKNOWN_PM",
					kind: "backlog",
					containerId: "x",
					containerName: "Mystery Board",
					sourceTitle: "Mystery Board",
				}),
			],
			total: 1,
			hasMore: false,
		});

		wrap(<ProjectContextsList projectId="proj_1" />);

		const title = await screen.findByText("Mystery Board");
		const card = title.closest("[class*='rounded']") as HTMLElement;
		// Unknown provider → the badge is the raw provider string (existing
		// generic-INTEGRATION behavior), and the card still renders.
		expect(within(card).getByText("SOME_UNKNOWN_PM")).toBeInTheDocument();
	});

	// Google Docs are INTEGRATION contexts that DO run the extraction pipeline.
	// The old blanket "Live" chip meant a doc that failed to extract still
	// advertised itself as fine — the exact black box the Job Hub work exists
	// to remove.
	it("reports the real extraction status for a Google Doc, not a blanket status", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeBacklogContext(
					{
						source: "google-docs",
						googleFileId: "gdoc-1",
						sourceTitle: "Q3 Requirements",
					},
					{
						sourceTitle: "Q3 Requirements",
						extractionStatus: "FAILED",
						extractionError: "Permission denied",
					},
				),
			],
			total: 1,
			hasMore: false,
		});

		wrap(<ProjectContextsList projectId="proj_1" />);

		const title = await screen.findByText("Q3 Requirements");
		const card = title.closest("[class*='rounded']") as HTMLElement;
		expect(within(card).getByText("Failed")).toBeInTheDocument();
		expect(within(card).queryByText("Connected")).not.toBeInTheDocument();
	});

	it("shows the Embedded chip on an embedded Google Doc", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeBacklogContext(
					{
						source: "google-docs",
						googleFileId: "gdoc-2",
						sourceTitle: "Design Notes",
					},
					{
						sourceTitle: "Design Notes",
						extractionStatus: "COMPLETED",
						embeddedAt: new Date("2026-05-27T11:00:00Z"),
					},
				),
			],
			total: 1,
			hasMore: false,
		});

		wrap(<ProjectContextsList projectId="proj_1" />);

		const title = await screen.findByText("Design Notes");
		const card = title.closest("[class*='rounded']") as HTMLElement;
		// The chip used to be suppressed for every integration.
		expect(within(card).getByText("Embedded")).toBeInTheDocument();
	});
});
