/**
 * Component tests for `ContextPendingItemsList` (Group 8 of the unified
 * context-uploader wizard spec).
 *
 * Spec:
 * - fabric/specs/2026-05-23-unified-context-uploader-wizard/spec.md §7.5
 * - fabric/specs/2026-05-23-unified-context-uploader-wizard/tasks.md Group 8
 *
 * Scope (per tasks.md 8.5):
 *   (a) renders rows for each item type (FILE / LINK / TEXT / INTEGRATION).
 *   (b) polling refetches every 2s while PENDING/EXTRACTING rows exist.
 *   (c) polling stops after the 5min cap.
 *   (d) retry CTA fires `resyncUrlSource` for LINK rows
 *       (LINK rows route through the shared `<UrlContextCard />` →
 *       `<LinkContextManagePanel />` "Sync now" item — verified via testid).
 *   (e) delete fires the delete mutation (procedural — proves the wiring).
 *   (f) empty state renders nothing.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

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

const {
	contextsListMock,
	deleteMock,
	resyncMock,
	trackEventMock,
	invalidateQueriesMock,
	refetchIntervalCapturer,
} = vi.hoisted(() => ({
	contextsListMock: vi.fn(),
	deleteMock: vi.fn(),
	resyncMock: vi.fn(),
	trackEventMock: vi.fn(),
	invalidateQueriesMock: vi.fn(),
	// Capturer for the `refetchInterval` callback the component hands to
	// `useQuery` through our `orpc.projects.contexts.list.queryOptions`
	// mock. Tests (b) + (c) pull `.last` to assert directly on the poll
	// cadence + cap without spinning up react-query's timer loop.
	refetchIntervalCapturer: { last: null as unknown },
}));

// Context Source Type Labeling (#1888) is flag-gated; pinned OFF here so
// the LINK row menu keeps exactly the legacy items these tests assert.
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: {
				delete: (i: unknown) => deleteMock(i),
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
					}) => {
						// Capture the callback so tests (b)+(c) can verify
						// the poll cadence + cap deterministically.
						refetchIntervalCapturer.last = refetchInterval;
						return {
							queryKey: [
								"projects.contexts.list",
								input,
							] as const,
							queryFn: () => contextsListMock(input),
							refetchInterval,
						};
					},
					queryKey: ({ input }: { input: unknown }) => [
						"projects.contexts.list",
						input,
					],
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: trackEventMock }),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		basePath: "/app",
	}),
}));

// The LINK card reuses `<UrlContextCard />` from `ProjectContextsList.tsx`,
// which itself nests `<LinkContextManagePanel />` (uses `next/link` for
// the "View URL source" anchor). Mock `next/link` so the test renders an
// inline anchor and we can assert on the More-menu Sync-now item.
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

// `next-intl`'s default global mock returns a plain function from
// `useTranslations`. `LinkContextManagePanel` calls `t(...)` directly
// (no `.raw(...)` lookup needed). The default `(key) => key` is fine —
// no override required.

import {
	ContextPendingItemsList,
	MAX_POLL_DURATION_MS,
} from "../ContextPendingItemsList";

// ── Helpers ──────────────────────────────────────────────────────────────

function wrap(
	ui: React.ReactElement,
	{ client }: { client?: QueryClient } = {},
) {
	const resolvedClient =
		client ??
		new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
	const originalInvalidate =
		resolvedClient.invalidateQueries.bind(resolvedClient);
	resolvedClient.invalidateQueries = ((args: unknown) => {
		invalidateQueriesMock(args);
		return originalInvalidate(args as never);
	}) as typeof resolvedClient.invalidateQueries;
	return {
		client: resolvedClient,
		...render(
			<QueryClientProvider client={resolvedClient}>
				{ui}
			</QueryClientProvider>,
		),
	};
}

const FIXED_NOW = 1_700_000_000_000;

function makeRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "ctx_other_1",
		type: "FILE",
		sourceTitle: null,
		sourceUrl: null,
		originalFilename: "doc.pdf",
		extractionStatus: "COMPLETED",
		extractionError: null,
		createdAt: new Date(FIXED_NOW - 5_000).toISOString(),
		metadata: {},
		...overrides,
	};
}

function makeLinkRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "ctx_link_1",
		type: "LINK",
		sourceUrl: "https://example.com/docs",
		sourceTitle: "Example Docs",
		extractionStatus: "EXTRACTING",
		extractionError: null,
		urlScope: "PATH_PREFIX",
		urlMaxPages: 100,
		urlRefreshMode: "ONCE",
		urlLastSyncedAt: null,
		createdAt: new Date(FIXED_NOW - 5_000).toISOString(),
		embeddedAt: null,
		metadata: { sourceTitle: "Example Docs" },
		...overrides,
	};
}

afterEach(() => {
	// Defensive: timer mode is set on a per-test basis below; reset.
	vi.useRealTimers();
});

describe("ContextPendingItemsList", () => {
	beforeEach(() => {
		contextsListMock.mockReset();
		deleteMock.mockReset();
		resyncMock.mockReset();
		trackEventMock.mockReset();
		invalidateQueriesMock.mockReset();
		refetchIntervalCapturer.last = null;
	});

	// ── (a) renders rows for each item type ────────────────────────────
	it("renders one row per context, each type-appropriate", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeRow({
					id: "ctx_file",
					type: "FILE",
					originalFilename: "spec.pdf",
				}),
				makeRow({
					id: "ctx_text",
					type: "TEXT",
					sourceTitle: "Brain-dump",
					originalFilename: null,
				}),
				makeLinkRow({ id: "ctx_link_a" }),
				makeRow({
					id: "ctx_integration",
					type: "INTEGRATION",
					sourceTitle: "Slack #general",
					originalFilename: null,
					metadata: { provider: "SLACK", channelName: "general" },
				}),
			],
			total: 4,
			hasMore: false,
		});

		wrap(
			<ContextPendingItemsList
				projectId="proj_1"
				organizationId={null}
			/>,
		);

		// FILE row — "Other" branch
		const fileRow = await screen.findByTestId("pending-row-ctx_file");
		expect(within(fileRow).getByText("spec.pdf")).toBeInTheDocument();
		expect(within(fileRow).getByText("File")).toBeInTheDocument();

		// TEXT row — "Other" branch
		const textRow = await screen.findByTestId("pending-row-ctx_text");
		expect(within(textRow).getByText("Brain-dump")).toBeInTheDocument();
		expect(within(textRow).getByText("Text")).toBeInTheDocument();

		// LINK row — routes through the shared `<UrlContextCard />`. The
		// post-creation surface's testid is `link-card-{contextId}` per
		// `ProjectContextsList.tsx`. Same DOM id appears here verbatim
		// because we reuse the same component.
		expect(
			await screen.findByTestId("link-card-ctx_link_a"),
		).toBeInTheDocument();

		// INTEGRATION row — "Other" branch
		const intRow = await screen.findByTestId("pending-row-ctx_integration");
		expect(within(intRow).getByText("Slack #general")).toBeInTheDocument();
		expect(within(intRow).getByText("Integration")).toBeInTheDocument();

		// All four rows are inside the same `<ul>` list with the a11y
		// label — proves the list-semantics for SR users.
		const list = screen.getByTestId("pending-items-list");
		expect(list).toHaveAttribute("aria-label", "Added context items");
	});

	// ── (b) polling refetches every 2s while PENDING/EXTRACTING rows exist ─
	//
	// We avoid `vi.useFakeTimers()` here because react-query's internal
	// scheduler + `@testing-library/react`'s `waitFor` both interact with
	// real timers; faking causes the test runner to deadlock on `waitFor`.
	// Instead we capture the `refetchInterval` callback the component passes
	// to `useQuery` (via our `orpc.projects.contexts.list.queryOptions` mock)
	// and assert on its return value directly. The callback is exactly the
	// same one react-query polls with at runtime, so verifying it returns
	// `2000` for a fresh in-progress row is equivalent to verifying the
	// poll cadence end-to-end without the timer interplay.
	it("refetchInterval returns 2000ms while any row is PENDING/EXTRACTING (poll cadence)", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeRow({
					id: "ctx_extracting",
					type: "FILE",
					extractionStatus: "EXTRACTING",
					createdAt: new Date(FIXED_NOW - 1_000).toISOString(),
				}),
			],
			total: 1,
			hasMore: false,
		});

		wrap(
			<ContextPendingItemsList
				projectId="proj_1"
				organizationId={null}
			/>,
		);

		// Wait for the component to mount + the first fetch to resolve so
		// the mocked `orpc.projects.contexts.list.queryOptions` has been
		// called with the live `refetchInterval` callback.
		await waitFor(() => {
			expect(refetchIntervalCapturer.last).not.toBeNull();
		});

		const intervalFn = refetchIntervalCapturer.last as (q: {
			state: {
				data: {
					contexts: Array<{
						extractionStatus: string;
						createdAt: string;
					}>;
				};
			};
		}) => number | false;

		// Mock-Date.now so the elapsed-time check inside the callback is
		// deterministic (no flake on slow CI). We restore it at the end.
		const realNow = Date.now;
		Date.now = () => FIXED_NOW;
		try {
			// Fresh EXTRACTING row → callback returns the 2s poll cadence.
			const intervalForFresh = intervalFn({
				state: {
					data: {
						contexts: [
							{
								extractionStatus: "EXTRACTING",
								createdAt: new Date(
									FIXED_NOW - 1_000,
								).toISOString(),
							},
						],
					},
				},
			});
			expect(intervalForFresh).toBe(2000);

			// All-terminal data → callback returns `false` (stop polling).
			const intervalForTerminal = intervalFn({
				state: {
					data: {
						contexts: [
							{
								extractionStatus: "COMPLETED",
								createdAt: new Date(
									FIXED_NOW - 1_000,
								).toISOString(),
							},
						],
					},
				},
			});
			expect(intervalForTerminal).toBe(false);
		} finally {
			Date.now = realNow;
		}
	});

	// ── (c) polling stops after the 5min cap ────────────────────────────
	//
	// Same captured-callback strategy as (b): verify that the
	// `refetchInterval` returns `false` for a row whose `createdAt` is past
	// `MAX_POLL_DURATION_MS`. This proves the cap is honored without
	// running the live react-query timer loop.
	it("refetchInterval returns false once a PENDING/EXTRACTING row crosses MAX_POLL_DURATION_MS", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeRow({
					id: "ctx_stale",
					type: "FILE",
					extractionStatus: "EXTRACTING",
					createdAt: new Date(
						FIXED_NOW - MAX_POLL_DURATION_MS - 1_000,
					).toISOString(),
				}),
			],
			total: 1,
			hasMore: false,
		});

		wrap(
			<ContextPendingItemsList
				projectId="proj_1"
				organizationId={null}
			/>,
		);

		await waitFor(() => {
			expect(refetchIntervalCapturer.last).not.toBeNull();
		});

		const intervalFn = refetchIntervalCapturer.last as (q: {
			state: {
				data: {
					contexts: Array<{
						extractionStatus: string;
						createdAt: string;
					}>;
				};
			};
		}) => number | false;

		const realNow = Date.now;
		Date.now = () => FIXED_NOW;
		try {
			// Row past the cap — even though it's EXTRACTING, the callback
			// should return `false` so react-query stops polling. This is
			// the contract from `ProjectContextsList.tsx`'s polling cap.
			const result = intervalFn({
				state: {
					data: {
						contexts: [
							{
								extractionStatus: "EXTRACTING",
								createdAt: new Date(
									FIXED_NOW - MAX_POLL_DURATION_MS - 1_000,
								).toISOString(),
							},
						],
					},
				},
			});
			expect(result).toBe(false);

			// And just inside the cap: still polls.
			const insideCap = intervalFn({
				state: {
					data: {
						contexts: [
							{
								extractionStatus: "EXTRACTING",
								createdAt: new Date(
									FIXED_NOW - (MAX_POLL_DURATION_MS - 5_000),
								).toISOString(),
							},
						],
					},
				},
			});
			expect(insideCap).toBe(2000);
		} finally {
			Date.now = realNow;
		}
	});

	// ── (d) retry CTA fires resyncUrlSource for LINK rows ──────────────
	it("More → Sync now on a LINK row fires resyncUrlSource with the contextId", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeLinkRow({
					id: "ctx_link_retry",
					extractionStatus: "COMPLETED",
				}),
			],
			total: 1,
			hasMore: false,
		});
		resyncMock.mockResolvedValue({
			contextId: "ctx_link_retry",
			status: "EXTRACTING",
		});

		const user = userEvent.setup();
		wrap(
			<ContextPendingItemsList
				projectId="proj_1"
				organizationId={null}
			/>,
		);

		// LINK rows render via the shared `<UrlContextCard />`, which nests
		// `<LinkContextManagePanel />`. The More menu carries the
		// `link-card-sync-now` testid (verbatim from the post-creation
		// surface — that's the whole point of the shared component).
		const card = await screen.findByTestId("link-card-ctx_link_retry");
		await user.click(within(card).getByTestId("link-card-more"));
		await user.click(await screen.findByTestId("link-card-sync-now"));

		await waitFor(() => {
			expect(resyncMock).toHaveBeenCalledTimes(1);
		});
		expect(resyncMock).toHaveBeenCalledWith({
			contextId: "ctx_link_retry",
			projectId: "proj_1",
			organizationId: null,
		});
	});

	// ── (e) delete fires the delete mutation ───────────────────────────
	it("Delete button on an 'Other' row fires the delete mutation", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [
				makeRow({
					id: "ctx_to_delete",
					type: "FILE",
					originalFilename: "trash.pdf",
				}),
			],
			total: 1,
			hasMore: false,
		});
		deleteMock.mockResolvedValue({ ok: true });

		const user = userEvent.setup();
		wrap(
			<ContextPendingItemsList
				projectId="proj_1"
				organizationId={null}
			/>,
		);

		const row = await screen.findByTestId("pending-row-ctx_to_delete");
		const deleteBtn = within(row).getByTestId(
			"pending-row-delete-ctx_to_delete",
		);
		expect(deleteBtn).toHaveAttribute("aria-label", "Delete trash.pdf");

		await user.click(deleteBtn);

		await waitFor(() => {
			expect(deleteMock).toHaveBeenCalledTimes(1);
		});
		expect(deleteMock).toHaveBeenCalledWith({
			id: "ctx_to_delete",
			projectId: "proj_1",
			organizationId: null,
		});
		// Successful delete invalidates the contexts list (so the row
		// disappears on the next poll).
		await waitFor(() => {
			expect(
				invalidateQueriesMock.mock.calls.some((args) => {
					const arg = args[0] as { queryKey?: unknown[] };
					return (
						Array.isArray(arg?.queryKey) &&
						arg.queryKey[0] === "projects.contexts.list"
					);
				}),
			).toBe(true);
		});
	});

	// ── (f) empty state renders nothing ────────────────────────────────
	it("renders `null` (no DOM nodes) when the list is empty", async () => {
		contextsListMock.mockResolvedValue({
			contexts: [],
			total: 0,
			hasMore: false,
		});

		const { container } = wrap(
			<ContextPendingItemsList
				projectId="proj_1"
				organizationId={null}
			/>,
		);

		// Wait for the query to settle, then assert no list was rendered.
		await waitFor(() => {
			expect(contextsListMock).toHaveBeenCalledTimes(1);
		});

		// `<QueryClientProvider />` wraps a single child. `<ContextPendingItemsList />`
		// returns `null` when the list is empty — its parent fragment should be
		// empty. We assert the container has no list element and no row testids.
		expect(screen.queryByTestId("pending-items-list")).toBeNull();
		expect(container.querySelector("ul")).toBeNull();
	});
});
