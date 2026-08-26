/**
 * Tests for ConfluencePageSelector
 * (confluence-project-context-source spec FR6 / FR7-DELTA #1 & #2 / Task 2.1).
 *
 *  - AC6.1: a syncedPageIds page renders disabled and cannot be selected.
 *  - FR7-DELTA #2: a selection made via search then navigated away confirms with
 *    a real title (from the accumulated known-pages map), never the raw page id.
 *
 * next-intl is mocked globally in apps/web/vitest.setup.ts.
 */

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
import { ConfluencePageSelector } from "../ConfluencePageSelector";

const mockFetch = vi.fn();

beforeAll(() => {
	if (typeof Element.prototype.hasPointerCapture === "undefined") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => undefined;
	}
	if (typeof globalThis.ResizeObserver === "undefined") {
		class RO {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as { ResizeObserver: typeof RO }
		).ResizeObserver = RO;
	}
});

const SPACES_TOOL = "confluence_get_spaces";
const PAGES_TOOL = "get_pages_in_space";
const SEARCH_TOOL = "confluence_search";

/**
 * Route each /api/pipeline/mcp-tool POST by its body so the mock is robust
 * against React effect re-runs (no brittle call-order queue).
 */
function routeFetch(opts: {
	tools: string[];
	spaces?: Array<Record<string, unknown>>;
	spacePages?: Array<Record<string, unknown>>;
	searchPages?: Array<Record<string, unknown>>;
}) {
	return vi.fn(async (_url: string, init?: RequestInit) => {
		const body = JSON.parse((init?.body as string) ?? "{}");
		let payload: unknown = {};
		if (body.action === "list_tools") {
			payload = { tools: opts.tools };
		} else if (body.toolName === SPACES_TOOL) {
			payload = { result: opts.spaces ?? [] };
		} else if (body.toolName === PAGES_TOOL) {
			payload = { result: opts.spacePages ?? [] };
		} else if (body.toolName === SEARCH_TOOL) {
			payload = { result: opts.searchPages ?? [] };
		}
		return { ok: true, json: async () => payload } as Response;
	});
}

const baseProps = {
	open: true,
	onOpenChange: vi.fn(),
	mcpConfigId: "cfg-1",
	organizationId: "org-1" as string | null,
};

describe("ConfluencePageSelector", () => {
	beforeEach(() => {
		mockFetch.mockReset();
		global.fetch = mockFetch;
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("renders a synced page disabled and uncheckable with an 'Added' affordance (AC6.1)", async () => {
		global.fetch = routeFetch({
			tools: [SPACES_TOOL, PAGES_TOOL],
			spaces: [{ key: "ENG", name: "Engineering" }],
			spacePages: [
				{ id: "p1", title: "Page One", spaceKey: "ENG" },
				{ id: "p2", title: "Page Two", spaceKey: "ENG" },
			],
		}) as unknown as typeof fetch;

		const onConfirm = vi.fn();
		render(
			<ConfluencePageSelector
				{...baseProps}
				syncedPageIds={["p1"]}
				onConfirm={onConfirm}
			/>,
		);

		// Navigate into the space to list pages.
		const space = await screen.findByText("Engineering");
		await userEvent.click(space);

		const pageOne = await screen.findByText("Page One");
		const row = pageOne.closest("div.flex") as HTMLElement;

		// The synced row shows the "Added" affordance and a disabled checkbox.
		expect(within(row).getByText("Added")).toBeInTheDocument();
		const checkbox = within(row).getByRole("checkbox");
		expect(checkbox).toBeDisabled();

		// Clicking it does nothing — selection stays empty, so confirm is blocked.
		await userEvent.click(pageOne);
		const addBtn = screen.getByRole("button", { name: /Add 0 Page/i });
		expect(addBtn).toBeDisabled();
	});

	it("confirms a search-then-navigated-away selection with a real title, not the raw id (FR7-DELTA #2)", async () => {
		global.fetch = routeFetch({
			tools: [SEARCH_TOOL, SPACES_TOOL, PAGES_TOOL],
			spaces: [{ key: "ENG", name: "Engineering" }],
			spacePages: [{ id: "p2", title: "Page Two", spaceKey: "ENG" }],
			searchPages: [{ id: "p1", title: "Page One", spaceKey: "ENG" }],
		}) as unknown as typeof fetch;

		const onConfirm = vi.fn();
		render(<ConfluencePageSelector {...baseProps} onConfirm={onConfirm} />);

		// Search at root surfaces p1.
		const searchBox = await screen.findByPlaceholderText(/search/i);
		await userEvent.type(searchBox, "Page One");

		const pageOne = await screen.findByText("Page One");
		await userEvent.click(pageOne);

		// Clear the search to return to the spaces view, then navigate into a
		// space whose listing does NOT include p1 — so p1 leaves `pages` but
		// stays selected.
		await userEvent.clear(searchBox);
		const space = await screen.findByText("Engineering");
		await userEvent.click(space);
		await screen.findByText("Page Two");

		// Confirm — p1 must resolve to its real title via the known-pages map.
		const addBtn = await screen.findByRole("button", {
			name: /Add 1 Page/i,
		});
		await userEvent.click(addBtn);

		await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
		const confirmed = onConfirm.mock.calls[0][0] as Array<{
			pageId: string;
			title: string;
			spaceKey: string;
		}>;
		const p1 = confirmed.find((c) => c.pageId === "p1");
		expect(p1).toBeDefined();
		expect(p1?.title).toBe("Page One");
		expect(p1?.title).not.toBe("p1");
		expect(p1?.spaceKey).toBe("ENG");
	});
});

// ── Atlassian Rovo (official Atlassian MCP) ─────────────────────────────────
// Rovo tools are camelCase (searchConfluenceUsingCql / getConfluenceSpaces /
// getPagesInConfluenceSpace) and key pages-in-space on the opaque spaceId, not
// the space key. cloudId is injected server-side, so the client sends none.
describe("ConfluencePageSelector — Atlassian Rovo tools", () => {
	const ROVO_TOOLS = [
		"getAccessibleAtlassianResources",
		"getConfluenceSpaces",
		"getPagesInConfluenceSpace",
		"searchConfluenceUsingCql",
		"getConfluencePage",
	];

	type Call = { toolName?: string; params?: Record<string, unknown> };

	function rovoFetch(calls: Call[]) {
		return vi.fn(async (_url: string, init?: RequestInit) => {
			const body = JSON.parse((init?.body as string) ?? "{}");
			calls.push({ toolName: body.toolName, params: body.params });
			let payload: unknown = {};
			if (body.action === "list_tools") {
				payload = { tools: ROVO_TOOLS };
			} else if (body.toolName === "getConfluenceSpaces") {
				payload = {
					result: {
						results: [
							{ id: "100", key: "ENG", name: "Engineering" },
						],
					},
				};
			} else if (body.toolName === "getPagesInConfluenceSpace") {
				payload = {
					result: {
						results: [
							{ id: "p1", title: "Rovo Page", spaceId: "100" },
						],
					},
				};
			} else if (body.toolName === "searchConfluenceUsingCql") {
				// CQL search nests the page under `content`.
				payload = {
					result: {
						results: [
							{
								content: {
									id: "p9",
									title: "Found Page",
									space: { key: "ENG", name: "Engineering" },
								},
							},
						],
					},
				};
			}
			return { ok: true, json: async () => payload } as Response;
		});
	}

	beforeEach(() => {
		mockFetch.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("detects camelCase Rovo tools and lists spaces (no 'Missing required tools')", async () => {
		const calls: Call[] = [];
		global.fetch = rovoFetch(calls) as unknown as typeof fetch;

		render(<ConfluencePageSelector {...baseProps} onConfirm={vi.fn()} />);

		expect(await screen.findByText("Engineering")).toBeInTheDocument();
		expect(
			screen.queryByText("Missing required tools"),
		).not.toBeInTheDocument();
	});

	it("sends the space's numeric id as spaceId when listing pages in a space", async () => {
		const calls: Call[] = [];
		global.fetch = rovoFetch(calls) as unknown as typeof fetch;

		render(<ConfluencePageSelector {...baseProps} onConfirm={vi.fn()} />);

		const space = await screen.findByText("Engineering");
		await userEvent.click(space);
		await screen.findByText("Rovo Page");

		const pagesCall = calls.find(
			(c) => c.toolName === "getPagesInConfluenceSpace",
		);
		expect(pagesCall?.params).toEqual({ spaceId: "100" });
	});

	it("builds a CQL query, parses nested results, and shows body-match hits whose title doesn't contain the query", async () => {
		const calls: Call[] = [];
		global.fetch = rovoFetch(calls) as unknown as typeof fetch;

		render(<ConfluencePageSelector {...baseProps} onConfirm={vi.fn()} />);

		const searchBox = await screen.findByPlaceholderText(/search/i);
		// "design" matches the page body server-side; the result title "Found
		// Page" does NOT contain it — the client title filter must not hide it.
		await userEvent.type(searchBox, "design");

		await screen.findByText("Found Page");

		const searchCall = calls.find(
			(c) => c.toolName === "searchConfluenceUsingCql",
		);
		expect(searchCall?.params).toEqual({ cql: 'text ~ "design"' });
	});
});
