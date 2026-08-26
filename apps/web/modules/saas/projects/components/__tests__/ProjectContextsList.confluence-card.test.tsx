/**
 * Confluence INTEGRATION-card tests for ProjectContextsList
 * (confluence-project-context-source spec FR7 / D7 / Task 2.4).
 *
 * An added Confluence page is persisted as one INTEGRATION ProjectContext with
 * `metadata = { provider: "confluence", confluencePageId, sourceTitle, ... }`.
 * This surface asserts the list renders that row as a FIRST-CLASS card:
 *   1. A recognizable "Confluence" provider badge (not the generic "Integration"
 *      fallback).
 *   2. It is NOT swallowed by the Notion/Teams grouping — it renders as an
 *      individual card via the per-card `integrationProviderConfig["confluence"]`
 *      override (the map key is lowercase, matching the stored provider).
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

function makeConfluenceContext(overrides: Record<string, unknown> = {}) {
	return {
		id: "ctx_confluence_1",
		type: "INTEGRATION",
		content: "Page body content",
		sourceUrl: "https://example.atlassian.net/wiki/x",
		sourceTitle: "Release Notes",
		extractionStatus: "COMPLETED",
		extractionError: null,
		embeddedAt: new Date("2026-06-01T10:00:00Z"),
		createdAt: new Date("2026-06-01T10:00:00Z"),
		metadata: {
			provider: "confluence",
			confluencePageId: "page-1",
			spaceKey: "ENG",
			sourceTitle: "Release Notes",
			sourceUrl: "https://example.atlassian.net/wiki/x",
		},
		...overrides,
	};
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("ProjectContextsList — Confluence INTEGRATION card (FR7 / D7)", () => {
	beforeEach(() => {
		contextsListMock.mockReset();
		trackEventMock.mockReset();
	});

	it("renders an added Confluence page as a first-class card with the Confluence badge (AC7.1)", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeConfluenceContext()],
			total: 1,
			hasMore: false,
		});

		wrap(<ProjectContextsList projectId="proj_1" />);

		const title = await screen.findByText("Release Notes");
		const card = title.closest("[class*='rounded']") as HTMLElement;

		// Recognizable "Confluence" badge — not the generic "Integration" fallback.
		expect(within(card).getByText("Confluence")).toBeInTheDocument();
		expect(within(card).queryByText("Integration")).not.toBeInTheDocument();
	});

	it("does NOT swallow the confluence row into the Notion/Teams grouping (AC7.3)", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeConfluenceContext()],
			total: 1,
			hasMore: false,
		});

		wrap(<ProjectContextsList projectId="proj_1" />);

		// The page renders as its own card (title visible at top level), and there
		// is no "Notion Documents" / grouped section heading for it.
		expect(await screen.findByText("Release Notes")).toBeInTheDocument();
		expect(screen.queryByText(/Notion Document/i)).not.toBeInTheDocument();
	});
});
