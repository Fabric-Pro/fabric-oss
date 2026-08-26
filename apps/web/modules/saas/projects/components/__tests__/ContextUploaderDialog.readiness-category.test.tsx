/**
 * Knowledge Base Source Category on the Link tab (Fizzy #2165).
 *
 * The project readiness checklist asks whether the project has a knowledge base
 * connected, and answers it by looking for a link source classified as one.
 * Nothing could ever answer yes before this field existed, because there was no
 * way to classify anything — which is the gap these tests close.
 *
 * The sibling suites cover the flag-OFF path (they mock the flag to `false` and
 * assert the exact `processLink` payload, so a stray field would fail them).
 * This file is the flag-ON half.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── jsdom polyfills ──────────────────────────────────────────────────────
// Radix Dialog and Select reach for pointer-capture and layout APIs jsdom does
// not implement.
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
	if (!HTMLElement.prototype.setPointerCapture) {
		HTMLElement.prototype.setPointerCapture = (() => undefined) as never;
	}
	if (!HTMLElement.prototype.releasePointerCapture) {
		HTMLElement.prototype.releasePointerCapture = (() =>
			undefined) as never;
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
} = vi.hoisted(() => ({
	processLinkMock: vi.fn(),
	getUserSearchProvidersMock: vi.fn(),
	getOrgSearchProvidersMock: vi.fn(),
	contextsListMock: vi.fn(),
	mcpConfigsListMock: vi.fn(),
	trackEventMock: vi.fn(),
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => true,
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
			configs: { list: (input: unknown) => mcpConfigsListMock(input) },
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
					}) => ({ mutationFn: vi.fn(), onSuccess, onError }),
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

import { ContextUploaderDialog } from "../ContextUploaderDialog";

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

/** A configured scrape provider, so the Link tab is not blocked by pre-flight. */
const CONFIGURED_ROWS = [
	{
		id: "sp_1",
		providerName: "firecrawl",
		enabled: true,
		maskedApiKey: "fc-…abcd",
	},
];

function getTabTrigger(id: string): HTMLElement {
	const el = document.getElementById(`context-tab-${id}`);
	if (!el) {
		throw new Error(`Tab trigger #context-tab-${id} not found`);
	}
	return el;
}

async function openLinkTab(user: ReturnType<typeof userEvent.setup>) {
	wrap(
		<ContextUploaderDialog
			projectId="proj_1"
			open
			onOpenChange={vi.fn()}
		/>,
	);
	await user.click(getTabTrigger("link"));
	return await screen.findByLabelText("URL");
}

/** The category trigger, which Radix renders as a combobox. */
function categoryTrigger(): HTMLElement {
	return screen.getByRole("combobox", {
		name: /knowledge base source category/i,
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	getUserSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
	getOrgSearchProvidersMock.mockResolvedValue(CONFIGURED_ROWS);
	contextsListMock.mockResolvedValue({ contexts: [] });
	mcpConfigsListMock.mockResolvedValue([]);
	processLinkMock.mockResolvedValue(undefined);
});

describe("Link tab — Knowledge Base Source Category", () => {
	it("shows the field with nothing pre-selected (AC-1)", async () => {
		const user = userEvent.setup();
		await openLinkTab(user);

		const trigger = categoryTrigger();
		expect(trigger).toBeInTheDocument();
		// A default would be a guess put on record as the user's answer.
		expect(trigger).toHaveTextContent(/select a category/i);
	});

	it("offers the eight categories, in the specified order (AC-2)", async () => {
		const user = userEvent.setup();
		await openLinkTab(user);
		await user.click(categoryTrigger());

		const listbox = await screen.findByRole("listbox");
		const labels = within(listbox)
			.getAllByRole("option")
			.map((o) => o.textContent?.trim());

		expect(labels).toEqual([
			"Knowledge Base / Wiki",
			"Product Documentation",
			"Technical / Developer Documentation",
			"API Documentation",
			"Help Center / Support Docs",
			"Marketing Website",
			"Compliance / Security Documentation",
			"Other",
		]);
	});

	it("blocks save and prompts when no category is chosen (AC-4)", async () => {
		const user = userEvent.setup();
		const urlInput = await openLinkTab(user);
		await user.type(urlInput, "https://example.com/docs/intro");

		await user.click(
			screen.getByRole("button", { name: /^Add Context$/i }),
		);

		expect(
			await screen.findByText(/select what kind of source this is/i),
		).toBeInTheDocument();
		// Blocked means blocked — nothing was sent.
		expect(processLinkMock).not.toHaveBeenCalled();
	});

	it("requires a description when the category is Other (AC-3)", async () => {
		const user = userEvent.setup();
		const urlInput = await openLinkTab(user);
		await user.type(urlInput, "https://example.com/docs/intro");

		await user.click(categoryTrigger());
		await user.click(await screen.findByRole("option", { name: "Other" }));

		await user.click(
			screen.getByRole("button", { name: /^Add Context$/i }),
		);

		expect(
			await screen.findByText(/describe the source when the category/i),
		).toBeInTheDocument();
		expect(processLinkMock).not.toHaveBeenCalled();
	});

	it("sends the category once one is chosen", async () => {
		const user = userEvent.setup();
		const urlInput = await openLinkTab(user);
		await user.type(urlInput, "https://example.com/wiki/home");

		await user.click(categoryTrigger());
		await user.click(
			await screen.findByRole("option", {
				name: "Knowledge Base / Wiki",
			}),
		);

		await user.click(
			screen.getByRole("button", { name: /^Add Context$/i }),
		);

		await waitFor(() => expect(processLinkMock).toHaveBeenCalledTimes(1));
		expect(processLinkMock.mock.calls[0][0]).toMatchObject({
			url: "https://example.com/wiki/home",
			knowledgeBaseSourceCategory: "KNOWLEDGE_BASE_WIKI",
		});
		// Only "Other" carries a description.
		expect(processLinkMock.mock.calls[0][0]).not.toHaveProperty(
			"knowledgeBaseSourceCategoryOther",
		);
	});

	it("sends the description alongside Other", async () => {
		const user = userEvent.setup();
		const urlInput = await openLinkTab(user);
		await user.type(urlInput, "https://example.com/runbook");

		await user.click(categoryTrigger());
		await user.click(await screen.findByRole("option", { name: "Other" }));
		await user.type(
			await screen.findByLabelText(/describe the source/i),
			"internal runbook",
		);

		await user.click(
			screen.getByRole("button", { name: /^Add Context$/i }),
		);

		await waitFor(() => expect(processLinkMock).toHaveBeenCalledTimes(1));
		expect(processLinkMock.mock.calls[0][0]).toMatchObject({
			knowledgeBaseSourceCategory: "OTHER",
			knowledgeBaseSourceCategoryOther: "internal runbook",
		});
	});
});

/**
 * The guard and the payload also run on the bulk-paste path, which is a separate
 * handler. Nothing in the single-URL tests reaches it — a broken bulk guard would
 * have shipped silently.
 */
describe("Link tab — category on a bulk paste", () => {
	async function openBulkMode(user: ReturnType<typeof userEvent.setup>) {
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);
		await user.click(getTabTrigger("link"));
		await user.click(
			await screen.findByRole("tab", { name: /Multiple URLs/i }),
		);
		return await screen.findByLabelText(/urls \(one per line\)/i);
	}

	it("blocks the whole batch when no category is chosen", async () => {
		const user = userEvent.setup();
		const textarea = await openBulkMode(user);
		await user.type(
			textarea,
			"https://example.com/a{Enter}https://example.com/b",
		);

		await user.click(
			screen.getByRole("button", { name: /Add \d+ URLs?/i }),
		);

		expect(
			await screen.findByText(/select what kind of source this is/i),
		).toBeInTheDocument();
		expect(processLinkMock).not.toHaveBeenCalled();
	});

	it("applies one classification to every URL in the batch", async () => {
		const user = userEvent.setup();
		const textarea = await openBulkMode(user);
		await user.type(
			textarea,
			"https://example.com/a{Enter}https://example.com/b",
		);

		await user.click(categoryTrigger());
		await user.click(
			await screen.findByRole("option", {
				name: "Product Documentation",
			}),
		);

		await user.click(
			screen.getByRole("button", { name: /Add \d+ URLs?/i }),
		);

		await waitFor(() => expect(processLinkMock).toHaveBeenCalledTimes(2));
		for (const call of processLinkMock.mock.calls) {
			expect(call[0]).toMatchObject({
				knowledgeBaseSourceCategory: "PRODUCT_DOCUMENTATION",
			});
		}
	});
});
