/**
 * Component tests for the URL Context Sources v2 Link tab (Group 7).
 *
 * Spec:
 * - fabric/specs/2026-05-13-url-context-sources/spec.md §9.1 (Link tab)
 * - fabric/specs/2026-05-13-url-context-sources/tasks.md Group 7.6
 * - CLAUDE.md editorial aesthetic (also covered by the sibling
 *   `ContextUploaderDialog.test.tsx` banned-token regression).
 *
 * Scope:
 *  1. Pre-flight notice renders when `searchProviders.get*Providers`
 *     returns no Firecrawl row (or returns one with `enabled: false`).
 *  2. Submit button is disabled when Firecrawl is not configured.
 *  3. Scope auto-detects to PATH_PREFIX on doc-section URLs (`/hc/en-us`,
 *     `/docs/api`, trailing-`/`, etc.) and SINGLE_PAGE on article/leaf URLs.
 *  4. Max-pages stepper is hidden when scope === SINGLE_PAGE, visible when
 *     PATH_PREFIX.
 *  5. Submit dispatches `processLink` with the new payload shape:
 *     `{ projectId, url, label?, scope, maxPages?, refreshMode }`.
 *  6. When the server returns BAD_REQUEST + `code: 'FIRECRAWL_NOT_CONFIGURED'`
 *     during submit (key revoked between mount and submit), the notice card
 *     re-renders.
 *  7. Banned-token regression net applied to every state above so the new
 *     tab does not reintroduce gradients, hardcoded hex, glassmorphism, or
 *     animated blob orbs.
 *
 * Auto-detect rule (mirrors `detectUrlScope` and decisions.md §7.2):
 *   • trailing `/` (non-root)          → PATH_PREFIX
 *   • path contains `/hc/`, `/docs/`,
 *     `/help/`, `/kb/`, `/guide/`,
 *     `/learn/`                         → PATH_PREFIX
 *   • else                              → SINGLE_PAGE
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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
	if (!HTMLElement.prototype.hasPointerCapture) {
		HTMLElement.prototype.hasPointerCapture = (() => false) as never;
	}
	if (!HTMLElement.prototype.scrollIntoView) {
		HTMLElement.prototype.scrollIntoView = (() => undefined) as never;
	}
});

// ── Module mocks ─────────────────────────────────────────────────────────

const {
	processLinkMock,
	getUserSearchProvidersMock,
	getOrgSearchProvidersMock,
	contextsListMock,
	mcpConfigsListMock,
	trackEventMock,
	orgContextRef,
} = vi.hoisted(() => ({
	processLinkMock: vi.fn(),
	// Pre-flight now reads the unified searchProviders table (commit 1 of 3
	// in the multi-provider PR). Mocks below return rows of that shape.
	getUserSearchProvidersMock: vi.fn(),
	getOrgSearchProvidersMock: vi.fn(),
	contextsListMock: vi.fn(),
	mcpConfigsListMock: vi.fn(),
	trackEventMock: vi.fn(),
	// Mutable holder so individual tests can flip useOrganizationContext()
	// between personal (null) and org (non-null) without a second file.
	orgContextRef: {
		current: {
			organizationId: null as string | null,
			organizationSlug: null as string | null,
			basePath: "/app",
		},
	},
}));

// The dialog reads PROJECT_READINESS to decide whether a link source has to be
// classified before it is saved (Fizzy #2165). Every assertion in this file
// predates that field and describes the flag-OFF behaviour, which must stay
// byte-identical to what shipped before it — so this mock is the regression
// guard, not a convenience.
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: {
				processLink: (input: unknown) => processLinkMock(input),
				list: (input: unknown) => contextsListMock(input),
				createUploadUrl: vi.fn(),
				processFile: vi.fn(),
			},
		},
		searchProviders: {
			getUserProviders: () => getUserSearchProvidersMock(),
			getOrganizationProviders: (input: unknown) =>
				getOrgSearchProvidersMock(input),
		},
		mcp: {
			configs: {
				list: (input: unknown) => mcpConfigsListMock(input),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				list: {
					queryKey: (args: { input: unknown }) => [
						"projects.contexts.list",
						args.input,
					],
				},
				create: {
					mutationOptions: ({
						onSuccess,
						onError,
					}: {
						onSuccess?: () => void;
						onError?: (err: { message: string }) => void;
					}) => ({
						mutationFn: vi.fn(),
						onSuccess,
						onError,
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

// Default to personal context (orgContextRef.current). Individual tests
// can mutate orgContextRef.current inside their `it()` to exercise org
// behaviour — the mock reads the ref each call so React picks up the new
// values across re-mounts.
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => orgContextRef.current,
}));

vi.mock("@saas/settings/hooks/use-settings-return-url", () => ({
	useSettingsReturnUrl: () => (path: string) => path,
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: trackEventMock }),
}));

vi.mock("../NotionResourceBrowser", () => ({
	NotionResourceBrowser: () => null,
}));
vi.mock("../SlackChannelSelectorDialog", () => ({
	SlackChannelSelectorDialog: () => null,
}));
vi.mock("../TeamsChatSelectorDialog", () => ({
	TeamsChatSelectorDialog: () => null,
}));
vi.mock("../GoogleDocsSelectorDialog", () => ({
	GoogleDocsSelectorDialog: () => null,
}));

import {
	ContextUploaderDialog,
	detectUrlScope,
	parseBulkUrlLines,
} from "../ContextUploaderDialog";

// ── Helpers ──────────────────────────────────────────────────────────────

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

const banned: ReadonlyArray<{ name: string; pattern: RegExp }> = [
	{ name: "from-*-500 (gradient pill start)", pattern: /from-\w+-500/ },
	{ name: "to-*-500 (gradient pill end)", pattern: /to-\w+-500/ },
	{ name: "bg-gradient-to-*", pattern: /bg-gradient-to-/ },
	{ name: "backdrop-blur", pattern: /backdrop-blur/ },
	{
		name: "animate-pulse rounded-full blur-[…] orb",
		pattern: /animate-pulse\s+rounded-full\s+blur-\[/,
	},
	{
		name: "hardcoded hex color literal",
		// Allow inert hashes in `aria-describedby` etc. by only flagging
		// `#abc` or `#abcdef` between style-y attributes. The `\b` keeps it
		// strict.
		pattern: /#[0-9a-fA-F]{3,8}\b/,
	},
];

function assertNoBannedTokens(root: HTMLElement, label: string) {
	const html = root.innerHTML;
	for (const { name, pattern } of banned) {
		expect(
			pattern.test(html),
			`Editorial regression (${label}): markup contains ${name}.`,
		).toBe(false);
	}
}

function getTabTrigger(id: string): HTMLElement {
	const el = document.getElementById(`context-tab-${id}`);
	if (!el) {
		throw new Error(`Tab trigger #context-tab-${id} not found`);
	}
	return el;
}

// Canonical row shapes returned by `searchProviders.get*Providers()`. The
// pre-flight (commit 3 of 3, multi-provider PR) treats a row as "scrape-
// capable" when providerName is firecrawl/jina/tavily/exa AND enabled=true
// AND maskedApiKey !== null. Crawl-capable (PATH_PREFIX) requires firecrawl
// specifically.
function row<P extends string>(overrides: {
	providerName: P;
	enabled?: boolean;
	maskedApiKey?: string | null;
	isDefault?: boolean;
	priority?: number;
}) {
	return {
		id: `row_${overrides.providerName}`,
		providerName: overrides.providerName,
		endpoint: null,
		isDefault: overrides.isDefault ?? true,
		priority: overrides.priority ?? 0,
		lastUsedAt: null,
		searchesCount: 0,
		totalCost: 0,
		enabled: overrides.enabled ?? true,
		maskedApiKey: overrides.maskedApiKey ?? "***-1234",
	};
}

const CONFIGURED_ROWS = [row({ providerName: "firecrawl" })];
const NOT_CONFIGURED_EMPTY: typeof CONFIGURED_ROWS = [];
const NOT_CONFIGURED_DISABLED = [
	row({ providerName: "firecrawl", enabled: false }),
];
// Jina-only (commit 3 of 3): scrape-capable but NOT crawl-capable.
// PATH_PREFIX radio must be disabled in this configuration.
const JINA_ONLY_ROWS = [row({ providerName: "jina" })];

// ── detectUrlScope unit table ────────────────────────────────────────────

describe("detectUrlScope (auto-detect rule)", () => {
	const pathPrefixCases = [
		"https://help.acme.com/hc/en-us",
		"https://example.com/hc/en-us/articles/foo",
		"https://example.com/docs/api",
		"https://example.com/docs/",
		"https://example.com/help/",
		"https://example.com/kb/article-123",
		"https://example.com/guide/getting-started",
		"https://example.com/learn/intro",
		"https://example.com/products/", // trailing slash, non-root
	];
	const singlePageCases = [
		"https://example.com/about",
		"https://example.com/blog/some-post.html",
		"https://example.com",
		"https://example.com/",
		"https://example.com/index.html",
		"https://example.com/news/2024-update",
		"not-a-url",
	];

	it.each(pathPrefixCases)("flags %s as PATH_PREFIX", (url) => {
		expect(detectUrlScope(url)).toBe("PATH_PREFIX");
	});
	it.each(singlePageCases)("flags %s as SINGLE_PAGE", (url) => {
		expect(detectUrlScope(url)).toBe("SINGLE_PAGE");
	});
});

// ── Component tests ──────────────────────────────────────────────────────

describe("ContextUploaderDialog — URL Context Sources v2 Link tab", () => {
	beforeEach(() => {
		processLinkMock.mockReset();
		getUserSearchProvidersMock.mockReset();
		getOrgSearchProvidersMock.mockReset();
		contextsListMock.mockReset();
		mcpConfigsListMock.mockReset();
		trackEventMock.mockReset();
		contextsListMock.mockResolvedValue({ contexts: [] });
		mcpConfigsListMock.mockResolvedValue([]);
		// Reset to personal context unless a test flips this.
		orgContextRef.current = {
			organizationId: null,
			organizationSlug: null,
			basePath: "/app",
		};
	});

	it("renders the pre-flight notice when no scrape-capable provider is configured", async () => {
		getUserSearchProvidersMock.mockResolvedValue(NOT_CONFIGURED_EMPTY);
		const user = userEvent.setup();
		const { container } = wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));

		await waitFor(() => {
			expect(
				screen.getByText(
					/URL sources need a search provider with scraping/i,
				),
			).toBeInTheDocument();
		});
		// Deep link is context-correct for personal mode.
		const cta = screen.getByRole("link", {
			name: /Settings → Search Providers/i,
		});
		expect(cta).toHaveAttribute("href", "/app/settings/search-providers");
		assertNoBannedTokens(container, "preflight notice");
	});

	it("disables the submit button when no scrape-capable provider is configured", async () => {
		getUserSearchProvidersMock.mockResolvedValue(NOT_CONFIGURED_EMPTY);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		await waitFor(() => {
			expect(
				screen.getByText(
					/URL sources need a search provider with scraping/i,
				),
			).toBeInTheDocument();
		});

		const submit = screen.getByRole("button", {
			name: /^Add Context$/i,
		});
		expect(submit).toBeDisabled();
		expect(submit).toHaveAttribute("aria-disabled", "true");
	});

	// Commit 1 of 3 (multi-provider PR): the pre-flight switched from the
	// legacy firecrawl.getConfig endpoints to the unified searchProviders
	// table. These three tests pin the "configured ⇔ row exists, enabled,
	// has a non-null maskedApiKey" contract end-to-end through the dialog.

	it("enables submit and hides the notice when org searchProviders returns a configured firecrawl row", async () => {
		// Flip into org context — pre-flight should call
		// getOrganizationProviders (not getUserProviders).
		orgContextRef.current = {
			organizationId: "org_42",
			organizationSlug: "acme",
			basePath: "/app/acme",
		};
		getOrgSearchProvidersMock.mockResolvedValue([
			row({ providerName: "firecrawl" }),
		]);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		// URL form should render fully — no notice card.
		await screen.findByLabelText("URL");

		expect(
			screen.queryByText(
				/URL sources need a search provider with scraping/i,
			),
		).not.toBeInTheDocument();
		const submit = screen.getByRole("button", {
			name: /^Add Context$/i,
		});
		expect(submit).not.toBeDisabled();
		expect(submit).not.toHaveAttribute("aria-disabled", "true");
		// And the org-scoped endpoint is the one we hit.
		expect(getOrgSearchProvidersMock).toHaveBeenCalledWith({
			organizationId: "org_42",
		});
		// Personal endpoint is untouched.
		expect(getUserSearchProvidersMock).not.toHaveBeenCalled();
	});

	it("shows the notice and disables submit when searchProviders returns no scrape-capable row", async () => {
		// Empty list — user has never saved any provider key.
		getUserSearchProvidersMock.mockResolvedValue([]);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		await waitFor(() => {
			expect(
				screen.getByText(
					/URL sources need a search provider with scraping/i,
				),
			).toBeInTheDocument();
		});
		expect(
			screen.getByRole("button", { name: /^Add Context$/i }),
		).toBeDisabled();
	});

	it("shows the notice and disables submit when the firecrawl row is enabled=false", async () => {
		// Saved-then-toggled-off — row exists but `enabled` is false. The
		// pre-flight treats this as un-configured so a deliberately
		// disabled key keeps the notice up.
		getUserSearchProvidersMock.mockResolvedValue(NOT_CONFIGURED_DISABLED);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		await waitFor(() => {
			expect(
				screen.getByText(
					/URL sources need a search provider with scraping/i,
				),
			).toBeInTheDocument();
		});
		expect(
			screen.getByRole("button", { name: /^Add Context$/i }),
		).toBeDisabled();
	});

	// ── Multi-provider tests (commit 3 of 3) ────────────────────────────

	it("enables submit when a non-Firecrawl scrape provider (Jina) is configured", async () => {
		getUserSearchProvidersMock.mockResolvedValue(JINA_ONLY_ROWS);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		await screen.findByLabelText("URL");
		expect(
			screen.queryByText(
				/URL sources need a search provider with scraping/i,
			),
		).not.toBeInTheDocument();
		const submit = screen.getByRole("button", { name: /^Add Context$/i });
		expect(submit).not.toBeDisabled();
	});

	it("shows 'Indexing with Jina AI' indicator when only Jina is configured", async () => {
		getUserSearchProvidersMock.mockResolvedValue(JINA_ONLY_ROWS);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		const indicator = await screen.findByTestId("url-source-indexing-with");
		expect(indicator).toHaveTextContent(/Indexing with Jina AI/i);
	});

	it("shows 'Indexing with Firecrawl' when Firecrawl is the picked provider", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		const indicator = await screen.findByTestId("url-source-indexing-with");
		expect(indicator).toHaveTextContent(/Indexing with Firecrawl/i);
	});

	it("disables the PATH_PREFIX radio when only non-crawl-capable providers are enabled", async () => {
		getUserSearchProvidersMock.mockResolvedValue(JINA_ONLY_ROWS);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		await screen.findByLabelText("URL");

		// The path-prefix radio is rendered but disabled. We assert via the
		// wrapping span's aria-label which names the disabled state, then
		// look up the radio item by id and assert it carries
		// aria-disabled=true (Radix RadioGroupItem sets this when
		// `disabled` is passed).
		const wrapper = screen.getByLabelText(/Path-prefix scope \(disabled/i);
		expect(wrapper).toBeInTheDocument();
		// The RadioGroupItem itself is reachable by its id (`url-scope-prefix`).
		const disabledRadio = document.getElementById("url-scope-prefix");
		expect(disabledRadio).not.toBeNull();
		expect(disabledRadio?.getAttribute("aria-disabled")).toBe("true");
	});

	it("keeps the PATH_PREFIX radio enabled when Firecrawl is configured", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		await screen.findByLabelText("URL");
		const pathPrefix = screen.getByRole("radio", {
			name: /Path-prefix/i,
		});
		// Not disabled — should not carry aria-disabled=true.
		expect(pathPrefix).not.toHaveAttribute("aria-disabled", "true");
	});

	it("auto-detects to SINGLE_PAGE on a /docs/ URL when PATH_PREFIX is unavailable", async () => {
		// Jina-only: blur on a /docs/ URL would normally pick PATH_PREFIX,
		// but the radio is disabled — so the auto-detect should keep
		// SINGLE_PAGE selected instead of silently flipping to a disabled
		// state.
		getUserSearchProvidersMock.mockResolvedValue(JINA_ONLY_ROWS);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		const urlInput = await screen.findByLabelText("URL");
		await user.type(urlInput, "https://example.com/docs/api");
		urlInput.blur();

		await waitFor(() => {
			const single = screen.getByRole("radio", { name: /Single page/i });
			expect(single).toHaveAttribute("data-state", "checked");
		});
	});

	it("auto-detects scope = PATH_PREFIX on doc-section URLs on blur", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		const urlInput = await screen.findByLabelText("URL");
		await user.type(urlInput, "https://help.acme.com/hc/en-us");
		// Move focus away to fire onBlur.
		urlInput.blur();

		await waitFor(() => {
			const pathPrefix = screen.getByRole("radio", {
				name: /Path-prefix/i,
			});
			expect(pathPrefix).toHaveAttribute("data-state", "checked");
		});
		// And the maxPages stepper should be visible now. Match the
		// specific text on the field's <Label>, not the +/- aria-labels.
		expect(
			screen.getByLabelText(/Max pages to crawl/i),
		).toBeInTheDocument();
	});

	it("auto-detects scope = SINGLE_PAGE on leaf article URLs and hides the stepper", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		const urlInput = await screen.findByLabelText("URL");
		await user.type(urlInput, "https://example.com/blog/some-post.html");
		urlInput.blur();

		await waitFor(() => {
			const single = screen.getByRole("radio", {
				name: /Single page/i,
			});
			expect(single).toHaveAttribute("data-state", "checked");
		});
		expect(
			screen.queryByLabelText(/Max pages to crawl/i),
		).not.toBeInTheDocument();
	});

	// Commit 1 of 3: small UX nudge — when the blur rule flips scope to
	// PATH_PREFIX, name the matched pattern inline so the flip doesn't feel
	// silent. Disappears the moment the user clicks a scope radio.

	it("renders the inline auto-detect hint with the matched pattern after a blur flip", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		const urlInput = await screen.findByLabelText("URL");
		await user.type(urlInput, "https://example.com/docs/api");
		urlInput.blur();

		// The hint names the matched marker verbatim — easier to debug for
		// the user than a generic "Detected path-prefix".
		const hint = await screen.findByText(
			/Detected path-prefix from your URL/i,
		);
		expect(hint).toBeInTheDocument();
		expect(hint).toHaveTextContent("/docs/");

		// Manually toggling scope back to Single page removes the hint
		// (urlScopeUserOverridden flips → hint hides on next render).
		await user.click(screen.getByRole("radio", { name: /Single page/i }));
		await waitFor(() => {
			expect(
				screen.queryByText(/Detected path-prefix from your URL/i),
			).not.toBeInTheDocument();
		});
	});

	it("dispatches processLink with the full v2 payload on submit", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		processLinkMock.mockResolvedValue(undefined);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		const urlInput = await screen.findByLabelText("URL");
		await user.type(urlInput, "https://example.com/docs/api");
		urlInput.blur();

		// Auto-detect should have picked PATH_PREFIX.
		await waitFor(() => {
			expect(
				screen.getByRole("radio", { name: /Path-prefix/i }),
			).toHaveAttribute("data-state", "checked");
		});

		// Exact match: the two new #1888 fields' labels render as raw i18n
		// key paths in tests (…typeLabelOptional), which also contain
		// "Label", so the old /Label/i regex matched three controls.
		await user.type(
			screen.getByLabelText("Label (Optional)"),
			"Acme API docs",
		);

		await user.click(
			screen.getByRole("button", { name: /^Add Context$/i }),
		);

		await waitFor(() => {
			expect(processLinkMock).toHaveBeenCalledTimes(1);
		});
		expect(processLinkMock).toHaveBeenCalledWith({
			projectId: "proj_1",
			url: "https://example.com/docs/api",
			label: "Acme API docs",
			scope: "PATH_PREFIX",
			// Default 200; cap 500. See URL_MAX_PAGES_DEFAULT / URL_MAX_PAGES_MAX
			// in ContextUploaderDialog.tsx for the rationale.
			maxPages: 200,
			refreshMode: "ONCE",
		});
	});

	it("fires project_context_url_added telemetry on submit success (Group 10.1)", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		processLinkMock.mockResolvedValue(undefined);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_42"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		const urlInput = await screen.findByLabelText("URL");
		await user.type(urlInput, "https://example.com/single-article");
		urlInput.blur();

		await user.click(
			screen.getByRole("button", { name: /^Add Context$/i }),
		);

		await waitFor(() => {
			expect(processLinkMock).toHaveBeenCalledTimes(1);
		});
		// The legacy `project_context_url_added` event must
		// fire exactly once per successful submit, with the original
		// payload shape unchanged. The new
		// `project_context_added_during_wizard` event from spec
		// `2026-05-23-unified-context-uploader-wizard` §9.2 now also
		// fires on the same submit branch (its payload is asserted in
		// `ContextUploaderDialog.telemetry.test.tsx`); this assertion
		// counts only the legacy event so it stays pinned to the
		// originating spec.
		const urlAddedCalls = trackEventMock.mock.calls.filter(
			(call) => call[0] === "project_context_url_added",
		);
		expect(urlAddedCalls).toHaveLength(1);
		expect(urlAddedCalls[0][1]).toEqual({
			scope: "SINGLE_PAGE",
			refreshMode: "ONCE",
			maxPages: null,
			projectId: "proj_42",
		});
	});

	it("re-renders the pre-flight notice when submit returns SCRAPE_PROVIDER_NOT_CONFIGURED", async () => {
		// Pre-flight initially returns configured. Then the submit throws
		// the BAD_REQUEST payload — emulating a key revocation between
		// mount and submit.
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		processLinkMock.mockRejectedValueOnce({
			data: { code: "SCRAPE_PROVIDER_NOT_CONFIGURED" },
			message: "URL sources need a search provider with scraping.",
		});
		const user = userEvent.setup();
		const { container } = wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		// Confirm the notice is NOT showing before submit.
		await screen.findByLabelText("URL");
		expect(
			screen.queryByText(
				/URL sources need a search provider with scraping/i,
			),
		).not.toBeInTheDocument();

		await user.type(
			screen.getByLabelText("URL"),
			"https://example.com/single",
		);
		await user.click(
			screen.getByRole("button", { name: /^Add Context$/i }),
		);

		await waitFor(() => {
			expect(
				screen.getByText(
					/URL sources need a search provider with scraping/i,
				),
			).toBeInTheDocument();
		});
		assertNoBannedTokens(container, "post-submit notice");
	});

	it("re-renders the crawl-specific notice when submit returns CRAWL_PROVIDER_NOT_CONFIGURED", async () => {
		// Pre-flight reports Firecrawl is configured but the submit hits
		// the crawl-provider code (e.g. Firecrawl was toggled off between
		// mount and submit while the user had PATH_PREFIX selected). The
		// notice should switch to the path-prefix-specific copy.
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		processLinkMock.mockRejectedValueOnce({
			data: { code: "CRAWL_PROVIDER_NOT_CONFIGURED" },
			message: "Path-prefix crawls currently require Firecrawl.",
		});
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("link"));
		await screen.findByLabelText("URL");
		await user.type(
			screen.getByLabelText("URL"),
			"https://example.com/single",
		);
		await user.click(
			screen.getByRole("button", { name: /^Add Context$/i }),
		);

		await waitFor(() => {
			expect(
				screen.getByText(
					/Path-prefix crawls currently require Firecrawl/i,
				),
			).toBeInTheDocument();
		});
	});
});

// ── parseBulkUrlLines unit table ─────────────────────────────────────────

describe("parseBulkUrlLines", () => {
	it("returns one entry per non-blank, trimmed line", () => {
		const out = parseBulkUrlLines(
			[
				"https://example.com/a",
				"  https://example.com/b  ",
				"",
				"   ",
				"https://example.com/c",
			].join("\n"),
		);
		expect(out).toHaveLength(3);
		expect(out.map((l) => l.url)).toEqual([
			"https://example.com/a",
			"https://example.com/b",
			"https://example.com/c",
		]);
		expect(out.every((l) => l.error === null)).toBe(true);
	});

	it("flags invalid URLs with a per-line error and original line number", () => {
		const out = parseBulkUrlLines(
			[
				"https://example.com/a", // valid → line 1
				"not-a-url", // invalid → line 2
				"http://example.com/c", // not https → line 3
				"https://user:pass@example.com/d", // credentialed → line 4
			].join("\n"),
		);
		expect(out).toHaveLength(4);
		expect(out[0].error).toBeNull();
		expect(out[1].url).toBeNull();
		expect(out[1].lineNumber).toBe(2);
		expect(out[2].error).toMatch(/https/i);
		expect(out[2].lineNumber).toBe(3);
		expect(out[3].error).toMatch(/credential/i);
		expect(out[3].lineNumber).toBe(4);
	});

	it("preserves 1-indexed line numbers across blank-line skips", () => {
		const out = parseBulkUrlLines(
			["", "", "https://example.com/late"].join("\n"),
		);
		// Two blank lines were skipped; the survivor is on raw line 3.
		expect(out).toHaveLength(1);
		expect(out[0].lineNumber).toBe(3);
	});

	// Bug 4 — bulk paste had no dedupe before this commit. Pasting the
	// same URL twice would fire two processLink calls (and bill Firecrawl
	// twice for the same page). Dedupe collapses on a normalised key:
	// lowercase host + single-trailing-slash-stripped path. Query strings
	// and fragments stay AS-IS — `?lang=en` vs `?lang=fr` is a different
	// page in many doc sites and collapsing would silently drop content.
	describe("dedupes successful entries on normalised key (bug-4 regression)", () => {
		it("collapses three identical URLs to one valid entry", () => {
			const out = parseBulkUrlLines(
				["https://x.com", "https://x.com", "https://x.com"].join("\n"),
			);
			expect(out).toHaveLength(1);
			expect(out[0].url).toBe("https://x.com");
			expect(out[0].error).toBeNull();
		});

		it("collapses case + trailing-slash variants of the same URL", () => {
			const out = parseBulkUrlLines(
				["https://x.com", "https://X.COM/", "https://x.com/"].join(
					"\n",
				),
			);
			expect(out).toHaveLength(1);
			expect(out[0].url).toBe("https://x.com");
		});

		it("treats different query strings as distinct (genuine difference)", () => {
			const out = parseBulkUrlLines(
				["https://x.com?a=1", "https://x.com?a=2"].join("\n"),
			);
			expect(out).toHaveLength(2);
			expect(out.map((l) => l.url)).toEqual([
				"https://x.com?a=1",
				"https://x.com?a=2",
			]);
		});

		it("preserves invalid lines unchanged and dedupes only valid ones", () => {
			const out = parseBulkUrlLines(
				["https://x.com", "not-a-url", "https://x.com"].join("\n"),
			);
			// 1 valid + 1 invalid (the second https://x.com is the dropped
			// duplicate, not present in output).
			expect(out).toHaveLength(2);
			const valid = out.filter((l) => l.url !== null);
			const invalid = out.filter((l) => l.url === null);
			expect(valid).toHaveLength(1);
			expect(valid[0].url).toBe("https://x.com");
			expect(invalid).toHaveLength(1);
			expect(invalid[0].raw).toBe("not-a-url");
		});
	});
});

// ── Bulk URL paste mode (Commit 4) ───────────────────────────────────────

describe("ContextUploaderDialog — bulk URL paste mode", () => {
	beforeEach(() => {
		processLinkMock.mockReset();
		getUserSearchProvidersMock.mockReset();
		getOrgSearchProvidersMock.mockReset();
		contextsListMock.mockReset();
		mcpConfigsListMock.mockReset();
		trackEventMock.mockReset();
		contextsListMock.mockResolvedValue({ contexts: [] });
		mcpConfigsListMock.mockResolvedValue([]);
		orgContextRef.current = {
			organizationId: null,
			organizationSlug: null,
			basePath: "/app",
		};
	});

	async function openLinkTabInBulkMode() {
		const user = userEvent.setup();
		const rendered = wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);
		await user.click(getTabTrigger("link"));
		// Wait for the single URL form to be ready so the mode-toggle is
		// rendered.
		await screen.findByLabelText("URL");
		const multiToggle = screen.getByRole("tab", {
			name: /Multiple URLs/i,
		});
		await user.click(multiToggle);
		// Textarea label "URLs (one per line)" should now be visible.
		await screen.findByLabelText(/URLs \(one per line\)/i);
		return { user, rendered };
	}

	it("mode toggle switches between single and multi URL forms", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);
		await user.click(getTabTrigger("link"));
		await screen.findByLabelText("URL");

		// Initial: SINGLE — textarea must NOT exist.
		expect(
			screen.queryByLabelText(/URLs \(one per line\)/i),
		).not.toBeInTheDocument();

		// Click "Multiple URLs (paste list)".
		await user.click(screen.getByRole("tab", { name: /Multiple URLs/i }));
		await screen.findByLabelText(/URLs \(one per line\)/i);
		// Single URL input and Label field should now be hidden.
		expect(screen.queryByLabelText("URL")).not.toBeInTheDocument();
		expect(
			screen.queryByLabelText(/^Label \(Optional\)$/i),
		).not.toBeInTheDocument();

		// Toggle back to Single URL.
		await user.click(screen.getByRole("tab", { name: /Single URL/i }));
		await screen.findByLabelText("URL");
		expect(
			screen.queryByLabelText(/URLs \(one per line\)/i),
		).not.toBeInTheDocument();
	});

	it("shows the live count and 'Add N URLs' submit copy for a valid batch", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		const { user } = await openLinkTabInBulkMode();

		const textarea = screen.getByLabelText(/URLs \(one per line\)/i);
		await user.type(
			textarea,
			[
				"https://example.com/a",
				"https://example.com/b",
				"https://example.com/c",
			].join("\n"),
		);

		// Preview: "3 URLs ready to add" (count surfaced in preview).
		await waitFor(() => {
			expect(screen.getByText(/URLs ready to add/i)).toBeInTheDocument();
		});
		// And the submit button copy reflects the count.
		const submit = screen.getByRole("button", {
			name: /Add 3 URLs/i,
		});
		expect(submit).not.toBeDisabled();
	});

	// Bug 4 — duplicates inside the paste are now collapsed silently in
	// the valid stream and surfaced in the preview as "N duplicates skipped"
	// so the user understands why the textarea count doesn't match the
	// submit count.
	it("renders 'duplicates skipped' when the paste contains repeats", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		const { user } = await openLinkTabInBulkMode();

		const textarea = screen.getByLabelText(/URLs \(one per line\)/i);
		await user.click(textarea);
		await user.paste(
			[
				"https://example.com/a",
				"https://EXAMPLE.com/a/",
				"https://example.com/a",
			].join("\n"),
		);

		await waitFor(() => {
			expect(screen.getByText(/duplicates skipped/i)).toBeInTheDocument();
		});
		// The submit button reflects the deduped count of 1, not 3.
		expect(
			screen.getByRole("button", { name: /Add 1 URL/i }),
		).not.toBeDisabled();
	});

	it("lists invalid lines with their line numbers and disables submit", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		const { user } = await openLinkTabInBulkMode();

		const textarea = screen.getByLabelText(/URLs \(one per line\)/i);
		await user.type(
			textarea,
			[
				"https://example.com/ok",
				"not-a-url", // invalid → line 2
				"http://example.com/notls", // not https → line 3
			].join("\n"),
		);

		await waitFor(() => {
			expect(
				screen.getByText(/lines? couldn.+t be parsed/i),
			).toBeInTheDocument();
		});
		expect(screen.getByText(/line 2:/i)).toBeInTheDocument();
		expect(screen.getByText(/line 3:/i)).toBeInTheDocument();

		// Submit is disabled because there are invalid lines.
		const submit = screen.getByRole("button", { name: /Add .+ URLs?/i });
		expect(submit).toBeDisabled();
	});

	it("shows the >50 limit message and disables submit when too many URLs are pasted", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		const { user } = await openLinkTabInBulkMode();

		const textarea = screen.getByLabelText(/URLs \(one per line\)/i);
		const lines = Array.from(
			{ length: 51 },
			(_, i) => `https://example.com/${i}`,
		).join("\n");
		// userEvent.type would be slow with 51 lines; paste instead.
		await user.click(textarea);
		await user.paste(lines);

		await waitFor(() => {
			expect(
				screen.getByText(/limited to 50 URLs at a time/i),
			).toBeInTheDocument();
		});
		const submit = screen.getByRole("button", { name: /Add .+ URL/i });
		expect(submit).toBeDisabled();
	});

	it("fires N parallel processLink calls on submit and shows the progress card", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		// Make each call resolve after a microtask so the progress card has
		// time to render before the summary swaps in.
		processLinkMock.mockImplementation(
			() => new Promise((resolve) => setTimeout(resolve, 0)),
		);
		const { user } = await openLinkTabInBulkMode();

		const textarea = screen.getByLabelText(/URLs \(one per line\)/i);
		await user.click(textarea);
		await user.paste(
			["https://example.com/a", "https://example.com/b"].join("\n"),
		);

		await user.click(screen.getByRole("button", { name: /Add 2 URLs/i }));

		// Two processLink calls fired in parallel — exactly one per URL.
		await waitFor(() => {
			expect(processLinkMock).toHaveBeenCalledTimes(2);
		});
		const urls = processLinkMock.mock.calls
			.map((c) => (c[0] as { url: string }).url)
			.sort();
		expect(urls).toEqual([
			"https://example.com/a",
			"https://example.com/b",
		]);

		// After all calls settle, the summary card appears ("N added.").
		// Match the full summary copy rather than the bare count — the
		// digit "2" appears in several places (preview count, progress
		// card max, etc.).
		await waitFor(() => {
			const adds = screen.queryAllByText(/added\.?/i);
			expect(adds.length).toBeGreaterThan(0);
		});
	});

	it("lists per-URL failures in the post-settle summary", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		// First call succeeds, second fails.
		processLinkMock.mockImplementationOnce(() => Promise.resolve());
		processLinkMock.mockImplementationOnce(() =>
			Promise.reject(new Error("Boom on B")),
		);
		const { user } = await openLinkTabInBulkMode();

		const textarea = screen.getByLabelText(/URLs \(one per line\)/i);
		await user.click(textarea);
		await user.paste(
			["https://example.com/a", "https://example.com/b"].join("\n"),
		);

		await user.click(screen.getByRole("button", { name: /Add 2 URLs/i }));

		// Summary lists the failed URL inline. The error message is unique
		// to the summary card so we use it as the assertion anchor; the
		// failed URL appears in both the textarea and the summary.
		await waitFor(() => {
			expect(processLinkMock).toHaveBeenCalledTimes(2);
		});
		await waitFor(() => {
			expect(screen.getByText(/Boom on B/i)).toBeInTheDocument();
		});
		// "1 added" / "1 failed" should appear in the summary card.
		expect(screen.getByText(/failed\./i)).toBeInTheDocument();
	});

	it("banned-token regression net stays clean across bulk-mode states", async () => {
		getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
		const { user, rendered } = await openLinkTabInBulkMode();

		const textarea = screen.getByLabelText(/URLs \(one per line\)/i);
		await user.click(textarea);
		await user.paste(["https://example.com/a", "not-a-url"].join("\n"));
		// Cover both happy preview and invalid-line listing in the same
		// snapshot.
		await waitFor(() => {
			expect(screen.getByText(/URL ready to add/i)).toBeInTheDocument();
		});
		assertNoBannedTokens(rendered.container, "bulk mode with mixed input");
	});
});
