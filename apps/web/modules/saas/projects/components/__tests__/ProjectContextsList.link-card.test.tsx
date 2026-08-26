/**
 * LINK-card tests for ProjectContextsList — PM-simplified surface.
 *
 * Spec: post-staging PM feedback strips the LINK card down to match the
 * sibling Backlog / Meeting Transcripts cards. Edit controls (scope,
 * refresh cadence, max pages, label) moved to the dedicated full-view
 * page's right sidebar; the card itself carries only:
 *   - The chain Link icon avatar + title + Link chip.
 *   - An inline status row (✓ Indexed  ✓ Embedded  Last synced X ago)
 *     using plain colored text + lucide icons, no chip backgrounds.
 *   - The URL link.
 *   - A right-side action cluster with exactly two icon buttons:
 *       Eye (→ full view) and More (Sync now + Delete).
 *
 * Scope:
 *  1. Renders inline status row with ✓ Indexed for COMPLETED.
 *  2. ✓ Embedded appears alongside Indexed when `embeddedAt` is set.
 *  3. FAILED renders red ✗ Failed inline (no chip background).
 *  4. PENDING / EXTRACTING render the amber ↻ Crawling… inline.
 *  5. Eye button links to the dedicated full-view route.
 *  6. More menu carries exactly Sync now + Delete items.
 *  7. More → Sync now fires `resyncUrlSource`.
 *  8. More → Delete fires the delete mutation.
 *  9. The legacy chip toolbar (scope-chip, refresh-chip, resync-now) is gone.
 * 10. Editorial-aesthetic regression scan — no gradient pills / blur / hex.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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
	if (typeof Element.prototype.releasePointerCapture === "undefined") {
		Element.prototype.releasePointerCapture = () => undefined;
	}
	if (typeof Element.prototype.setPointerCapture === "undefined") {
		Element.prototype.setPointerCapture = () => undefined;
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => undefined;
	}
});

// ── Module mocks ─────────────────────────────────────────────────────────

const {
	contextsListMock,
	resyncMock,
	deleteMock,
	downloadUrlMock,
	trackEventMock,
} = vi.hoisted(() => ({
	contextsListMock: vi.fn(),
	resyncMock: vi.fn(),
	deleteMock: vi.fn(),
	downloadUrlMock: vi.fn(),
	trackEventMock: vi.fn(),
}));

// Context Source Type Labeling (#1888) is flag-gated; these suites pin the
// flag OFF so the menus keep exactly the legacy Sync/Download/Delete items.
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: {
				resyncUrlSource: (i: unknown) => resyncMock(i),
			},
		},
	},
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
				delete: {
					call: (i: unknown) => deleteMock(i),
				},
				createDownloadUrl: {
					call: (i: unknown) => downloadUrlMock(i),
				},
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

// `next-intl`'s default global mock in vitest.setup.ts returns a plain
// function from `useTranslations`. The LINK card branch needs `.raw(...)`
// for the destructive-delete tooltip copy, so we extend the mock here.
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
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

function makeLinkContext(overrides: Record<string, unknown> = {}) {
	return {
		id: "ctx_1",
		type: "LINK",
		sourceUrl: "https://example.com/docs",
		sourceTitle: "Example Docs",
		extractionStatus: "COMPLETED",
		extractionError: null,
		urlScope: "PATH_PREFIX",
		urlMaxPages: 100,
		urlRefreshMode: "ONCE",
		urlLastSyncedAt: new Date("2026-05-13T10:00:00Z"),
		createdAt: new Date("2026-05-12T10:00:00Z"),
		embeddedAt: null,
		metadata: { sourceTitle: "Example Docs" },
		...overrides,
	};
}

// ── Tests ────────────────────────────────────────────────────────────────

describe("ProjectContextsList — LINK card (PM-simplified)", () => {
	beforeEach(() => {
		contextsListMock.mockReset();
		resyncMock.mockReset();
		deleteMock.mockReset();
		downloadUrlMock.mockReset();
		trackEventMock.mockReset();
	});

	it("renders inline ✓ Indexed status for COMPLETED extractionStatus", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeLinkContext()],
			total: 1,
			hasMore: false,
		});

		wrap(<ProjectContextsList projectId="proj_1" />);

		const card = await screen.findByTestId("link-card-ctx_1");
		const indexed = within(card).getByTestId("link-status-indexed");
		expect(indexed).toHaveTextContent("Indexed");
		// Status row uses the inline-text pattern, not the chip background:
		// the emerald success token lives on the text itself.
		expect(indexed.className).toMatch(/text-success/);
	});

	it("renders ✓ Embedded alongside Indexed when embeddedAt is set", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeLinkContext({
					embeddedAt: new Date("2026-05-13T10:05:00Z"),
				}),
			],
			total: 1,
			hasMore: false,
		});

		wrap(<ProjectContextsList projectId="proj_1" />);

		const card = await screen.findByTestId("link-card-ctx_1");
		expect(
			within(card).getByTestId("link-status-indexed"),
		).toBeInTheDocument();
		expect(
			within(card).getByTestId("link-status-embedded"),
		).toHaveTextContent("Embedded");
	});

	it("renders inline ✗ Failed status (destructive token) for FAILED extractionStatus", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeLinkContext({
					id: "ctx_fail",
					extractionStatus: "FAILED",
					extractionError: "Firecrawl returned 402: quota exceeded",
				}),
			],
			total: 1,
			hasMore: false,
		});

		wrap(<ProjectContextsList projectId="proj_1" />);

		const card = await screen.findByTestId("link-card-ctx_fail");
		const failed = within(card).getByTestId("link-status-failed");
		expect(failed).toHaveTextContent("Failed");
		expect(failed.className).toMatch(/text-destructive/);
		// The "Last attempted X ago" copy replaces the success-state "Last synced…"
		expect(card.textContent).toMatch(/Last attempted/);
	});

	it("renders inline Processing… status (highlight/amber) for PENDING / EXTRACTING", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeLinkContext({
					id: "ctx_pending",
					extractionStatus: "EXTRACTING",
					urlLastSyncedAt: null,
				}),
			],
			total: 1,
			hasMore: false,
		});

		wrap(<ProjectContextsList projectId="proj_1" />);

		const card = await screen.findByTestId("link-card-ctx_pending");
		const crawling = within(card).getByTestId("link-status-crawling");
		expect(crawling).toHaveTextContent("Processing");
		expect(crawling.className).toMatch(/text-highlight/);
	});

	it("Eye icon (right-side cluster) links to the dedicated full-view route", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeLinkContext()],
			total: 1,
			hasMore: false,
		});

		wrap(<ProjectContextsList projectId="proj_1" />);

		const card = await screen.findByTestId("link-card-ctx_1");
		const eye = within(card).getByTestId("link-card-open-full-view");
		// Personal context (no org slug in the mock) routes to /app/projects/...
		expect(eye).toHaveAttribute(
			"href",
			"/app/projects/proj_1/contexts/ctx_1",
		);
		expect(eye).toHaveAttribute("aria-label", "View URL source");
	});

	it("More menu shows Sync now + Download + Delete items", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeLinkContext()],
			total: 1,
			hasMore: false,
		});
		const user = userEvent.setup();
		wrap(<ProjectContextsList projectId="proj_1" />);

		const card = await screen.findByTestId("link-card-ctx_1");
		await user.click(within(card).getByTestId("link-card-more"));

		const syncItem = await screen.findByTestId("link-card-sync-now");
		const downloadItem = await screen.findByTestId("link-card-download");
		const deleteItem = await screen.findByTestId("link-card-delete");
		expect(syncItem).toHaveTextContent("Sync now");
		expect(downloadItem).toHaveTextContent("Download");
		expect(deleteItem).toHaveTextContent("Delete");
	});

	it("More → Download triggers createDownloadUrl + browser download", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeLinkContext()],
			total: 1,
			hasMore: false,
		});
		downloadUrlMock.mockResolvedValue({
			url: "https://s3.test/presigned-link.md",
			filename: "example-docs-ctx_1.md",
			expiresAt: new Date(Date.now() + 300_000).toISOString(),
			contextClass: "B",
		});
		const user = userEvent.setup();

		// Spy on anchor.click() so we can assert the browser download
		// path fires without actually navigating jsdom.
		const clickSpy = vi
			.spyOn(HTMLAnchorElement.prototype, "click")
			.mockImplementation(() => undefined);

		wrap(<ProjectContextsList projectId="proj_1" />);

		const card = await screen.findByTestId("link-card-ctx_1");
		await user.click(within(card).getByTestId("link-card-more"));
		await user.click(await screen.findByTestId("link-card-download"));

		await waitFor(() => {
			expect(downloadUrlMock).toHaveBeenCalledTimes(1);
		});
		expect(downloadUrlMock).toHaveBeenCalledWith({
			contextId: "ctx_1",
			projectId: "proj_1",
			organizationId: null,
		});
		await waitFor(() => {
			expect(clickSpy).toHaveBeenCalled();
		});
		clickSpy.mockRestore();
	});

	it("More → Sync now fires resyncUrlSource with the context id", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeLinkContext()],
			total: 1,
			hasMore: false,
		});
		resyncMock.mockResolvedValue({
			contextId: "ctx_1",
			status: "EXTRACTING",
		});
		const user = userEvent.setup();
		wrap(<ProjectContextsList projectId="proj_1" />);

		const card = await screen.findByTestId("link-card-ctx_1");
		await user.click(within(card).getByTestId("link-card-more"));
		await user.click(await screen.findByTestId("link-card-sync-now"));

		await waitFor(() => {
			expect(resyncMock).toHaveBeenCalledTimes(1);
		});
		expect(resyncMock).toHaveBeenCalledWith({
			contextId: "ctx_1",
			projectId: "proj_1",
			organizationId: null,
		});
	});

	it("More → Delete fires the delete mutation", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeLinkContext()],
			total: 1,
			hasMore: false,
		});
		deleteMock.mockResolvedValue({ ok: true });
		const user = userEvent.setup();
		wrap(<ProjectContextsList projectId="proj_1" />);

		const card = await screen.findByTestId("link-card-ctx_1");
		await user.click(within(card).getByTestId("link-card-more"));
		await user.click(await screen.findByTestId("link-card-delete"));

		await waitFor(() => {
			expect(deleteMock).toHaveBeenCalledTimes(1);
		});
	});

	it("legacy chip toolbar (scope/refresh/resync chips) is removed from the card", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeLinkContext()],
			total: 1,
			hasMore: false,
		});

		wrap(<ProjectContextsList projectId="proj_1" />);

		const card = await screen.findByTestId("link-card-ctx_1");
		// None of the legacy toolbar handles survive on the card.
		expect(within(card).queryByTestId("scope-chip")).toBeNull();
		expect(within(card).queryByTestId("refresh-chip")).toBeNull();
		expect(within(card).queryByTestId("resync-now")).toBeNull();
		expect(within(card).queryByTestId("failed-badge")).toBeNull();
	});

	it("LINK card branch contains no banned editorial-aesthetic class fragments", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [makeLinkContext()],
			total: 1,
			hasMore: false,
		});
		wrap(<ProjectContextsList projectId="proj_1" />);

		const card = await screen.findByTestId("link-card-ctx_1");
		const html = card.outerHTML;
		const banned = [
			/from-\w+-500/,
			/to-\w+-500/,
			/bg-gradient-to-/,
			/backdrop-blur/,
			/#[0-9a-fA-F]{6}\b/,
			/group-hover:scale-110/,
		];
		for (const pattern of banned) {
			expect(
				pattern.test(html),
				`LINK card must not contain ${pattern}`,
			).toBe(false);
		}
	});
});

// ──────────────────────────────────────────────────────────────────────
// Polling cap (sub-bug 3 of commit 1 of 3 on
// `feat/url-context-polish-and-path-prefix`):
//
// The list polls every 2s while ANY row is PENDING/EXTRACTING. Each
// response is ~765 KB, so a stuck row burns ~14 MB per session at the
// worst-case 30-minute idle. We cap the polling window at 5 minutes
// from `createdAt`. After that the row is treated as stale; the user
// can manually re-sync to recover.
//
// `shouldStopPolling` is a pure boundary check exported for direct
// unit-testing — no React-Query plumbing needed.
// ──────────────────────────────────────────────────────────────────────
import {
	MAX_POLL_DURATION_MS,
	shouldStopPolling,
} from "../ProjectContextsList";

describe("ProjectContextsList — polling cap (sub-bug 3)", () => {
	it("exposes a 5-minute cap", () => {
		expect(MAX_POLL_DURATION_MS).toBe(5 * 60 * 1000);
	});

	it("returns false for a freshly created row (just created, 0 elapsed)", () => {
		const now = 1_700_000_000_000;
		expect(shouldStopPolling(now, now)).toBe(false);
	});

	it("returns false just inside the cap (4m 59s elapsed)", () => {
		const now = 1_700_000_000_000;
		const createdAt = now - (5 * 60 * 1000 - 1_000);
		expect(shouldStopPolling(createdAt, now)).toBe(false);
	});

	it("returns true exactly at the cap (5m elapsed)", () => {
		const now = 1_700_000_000_000;
		const createdAt = now - 5 * 60 * 1000;
		expect(shouldStopPolling(createdAt, now)).toBe(true);
	});

	it("returns true past the cap (10m elapsed)", () => {
		const now = 1_700_000_000_000;
		const createdAt = now - 10 * 60 * 1000;
		expect(shouldStopPolling(createdAt, now)).toBe(true);
	});

	it("returns false for clock-skewed future createdAt (defensive: keep polling normally)", () => {
		const now = 1_700_000_000_000;
		const createdAt = now + 60_000; // 1 minute in the future
		expect(shouldStopPolling(createdAt, now)).toBe(false);
	});
});
