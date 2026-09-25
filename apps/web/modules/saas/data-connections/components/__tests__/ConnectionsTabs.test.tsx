/**
 * Mocked at the boundary, like the sibling ConnectionsPageContent test.
 *
 * Two stubs are load-bearing rather than incidental:
 *
 * - `PageTourButton` calls `useFeatureFlag` unconditionally, above its own
 *   early return, and `useFeatureFlag` throws by design without a provider.
 *   Stubbing it is smaller than wrapping every case in a FeatureFlagProvider.
 *   The stub echoes its `pageId` instead of rendering nothing: which tour this
 *   header launches is itself behavior worth pinning now that one route
 *   carries two of them.
 * - `next/navigation` is re-mocked locally. The global setup stub hands back an
 *   empty URLSearchParams, which is fine for the default tab and useless for
 *   every other one, since the tab is read from the query string.
 * - `ConnectionsPageContent` is replaced by a placeholder that renders
 *   `toolbarStart`. That keeps the real component's query/oRPC graph out of
 *   these cases, and — because the segmented control reaches the child as a
 *   prop rather than as a sibling — it is also what makes the DOM-order
 *   assertion below meaningful instead of self-referential. The placeholder
 *   carries an error branch so the composed error page can be asserted.
 */

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConnectionsTabs } from "../ConnectionsTabs";

const state = vi.hoisted(() => ({ childFails: false, search: "" }));

const mockReplace = vi.fn();

vi.mock("next/navigation", () => ({
	useRouter: () => ({
		replace: mockReplace,
		push: vi.fn(),
		prefetch: vi.fn(),
	}),
	usePathname: () => "/app/example-org/connections",
	useSearchParams: () => new URLSearchParams(state.search),
}));

vi.mock("@saas/mcp/components/McpServersView", () => ({
	McpServersView: ({
		initialRegistrySearch,
		onServerParamConsumed,
	}: {
		initialRegistrySearch?: string;
		onServerParamConsumed?: () => void;
	}) => (
		<div data-testid="mcp-servers-view" data-search={initialRegistrySearch}>
			<button
				type="button"
				data-testid="consume-btn"
				onClick={() => onServerParamConsumed?.()}
			>
				Consume
			</button>
		</div>
	),
}));

vi.mock("@saas/get-started/components/PageTourButton", () => ({
	PageTourButton: ({ pageId }: { pageId: string }) => (
		<span data-testid="page-tour" data-page-id={pageId} />
	),
}));

vi.mock("../ConnectionsPageContent", () => ({
	ConnectionsPageContent: ({ toolbarStart }: { toolbarStart?: ReactNode }) =>
		// Neutral marker, not the real failure copy: asserting a string this
		// factory itself supplies would only prove the stub ran. The real
		// error text is pinned against the real component in
		// ConnectionsPageContent.test.tsx.
		state.childFails ? (
			<div data-testid="child-error" />
		) : (
			<div data-testid="child">{toolbarStart}</div>
		),
}));

const renderTabs = () =>
	render(
		<ConnectionsTabs
			addHref="/app/example-org/settings/integrations/add"
			settingsBasePath="/app/example-org/settings/integrations"
			organizationId="org_example"
		/>,
	);

/** The approved copy, asserted by its distinguishing clauses rather than as
 *  one 480-character string, so a reworded sentence names which claim broke. */
const introParagraph = () =>
	screen.getByText(/Connections let Fabric agents work with tools/i);

describe("ConnectionsTabs", () => {
	beforeEach(() => {
		mockReplace.mockReset();
		state.childFails = false;
		state.search = "";
	});

	// Covers AC6. This pins behavior that already ships — the heading was
	// renamed before this ticket — so that it cannot silently revert.
	it("renders the page heading as Connections", () => {
		renderTabs();

		expect(
			screen.getByRole("heading", { level: 1, name: "Connections" }),
		).toBeInTheDocument();
	});

	// Covers AC7, for this component's own composition only.
	//
	// The child is stubbed, so this pins the order of *this file's* JSX —
	// intro before <ConnectionsPageContent> — which is what the change
	// actually moved. It cannot speak for where the real child puts
	// `toolbarStart` inside its own subtree; ConnectionsPageContent.test.tsx
	// owns that half of the ordering claim.
	it("renders the intro paragraph above the connections list component", () => {
		renderTabs();

		const intro = introParagraph();
		const child = screen.getByTestId("child");

		expect(
			intro.compareDocumentPosition(child) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			within(child).getByRole("group", { name: "Connection type" }),
		).toBeInTheDocument();
	});

	// Covers AC8.
	it("explains that Integrations are Fabric-native connectors", () => {
		renderTabs();

		expect(introParagraph()).toHaveTextContent(
			/Integrations are Fabric-native connectors for commonly used apps like GitHub, Slack, Jira, Google Drive, and Teams/i,
		);
	});

	// Covers AC9.
	it("explains what MCP servers reach and by which protocol", () => {
		renderTabs();

		expect(introParagraph()).toHaveTextContent(
			/MCP servers connect Fabric to custom tools, internal systems, databases, scripts, or niche SaaS apps through the Model Context Protocol/i,
		);
	});

	// Covers AC10.
	it("states why both kinds live under Connections", () => {
		renderTabs();

		expect(introParagraph()).toHaveTextContent(
			/Connections let Fabric agents work with tools and systems outside of Fabric/i,
		);
	});

	// Guards the decision to drop PageHeader's own description: restoring it
	// would put two near-duplicate muted paragraphs above the toolbar.
	it("renders exactly one explanatory paragraph above the control", () => {
		const { container } = renderTabs();

		const muted = container.querySelectorAll("p.text-muted-foreground");

		expect(muted).toHaveLength(1);
	});

	// Guards the wide-screen readability decision: this page has no max-width
	// container, so without the clamp the paragraph runs ~200 chars per line.
	it("clamps the intro paragraph's measure", () => {
		renderTabs();

		expect(introParagraph()).toHaveClass("max-w-2xl");
	});

	// Integrations remains a real sub-kind of Connections. Guards it against
	// being swept up in the destination rename.
	it("still offers All, Integrations and MCP servers as connection types", () => {
		renderTabs();

		const control = screen.getByRole("group", { name: "Connection type" });

		expect(control).toHaveTextContent("All");
		expect(control).toHaveTextContent("Integrations");
		expect(control).toHaveTextContent("MCP servers");
	});

	// The child returns early on error and never renders the toolbar, so the
	// intro is the only orientation left on a page that has otherwise failed.
	// Keeping it is deliberate; this pins it so the composition does not read
	// as an oversight later.
	it("keeps the intro paragraph when the connections list fails to load", () => {
		state.childFails = true;
		renderTabs();

		expect(introParagraph()).toBeInTheDocument();
		expect(screen.getByTestId("child-error")).toBeInTheDocument();
		expect(
			screen.queryByRole("group", { name: "Connection type" }),
		).not.toBeInTheDocument();
	});

	// Covers R10: the same rule, reachable where the choice is actually made.
	//
	// Scoped to the popover on purpose. The decision sentence deliberately
	// appears twice on this page — it is the intro's last sentence and the
	// popover's whole body — so an unscoped query is ambiguous by design
	// rather than by accident.
	it("offers the decision rule on demand at the control", async () => {
		const user = userEvent.setup();
		renderTabs();

		const trigger = screen.getByRole("button", {
			name: "Integrations or MCP servers: which to use",
		});
		expect(trigger).toBeInTheDocument();
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		await user.click(trigger);

		const hint = await screen.findByRole("dialog");

		expect(
			within(hint).getByText(
				"Use an Integration when Fabric already supports the service directly; use an MCP server when you need a custom or protocol-based connection.",
			),
		).toBeInTheDocument();
	});

	// The hint is meant to be the intro's closing sentence word for word, not
	// a paraphrase — two wordings of one rule is how a reader ends up unsure
	// there is only one rule. Without this, either string could be reworded
	// alone and every other test here would still pass.
	it("repeats the intro's closing sentence verbatim in the hint", async () => {
		const user = userEvent.setup();
		renderTabs();

		const introText = introParagraph().textContent ?? "";

		await user.click(
			screen.getByRole("button", {
				name: "Integrations or MCP servers: which to use",
			}),
		);
		const hintText =
			(await screen.findByRole("dialog")).querySelector("p:last-of-type")
				?.textContent ?? "";

		expect(hintText.length).toBeGreaterThan(0);
		expect(introText.endsWith(hintText)).toBe(true);
	});

	// The header's compass opens "this page's" tour, and this route stands in
	// for two pages. The id is pinned per tab because a single constant is both
	// the easy edit and the bug: it showed the integrations walkthrough to
	// someone reading the MCP tab, and left the mcp-servers tour with no
	// launcher at all once /mcp-servers became a redirect.
	const pageTourId = () =>
		screen.getByTestId("page-tour").getAttribute("data-page-id");

	it("launches the integrations tour on the default view", () => {
		renderTabs();

		expect(pageTourId()).toBe("integrations");
	});

	it("launches the integrations tour on the Integrations tab", () => {
		state.search = "tab=integrations";
		renderTabs();

		expect(pageTourId()).toBe("integrations");
	});

	it("launches the MCP servers tour on the MCP servers tab", () => {
		state.search = "tab=mcp";
		renderTabs();

		expect(pageTourId()).toBe("mcp-servers");
	});

	it("passes server query parameter down to McpServersView", () => {
		state.search = "tab=mcp&server=PostgreSQL";
		renderTabs();

		const mcpView = screen.getByTestId("mcp-servers-view");
		expect(mcpView).toHaveAttribute("data-search", "PostgreSQL");
	});

	it("clears server query param with scroll: false when consumed", async () => {
		const user = userEvent.setup();
		state.search = "tab=mcp&server=PostgreSQL";
		renderTabs();

		const consumeBtn = screen.getByTestId("consume-btn");
		await user.click(consumeBtn);

		expect(mockReplace).toHaveBeenCalledWith(
			"/app/example-org/connections?tab=mcp",
			{ scroll: false },
		);
	});
});
