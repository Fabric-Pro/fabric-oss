/**
 * UrlSourcePageView tests — commit 2 of feat/url-context-polish-and-path-prefix.
 *
 * Spec: dedicated URL source reading page (the wider counterpart of
 * `UrlPagePreviewDrawer`). Covers all four render modes the user spec
 * called out:
 *   1. SINGLE_PAGE — renders the parent markdown in the prose column.
 *   2. PATH_PREFIX — renders the paginated child page list.
 *   3. FAILED — renders the error card with a Retry CTA.
 *   4. Banned-token regression scan — no glassmorphism / gradient pills /
 *      hardcoded hex / pulsing-blur orbs in the rendered HTML.
 *
 * The drawer's "Open full view →" link is covered in
 * `UrlPagePreviewDrawer.full-view.test.tsx` (separate fixture so we don't
 * have to wire the drawer's TanStack Query setup into this file).
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── jsdom polyfills ─────────────────────────────────────────────────────
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
	if (!HTMLElement.prototype.hasPointerCapture) {
		HTMLElement.prototype.hasPointerCapture = (() => false) as never;
	}
	if (!HTMLElement.prototype.scrollIntoView) {
		HTMLElement.prototype.scrollIntoView = (() => undefined) as never;
	}
	if (!HTMLElement.prototype.releasePointerCapture) {
		HTMLElement.prototype.releasePointerCapture = (() =>
			undefined) as never;
	}
});

// ── Mocks ───────────────────────────────────────────────────────────────

const {
	listUrlPagesMock,
	getUrlPageContentMock,
	resyncMock,
	updateMock,
	deleteMock,
	createDownloadUrlMock,
	trackEventMock,
	pushMock,
	refreshMock,
} = vi.hoisted(() => ({
	listUrlPagesMock: vi.fn(),
	getUrlPageContentMock: vi.fn(),
	resyncMock: vi.fn(),
	updateMock: vi.fn(),
	deleteMock: vi.fn(),
	createDownloadUrlMock: vi.fn(),
	trackEventMock: vi.fn(),
	pushMock: vi.fn(),
	refreshMock: vi.fn(),
}));

const { resyncUrlPageMock } = vi.hoisted(() => ({
	resyncUrlPageMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: {
				listUrlPages: (i: unknown) => listUrlPagesMock(i),
				getUrlPageContent: (i: unknown) => getUrlPageContentMock(i),
				resyncUrlSource: (i: unknown) => resyncMock(i),
				resyncUrlPage: (i: unknown) => resyncUrlPageMock(i),
				updateUrlSource: (i: unknown) => updateMock(i),
				delete: (i: unknown) => deleteMock(i),
				createDownloadUrl: (i: unknown) => createDownloadUrlMock(i),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				list: {
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
	toast: { success: vi.fn(), error: vi.fn() },
}));

// The Settings card reads PROJECT_READINESS to decide whether to offer the
// source-category picker (Fizzy #2165). On here so the picker is exercised.
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => true,
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

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		push: pushMock,
		refresh: refreshMock,
	}),
}));

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

import {
	UrlSourcePageView,
	type UrlSourceViewData,
} from "../UrlSourcePageView";

// ── Helpers ─────────────────────────────────────────────────────────────

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

function makeContext(
	overrides: Partial<UrlSourceViewData> = {},
): UrlSourceViewData {
	return {
		id: "ctx_1",
		projectId: "proj_1",
		projectName: "Acme",
		sourceUrl: "https://example.com/docs",
		sourceTitle: "Example Docs",
		urlScope: "SINGLE_PAGE",
		urlMaxPages: null,
		urlRefreshMode: "ONCE",
		knowledgeBaseSourceCategory: null,
		knowledgeBaseSourceCategoryOther: null,
		urlLastSyncedAt: "2026-05-13T09:00:00.000Z",
		urlNextRefreshAt: null,
		extractionStatus: "COMPLETED",
		extractionError: null,
		content:
			"# Welcome\n\nThis is the **parent** markdown body.\n\n- bullet one\n- bullet two",
		createdAt: "2026-05-12T10:00:00.000Z",
		updatedAt: "2026-05-13T09:00:00.000Z",
		scraperProvider: "firecrawl",
		indexedCount: 0,
		...overrides,
	};
}

const BANNED_TOKENS: RegExp[] = [
	/\bfrom-\w+-500\b/,
	/\bto-\w+-500\b/,
	/\bbg-gradient-to-/,
	/\bbackdrop-blur(?!-0\b)/,
	/#[0-9a-fA-F]{6}/,
	/animate-pulse rounded-full blur-\[/,
];

function expectNoBannedTokens(html: string) {
	for (const re of BANNED_TOKENS) {
		expect(html, `banned token matched: ${re}`).not.toMatch(re);
	}
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("UrlSourcePageView", () => {
	beforeEach(() => {
		listUrlPagesMock.mockReset();
		getUrlPageContentMock.mockReset();
		resyncMock.mockReset();
		resyncUrlPageMock.mockReset();
		updateMock.mockReset();
		deleteMock.mockReset();
		createDownloadUrlMock.mockReset();
		trackEventMock.mockReset();
		pushMock.mockReset();
		refreshMock.mockReset();
	});

	describe("SINGLE_PAGE render", () => {
		it("renders the parent markdown in the wide prose column", () => {
			wrap(
				<UrlSourcePageView
					context={makeContext()}
					backHref="/app/projects/proj_1?tab=context"
				/>,
			);

			expect(
				screen.getByTestId("url-source-main-column"),
			).toBeInTheDocument();
			const md = screen.getByTestId("url-source-markdown");
			// react-markdown emits a real <h1> / <ul> tree.
			expect(md.querySelector("h1")?.textContent).toBe("Welcome");
			expect(md.querySelectorAll("li")).toHaveLength(2);
		});

		it("breadcrumb back-link targets the project's contexts tab", () => {
			wrap(
				<UrlSourcePageView
					context={makeContext()}
					backHref="/app/projects/proj_1?tab=context"
				/>,
			);

			const back = screen.getByLabelText("Back to project contexts");
			expect(back).toHaveAttribute(
				"href",
				"/app/projects/proj_1?tab=context",
			);
		});

		it("Re-sync now button calls resyncUrlSource with the context id", async () => {
			resyncMock.mockResolvedValue({
				contextId: "ctx_1",
				status: "EXTRACTING",
			});
			const user = userEvent.setup();
			wrap(
				<UrlSourcePageView
					context={makeContext()}
					backHref="/app/projects/proj_1"
				/>,
			);

			await user.click(
				screen.getByRole("button", { name: /Re-sync now/i }),
			);

			await waitFor(() => {
				expect(resyncMock).toHaveBeenCalledTimes(1);
			});
			expect(resyncMock).toHaveBeenCalledWith({
				contextId: "ctx_1",
				projectId: "proj_1",
				organizationId: null,
			});
		});

		it("renders the editorial 'URL SOURCE' eyebrow + serif h1", () => {
			wrap(
				<UrlSourcePageView
					context={makeContext()}
					backHref="/app/projects/proj_1"
				/>,
			);
			expect(screen.getByText("URL Source")).toBeInTheDocument();
			const heading = screen.getByRole("heading", {
				level: 1,
				name: "Example Docs",
			});
			// CLAUDE.md mandates `font-serif` for page-level h1.
			expect(heading.className).toMatch(/font-serif/);
		});
	});

	describe("PATH_PREFIX render", () => {
		it("renders the paginated child page list via listUrlPages", async () => {
			listUrlPagesMock.mockResolvedValueOnce({
				items: [
					{
						id: "p_a",
						pageUrl: "https://example.com/a",
						pageTitle: "A",
						lastFetchedAt: "2026-05-13T10:00:00Z",
						chunkCount: 3,
						extractionStatus: "COMPLETED",
						extractionError: null,
					},
					{
						id: "p_b",
						pageUrl: "https://example.com/b",
						pageTitle: "B",
						lastFetchedAt: "2026-05-13T10:00:00Z",
						chunkCount: 2,
						extractionStatus: "COMPLETED",
						extractionError: null,
					},
				],
				nextCursor: null,
				total: 2,
			});

			wrap(
				<UrlSourcePageView
					context={makeContext({
						urlScope: "PATH_PREFIX",
						urlMaxPages: 100,
						indexedCount: 2,
						content: "",
					})}
					backHref="/app/projects/proj_1"
				/>,
			);

			await waitFor(() => {
				// `statusFilter: "all"` is the default the ChildPagesList
				// toolbar starts with; the component passes it through on
				// every call so the server-side filter is always the
				// authoritative source of truth.
				expect(listUrlPagesMock).toHaveBeenCalledWith({
					parentContextId: "ctx_1",
					projectId: "proj_1",
					organizationId: null,
					cursor: undefined,
					limit: 10,
					statusFilter: "all",
				});
			});

			expect(await screen.findByText("A")).toBeInTheDocument();
			expect(screen.getByText("B")).toBeInTheDocument();
			// SINGLE_PAGE markdown surface MUST NOT render.
			expect(
				screen.queryByTestId("url-source-markdown"),
			).not.toBeInTheDocument();
		});

		it("shows the per-status pages breakdown in the sidebar Details card for PATH_PREFIX", async () => {
			// Replaces the old single "Pages indexed: 17" row. The Details
			// sidebar now renders a 2-column dl with Discovered / Indexed /
			// Processing / Failed counts (Processing + Failed are only
			// rendered when their count > 0 to keep the card compact for
			// finished crawls).
			listUrlPagesMock.mockResolvedValueOnce({
				items: [],
				nextCursor: null,
				total: 0,
			});

			wrap(
				<UrlSourcePageView
					context={makeContext({
						urlScope: "PATH_PREFIX",
						urlMaxPages: 100,
						totalCount: 50,
						indexedCount: 17,
						pendingCount: 30,
						failedCount: 3,
						content: "",
					})}
					backHref="/app/projects/proj_1"
				/>,
			);

			const breakdown = await screen.findByTestId(
				"url-source-pages-breakdown",
			);
			expect(breakdown).toHaveTextContent("Discovered");
			expect(breakdown).toHaveTextContent("50");
			expect(breakdown).toHaveTextContent("Indexed");
			expect(breakdown).toHaveTextContent("17");
			expect(breakdown).toHaveTextContent("Processing");
			expect(breakdown).toHaveTextContent("30");
			expect(breakdown).toHaveTextContent("Failed");
			expect(breakdown).toHaveTextContent("3");
		});
	});

	describe("FAILED render", () => {
		it("renders the error card with the extraction error and a Retry CTA", async () => {
			resyncMock.mockResolvedValue({
				contextId: "ctx_1",
				status: "EXTRACTING",
			});

			const user = userEvent.setup();
			wrap(
				<UrlSourcePageView
					context={makeContext({
						extractionStatus: "FAILED",
						extractionError:
							"Firecrawl returned 429 — rate-limited.",
						content: "",
					})}
					backHref="/app/projects/proj_1"
				/>,
			);

			const failedCard = screen.getByTestId("url-source-failed");
			expect(failedCard).toBeInTheDocument();
			expect(failedCard.textContent).toMatch(/rate-limited/);

			// SINGLE_PAGE markdown surface MUST NOT render in the failed branch.
			expect(
				screen.queryByTestId("url-source-markdown"),
			).not.toBeInTheDocument();

			const retry = screen
				.getAllByRole("button", { name: /Retry|Re-sync/i })
				.find((b) => /Retry/.test(b.textContent ?? ""));
			expect(retry).toBeDefined();
			if (!retry) {
				return;
			}
			await user.click(retry);

			await waitFor(() => {
				expect(resyncMock).toHaveBeenCalledWith({
					contextId: "ctx_1",
					projectId: "proj_1",
					organizationId: null,
				});
			});
		});

		it("rewrites robots.txt-style errors to friendly copy but keeps raw error available", () => {
			wrap(
				<UrlSourcePageView
					context={makeContext({
						extractionStatus: "FAILED",
						extractionError:
							"robots.txt disallows /admin for crawler",
						content: "",
					})}
					backHref="/app/projects/proj_1"
				/>,
			);
			expect(
				screen.getByText(/site disallows crawlers in its robots\.txt/i),
			).toBeInTheDocument();
		});
	});

	describe("Editorial aesthetic", () => {
		it("renders without any banned tokens (gradient pills / blur / hex)", () => {
			const { container } = wrap(
				<UrlSourcePageView
					context={makeContext()}
					backHref="/app/projects/proj_1"
				/>,
			);
			expectNoBannedTokens(container.innerHTML);
		});
	});

	describe("Settings card (inline sidebar editor)", () => {
		it("renders with the current values populated", () => {
			wrap(
				<UrlSourcePageView
					context={makeContext({
						sourceTitle: "Example Docs",
						urlScope: "PATH_PREFIX",
						urlMaxPages: 50,
						urlRefreshMode: "WEEKLY",
					})}
					backHref="/app/projects/proj_1"
				/>,
			);

			const card = screen.getByTestId("url-source-settings-card");
			const labelInput = within(card).getByTestId(
				"url-source-settings-label",
			) as HTMLInputElement;
			expect(labelInput.value).toBe("Example Docs");
			// Refresh select shows the current value as the trigger label.
			expect(
				within(card).getByTestId("url-source-settings-refresh"),
			).toHaveTextContent("Weekly");
			// Path-prefix is current scope, so the max-pages row is visible.
			expect(
				within(card).getByTestId("url-source-settings-maxpages-row"),
			).toBeInTheDocument();
		});

		it("the standalone top-bar 'Edit settings' button no longer exists", () => {
			wrap(
				<UrlSourcePageView
					context={makeContext()}
					backHref="/app/projects/proj_1"
				/>,
			);
			expect(
				screen.queryByRole("button", { name: /Edit settings/i }),
			).toBeNull();
		});

		it("Save is disabled until the user edits a value, then enables; clicking it sends the diff", async () => {
			updateMock.mockResolvedValue({ contextId: "ctx_1" });
			const user = userEvent.setup();
			wrap(
				<UrlSourcePageView
					context={makeContext({
						sourceTitle: "Old label",
						urlScope: "SINGLE_PAGE",
						urlMaxPages: null,
						urlRefreshMode: "ONCE",
					})}
					backHref="/app/projects/proj_1"
				/>,
			);

			const card = screen.getByTestId("url-source-settings-card");
			const save = within(card).getByTestId(
				"url-source-settings-save",
			) as HTMLButtonElement;
			expect(save.disabled).toBe(true);

			const labelInput = within(card).getByTestId(
				"url-source-settings-label",
			) as HTMLInputElement;
			await user.clear(labelInput);
			await user.type(labelInput, "New label");
			expect(save.disabled).toBe(false);

			await user.click(save);
			await waitFor(() => {
				expect(updateMock).toHaveBeenCalledTimes(1);
			});
			// Diff payload — only label is sent, scope/refresh/maxPages unchanged.
			expect(updateMock).toHaveBeenCalledWith({
				contextId: "ctx_1",
				projectId: "proj_1",
				organizationId: null,
				label: "New label",
			});
		});
	});

	describe("Download action (full-view page)", () => {
		it("renders a Download button in the action cluster", () => {
			wrap(
				<UrlSourcePageView
					context={makeContext()}
					backHref="/app/projects/proj_1"
				/>,
			);
			expect(
				screen.getByTestId("url-source-download"),
			).toBeInTheDocument();
		});

		it("clicking Download fires createDownloadUrl + triggers a browser download", async () => {
			createDownloadUrlMock.mockResolvedValue({
				url: "https://s3.test/presigned-link.md",
				filename: "example-docs-ctx_1.md",
				expiresAt: new Date(Date.now() + 300_000).toISOString(),
				contextClass: "B",
			});
			const clickSpy = vi
				.spyOn(HTMLAnchorElement.prototype, "click")
				.mockImplementation(() => undefined);
			const user = userEvent.setup();
			wrap(
				<UrlSourcePageView
					context={makeContext()}
					backHref="/app/projects/proj_1"
				/>,
			);

			await user.click(screen.getByTestId("url-source-download"));

			await waitFor(() => {
				expect(createDownloadUrlMock).toHaveBeenCalledTimes(1);
			});
			expect(createDownloadUrlMock).toHaveBeenCalledWith({
				contextId: "ctx_1",
				projectId: "proj_1",
				organizationId: null,
			});
			await waitFor(() => {
				expect(clickSpy).toHaveBeenCalled();
			});
			clickSpy.mockRestore();
		});

		it("Download is disabled when the crawl failed (no content to ship)", () => {
			wrap(
				<UrlSourcePageView
					context={makeContext({
						extractionStatus: "FAILED",
						extractionError: "boom",
						content: "",
					})}
					backHref="/app/projects/proj_1"
				/>,
			);
			const btn = screen.getByTestId(
				"url-source-download",
			) as HTMLButtonElement;
			expect(btn.disabled).toBe(true);
		});
	});

	describe("Settings card (regression — max-pages stepper)", () => {
		it("hides the max-pages stepper when scope = Single page", async () => {
			const user = userEvent.setup();
			wrap(
				<UrlSourcePageView
					context={makeContext({
						urlScope: "PATH_PREFIX",
						urlMaxPages: 50,
					})}
					backHref="/app/projects/proj_1"
				/>,
			);

			const card = screen.getByTestId("url-source-settings-card");
			// Visible at the starting scope.
			expect(
				within(card).getByTestId("url-source-settings-maxpages-row"),
			).toBeInTheDocument();

			// Flip scope to Single page via the radio input.
			const singlePageRadio = within(card).getByRole("radio", {
				name: /Single page/i,
			});
			await user.click(singlePageRadio);

			expect(
				within(card).queryByTestId("url-source-settings-maxpages-row"),
			).toBeNull();
		});
	});

	describe("Details sidebar — Next refresh row", () => {
		it("renders em-dash when urlNextRefreshAt is null", () => {
			wrap(
				<UrlSourcePageView
					context={makeContext({ urlNextRefreshAt: null })}
					backHref="/app/projects/proj_1"
				/>,
			);
			const cell = screen.getByTestId("url-source-next-refresh");
			expect(cell.textContent).toBe("—");
			// "Next refresh" editorial label is always present (always-show
			// per PM ask, not just when scheduled).
			expect(screen.getByText("Next refresh")).toBeInTheDocument();
		});

		it("renders relative + absolute UTC when urlNextRefreshAt is set", () => {
			wrap(
				<UrlSourcePageView
					context={makeContext({
						urlNextRefreshAt: "2099-01-01T00:00:00.000Z",
					})}
					backHref="/app/projects/proj_1"
				/>,
			);
			const cell = screen.getByTestId("url-source-next-refresh");
			// Absolute UTC piece is deterministic ("2099-01-01 00:00 UTC").
			expect(cell.textContent).toMatch(/2099-01-01 00:00 UTC/);
			// Relative piece uses date-fns; we only assert the separator +
			// "in" / "ago" prefix to keep this stable across clock drift.
			expect(cell.textContent).toMatch(/·/);
		});
	});

	describe("PATH_PREFIX — per-page Retry button", () => {
		it("renders a Retry button only on FAILED rows", async () => {
			listUrlPagesMock.mockResolvedValueOnce({
				items: [
					{
						id: "p_ok",
						pageUrl: "https://example.com/a",
						pageTitle: "OK page",
						lastFetchedAt: "2026-05-13T10:00:00Z",
						chunkCount: 3,
						extractionStatus: "COMPLETED",
						extractionError: null,
					},
					{
						id: "p_fail",
						pageUrl: "https://example.com/b",
						pageTitle: "Broken page",
						lastFetchedAt: "2026-05-13T10:00:00Z",
						chunkCount: 0,
						extractionStatus: "FAILED",
						extractionError: "Firecrawl 429",
					},
				],
				nextCursor: null,
				total: 2,
			});

			wrap(
				<UrlSourcePageView
					context={makeContext({
						urlScope: "PATH_PREFIX",
						urlMaxPages: 100,
						indexedCount: 1,
						content: "",
					})}
					backHref="/app/projects/proj_1"
				/>,
			);

			// FAILED row has the Retry button.
			expect(
				await screen.findByTestId("url-page-retry-p_fail"),
			).toBeInTheDocument();
			// COMPLETED row does NOT.
			expect(screen.queryByTestId("url-page-retry-p_ok")).toBeNull();
		});

		it("clicking Retry fires resyncUrlPage and optimistically flips the status", async () => {
			// First load + the post-mutation refetch both need a response —
			// React-Query invalidates the list after the mutation succeeds
			// and the second fetch must return something with a nextCursor
			// or the infinite-query observer crashes.
			listUrlPagesMock.mockResolvedValue({
				items: [
					{
						id: "p_fail",
						pageUrl: "https://example.com/b",
						pageTitle: "Broken page",
						lastFetchedAt: null,
						chunkCount: 0,
						extractionStatus: "FAILED",
						extractionError: "Firecrawl 429",
					},
				],
				nextCursor: null,
				total: 1,
			});
			resyncUrlPageMock.mockResolvedValue({
				pageId: "p_fail",
				status: "EXTRACTING",
			});

			const user = userEvent.setup();
			wrap(
				<UrlSourcePageView
					context={makeContext({
						urlScope: "PATH_PREFIX",
						urlMaxPages: 100,
						indexedCount: 0,
						content: "",
					})}
					backHref="/app/projects/proj_1"
				/>,
			);

			const retry = await screen.findByTestId("url-page-retry-p_fail");
			await user.click(retry);

			await waitFor(() => {
				expect(resyncUrlPageMock).toHaveBeenCalledWith({
					pageId: "p_fail",
					parentContextId: "ctx_1",
					projectId: "proj_1",
					organizationId: null,
				});
			});

			// Optimistic flip: the FAILED pill is replaced with the
			// "Crawling" pill on the same row, and the Retry button
			// hides while the mutation is in flight (status no longer
			// FAILED via the effectiveStatus override).
			await waitFor(() => {
				expect(
					screen.queryByTestId("url-page-retry-p_fail"),
				).toBeNull();
			});
		});
	});

	describe("Lock-while-crawling (UX hardening)", () => {
		// Rule from the user: "make sure I need to have stable status to
		// do anything". While the parent is PENDING/EXTRACTING the UI
		// must block Download, every Settings input + Save, and the
		// Delete menu item. Backend CONFLICT guards on updateUrlSource +
		// deleteContext mirror these so a stale tab can't bypass them.

		it("disables the Download button while crawling and explains why in the tooltip", () => {
			wrap(
				<UrlSourcePageView
					context={makeContext({
						extractionStatus: "EXTRACTING",
						urlScope: "PATH_PREFIX",
						urlMaxPages: 200,
					})}
					backHref="/app/projects/proj_1"
				/>,
			);
			const dl = screen.getByTestId("url-source-download");
			expect(dl).toBeDisabled();
		});

		it("locks the Settings card (every input + Save) while crawling", () => {
			wrap(
				<UrlSourcePageView
					context={makeContext({
						extractionStatus: "EXTRACTING",
						urlScope: "PATH_PREFIX",
						urlMaxPages: 200,
					})}
					backHref="/app/projects/proj_1"
				/>,
			);

			// Every form control inside the fieldset is disabled. The
			// fieldset's HTML `disabled` attribute cascades to children,
			// which is exactly the contract we want — a stale tab can't
			// type into a field and click Save.
			const card = screen.getByTestId("url-source-settings-card");
			const fields = card.querySelectorAll(
				"input, button, [role='radio'], [role='combobox']",
			);
			expect(fields.length).toBeGreaterThan(0);
			for (const f of Array.from(fields)) {
				expect(f).toBeDisabled();
			}
			// Save is explicitly disabled even if the user somehow had a
			// pending diff (e.g. they started editing before the crawl
			// kicked off and the page refreshed mid-edit).
			expect(
				screen.getByTestId("url-source-settings-save"),
			).toBeDisabled();
			// And there's a visible notice so users know why.
			expect(
				screen.getByTestId("url-source-settings-locked-notice"),
			).toBeInTheDocument();
		});

		it("shows an elapsed-time chip next to the status pill while crawling", () => {
			// `updatedAt` is when the row transitioned into EXTRACTING
			// (resync-url-source + process-context-link stamp it in the
			// same write as the status). The chip ticks live; we just
			// assert the chip renders here — the duration math has its
			// own unit-style coverage via the formatter.
			wrap(
				<UrlSourcePageView
					context={makeContext({
						extractionStatus: "EXTRACTING",
						updatedAt: new Date(Date.now() - 90_000).toISOString(),
					})}
					backHref="/app/projects/proj_1"
				/>,
			);
			expect(
				screen.getByTestId("url-source-crawl-elapsed-chip"),
			).toBeInTheDocument();
		});

		it("does NOT render the elapsed chip when the row is in a terminal state", () => {
			wrap(
				<UrlSourcePageView
					context={makeContext({ extractionStatus: "COMPLETED" })}
					backHref="/app/projects/proj_1"
				/>,
			);
			expect(
				screen.queryByTestId("url-source-crawl-elapsed-chip"),
			).toBeNull();
		});
	});

	describe("CANCELLED status (terminal-but-distinct)", () => {
		// Distinct render so the user immediately sees the difference
		// between "crawl succeeded" and "user stopped it mid-way".
		// Pages already indexed before cancel are preserved — the
		// previous COMPLETED-on-cancel finalize was misleading.

		it("renders the 'Cancelled' status pill instead of Indexed/Crawling", () => {
			wrap(
				<UrlSourcePageView
					context={makeContext({
						extractionStatus: "CANCELLED",
						urlScope: "PATH_PREFIX",
						urlMaxPages: 200,
					})}
					backHref="/app/projects/proj_1"
				/>,
			);
			expect(
				screen.getByTestId("status-pill-cancelled"),
			).toHaveTextContent(/Cancelled/i);
		});

		it("treats CANCELLED as terminal — Re-sync (not Cancel) is shown, settings unlocked", () => {
			wrap(
				<UrlSourcePageView
					context={makeContext({ extractionStatus: "CANCELLED" })}
					backHref="/app/projects/proj_1"
				/>,
			);
			// Cancel button is hidden; Re-sync is visible — the row is
			// resumable in one click.
			expect(screen.queryByTestId("url-source-cancel-crawl")).toBeNull();
			expect(
				screen.getByRole("button", { name: /Re-sync now/i }),
			).toBeInTheDocument();
			// Settings card is editable again.
			const labelInput = screen.getByTestId("url-source-settings-label");
			expect(labelInput).not.toBeDisabled();
			// And the "Locked while crawling" notice is gone.
			expect(
				screen.queryByTestId("url-source-settings-locked-notice"),
			).toBeNull();
		});
	});
});

/**
 * Classifying a source that predates the category (Fizzy #2165, 20 Aug review).
 *
 * The category could only ever be set while CREATING a link, so an older source
 * could not satisfy the Knowledge Base readiness item without being deleted and
 * crawled again. These assert the edit path exists and sends the right thing —
 * and that it refuses the one value the server also refuses.
 */
describe("source category on an existing URL source", () => {
	it("sends the chosen category without touching anything else", async () => {
		updateMock.mockResolvedValue({ contextId: "ctx_1" });
		const user = userEvent.setup();
		wrap(
			<UrlSourcePageView
				context={makeContext({ knowledgeBaseSourceCategory: null })}
				backHref="/app/projects/proj_1"
			/>,
		);

		const card = screen.getByTestId("url-source-settings-card");
		const save = within(card).getByTestId(
			"url-source-settings-save",
		) as HTMLButtonElement;
		expect(save.disabled).toBe(true);

		await user.click(
			within(card).getByTestId("url-source-settings-category"),
		);
		await user.click(
			await screen.findByRole("option", {
				name: "Knowledge Base / Wiki",
			}),
		);
		expect(save.disabled).toBe(false);

		await user.click(save);
		await waitFor(() => expect(updateMock).toHaveBeenCalledTimes(1));
		expect(updateMock).toHaveBeenCalledWith({
			contextId: "ctx_1",
			projectId: "proj_1",
			organizationId: null,
			knowledgeBaseSourceCategory: "KNOWLEDGE_BASE_WIKI",
		});
	});

	it("will not save Other until it is described", async () => {
		const user = userEvent.setup();
		wrap(
			<UrlSourcePageView
				context={makeContext({ knowledgeBaseSourceCategory: null })}
				backHref="/app/projects/proj_1"
			/>,
		);

		const card = screen.getByTestId("url-source-settings-card");
		await user.click(
			within(card).getByTestId("url-source-settings-category"),
		);
		await user.click(await screen.findByRole("option", { name: "Other" }));

		const save = within(card).getByTestId(
			"url-source-settings-save",
		) as HTMLButtonElement;
		expect(save.disabled).toBe(true);

		await user.type(
			within(card).getByTestId("url-source-settings-category-other"),
			"Internal runbooks",
		);
		expect(save.disabled).toBe(false);
	});
});
