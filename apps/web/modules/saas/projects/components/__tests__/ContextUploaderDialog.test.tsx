/**
 * Component tests for ContextUploaderDialog — Group 9 editorial cleanup.
 *
 * Spec:
 * - fabric/specs/2026-05-13-url-context-sources/spec.md §9.1 (editorial cleanup paragraph)
 * - fabric/specs/2026-05-13-url-context-sources/tasks.md Group 9
 * - CLAUDE.md "Explicit anti-patterns to eliminate"
 *
 * Scope:
 *  1. Every tab (File · Link · Text · Teams · Slack · Notion) renders without
 *     crashing and surfaces its expected affordance.
 *  2. Editorial-aesthetic guardrail: rendered markup contains zero gradient
 *     pills, hardcoded hex colors, `backdrop-blur`, or `animate-pulse … blur-[…]`
 *     orbs. This is the snapshot-style regression net referenced by
 *     tasks.md §9.3 — we assert on banned class fragments instead of a brittle
 *     full DOM snapshot, which would churn on every Radix/shadcn upgrade.
 *  3. Form bindings + handlers preserved: typing into the Link URL field and
 *     submitting triggers `orpcClient.projects.contexts.processLink` with the
 *     entered URL — proves Group 9's token swap did not break behaviour.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── jsdom polyfills ──────────────────────────────────────────────────────
// Radix Tooltip and Dialog pull in @radix-ui/react-use-size which references
// ResizeObserver on effect mount.
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
	// Radix Dialog focus-trap calls hasPointerCapture / scrollIntoView which
	// jsdom does not implement.
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
	mcpConfigsListMock,
	contextsListMock,
	getUserSearchProvidersMock,
	getOrgSearchProvidersMock,
	trackEventMock,
} = vi.hoisted(() => ({
	processLinkMock: vi.fn(),
	mcpConfigsListMock: vi.fn(),
	contextsListMock: vi.fn(),
	// Pre-flight now reads the unified searchProviders table. The legacy
	// firecrawl.getConfig endpoints are no longer called from the dialog.
	getUserSearchProvidersMock: vi.fn(),
	getOrgSearchProvidersMock: vi.fn(),
	trackEventMock: vi.fn(),
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
			// Personal-context pre-flight calls getUserProviders().
			getUserProviders: () => getUserSearchProvidersMock(),
			// Org-context pre-flight calls getOrganizationProviders({ organizationId }).
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

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: trackEventMock }),
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

// useOrganizationContext provides org id + slug + basePath. Personal context →
// organizationId: null, organizationSlug: null, basePath: "/app".
vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		basePath: "/app",
	}),
}));

vi.mock("@saas/settings/hooks/use-settings-return-url", () => ({
	useSettingsReturnUrl: () => (path: string) => path,
}));

// Stub heavy sibling dialogs — Group 9 is purely about the parent dialog
// surface; the selector dialogs each pull in their own oRPC + Radix trees
// that we do not want to wire up here.
vi.mock("../NotionResourceBrowser", () => ({
	NotionResourceBrowser: () => null,
}));
vi.mock("../ConfluenceResourceBrowser", () => ({
	ConfluenceResourceBrowser: () => null,
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

// next-intl is globally mocked in vitest.setup.ts to echo keys.

// Import the SUT after mocks so vitest wires the factories correctly.
import { ContextUploaderDialog } from "../ContextUploaderDialog";

// ── Helpers ──────────────────────────────────────────────────────────────

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
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
		pattern: /#[0-9a-fA-F]{3,8}\b/,
	},
];

function assertNoBannedTokens(root: HTMLElement) {
	const html = root.innerHTML;
	for (const { name, pattern } of banned) {
		expect(
			pattern.test(html),
			`Editorial-aesthetic regression: rendered markup contains ${name}.`,
		).toBe(false);
	}
}

// Tab triggers are uniquely identified by `id="context-tab-{tabId}"`. Using
// the id attribute sidesteps quirks in accessible-name computation
// (e.g. NotionIcon's `<svg role="img" aria-labelledby>` contributes "Notion"
// to the button's name, yielding "Notion Notion" — a brittle name to match).
function getTabTrigger(id: string): HTMLElement {
	const el = document.getElementById(`context-tab-${id}`);
	if (!el) {
		throw new Error(`Tab trigger #context-tab-${id} not found`);
	}
	return el;
}

// ── Tests ────────────────────────────────────────────────────────────────

// Canonical row returned by `searchProviders.get*Providers()` — a stored
// row for `firecrawl` with `enabled: true` and a non-null `maskedApiKey`
// is the precondition for the URL form to render without the pre-flight
// notice. Shape mirrors the procedure output contract.
const FIRECRAWL_CONFIGURED_ROW = {
	id: "row_fc_1",
	providerName: "firecrawl" as const,
	maskedApiKey: "fc-***-1234",
	endpoint: null,
	isDefault: true,
	priority: 0,
	enabled: true,
	lastUsedAt: null,
	searchesCount: 0,
	totalCost: 0,
};

describe("ContextUploaderDialog — editorial cleanup", () => {
	beforeEach(() => {
		processLinkMock.mockReset();
		mcpConfigsListMock.mockReset();
		contextsListMock.mockReset();
		getUserSearchProvidersMock.mockReset();
		getOrgSearchProvidersMock.mockReset();
		trackEventMock.mockReset();
		mcpConfigsListMock.mockResolvedValue([]);
		contextsListMock.mockResolvedValue({ contexts: [] });
		getUserSearchProvidersMock.mockResolvedValue([
			FIRECRAWL_CONFIGURED_ROW,
		]);
		getOrgSearchProvidersMock.mockResolvedValue([FIRECRAWL_CONFIGURED_ROW]);
	});

	it("renders the default (File) tab without crashing and exposes Browse Files", () => {
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		// DialogTitle renders as <h2> — disambiguates from the footer button
		// of the same text.
		expect(
			screen.getByRole("heading", { name: /Add Context/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Browse Files/i }),
		).toBeInTheDocument();
	});

	it("renders every tab trigger and switching to each surfaces its content", async () => {
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		const tabIds = [
			"file",
			"link",
			"text",
			"teams",
			"slack",
			"notion",
			"confluence",
		];
		for (const id of tabIds) {
			const trigger = getTabTrigger(id);
			expect(trigger.getAttribute("role")).toBe("tab");
			expect(trigger).toBeInTheDocument();
		}

		// Switch tabs and assert each tabpanel shows up.
		await user.click(getTabTrigger("link"));
		expect(screen.getByLabelText("URL")).toBeInTheDocument();

		await user.click(getTabTrigger("text"));
		expect(screen.getByLabelText("Content")).toBeInTheDocument();

		await user.click(getTabTrigger("teams"));
		expect(
			screen.getByRole("button", { name: /Select Teams Chats/i }),
		).toBeInTheDocument();

		await user.click(getTabTrigger("slack"));
		expect(
			screen.getByRole("button", { name: /Select Slack Channels/i }),
		).toBeInTheDocument();

		await user.click(getTabTrigger("notion"));
		// Empty MCP-configs list resolves to the "Configure MCP" affordance.
		await waitFor(() => {
			expect(
				screen.getByRole("link", { name: /Configure MCP/i }),
			).toBeInTheDocument();
		});

		await user.click(getTabTrigger("file"));
		expect(
			screen.getByRole("button", { name: /Browse Files/i }),
		).toBeInTheDocument();
	});

	it("Confluence tab: shows the no-config empty state when no Confluence MCP config exists (AC1.1/AC1.2)", async () => {
		const user = userEvent.setup();
		// mcpConfigsListMock defaults to [] in beforeEach.
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		// Tab is present regardless of config (always in allTabs).
		expect(getTabTrigger("confluence").getAttribute("role")).toBe("tab");

		await user.click(getTabTrigger("confluence"));
		await waitFor(() => {
			expect(
				screen.getByText(/No Confluence MCP server configured/i),
			).toBeInTheDocument();
		});
		expect(
			screen.queryByRole("button", { name: /Browse Confluence Pages/i }),
		).not.toBeInTheDocument();
	});

	it("Confluence tab: shows Browse when a Confluence config is detected via catalog tags (AC1.4/AC3.1)", async () => {
		const user = userEvent.setup();
		// Detected by the stable catalog signal (tags), NOT the user-set name.
		mcpConfigsListMock.mockResolvedValue([
			{
				id: "cfg-confluence-1",
				enabled: true,
				mcpServer: { key: "atlassian", tags: ["jira", "confluence"] },
			},
		]);

		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		await user.click(getTabTrigger("confluence"));
		await waitFor(() => {
			expect(
				screen.getByRole("button", {
					name: /Browse Confluence Pages/i,
				}),
			).toBeInTheDocument();
		});
	});

	it("contains no banned editorial-aesthetic class fragments in any tab's rendered markup", async () => {
		const user = userEvent.setup();
		const { container } = wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		// Each tab gets its own snapshot scan — the cleanup must hold for the
		// whole dialog, not just the default tab.
		assertNoBannedTokens(container);

		for (const id of ["link", "text", "teams", "slack", "notion"]) {
			await user.click(getTabTrigger(id));
			assertNoBannedTokens(container);
		}
	});

	it("preserves Link-tab handler: submit forwards entered URL to processLink", async () => {
		// Firecrawl pre-flight is mocked CONFIGURED above so the URL form
		// renders without the disabled-submit notice. The URL Context Sources
		// form forwards scope + refreshMode alongside the URL.
		processLinkMock.mockResolvedValueOnce(undefined);
		const onOpenChange = vi.fn();
		const user = userEvent.setup();

		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={onOpenChange}
			/>,
		);

		await user.click(getTabTrigger("link"));
		await user.type(
			screen.getByLabelText("URL"),
			"https://example.com/article",
		);

		// Footer "Add Context" button — present on file/link/text tabs.
		// Disambiguates from the DialogTitle heading via role: "button".
		await user.click(
			screen.getByRole("button", { name: /^Add Context$/i }),
		);

		await waitFor(() => {
			expect(processLinkMock).toHaveBeenCalledTimes(1);
		});
		// Leaf URL → auto-detect picks SINGLE_PAGE and the maxPages stepper
		// stays hidden, so the payload contains only the required fields.
		expect(processLinkMock).toHaveBeenCalledWith({
			projectId: "proj_1",
			url: "https://example.com/article",
			scope: "SINGLE_PAGE",
			refreshMode: "ONCE",
		});
	});
});
