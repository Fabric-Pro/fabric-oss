import { PromptPreviewSheet } from "@saas/prompts/components/PromptPreviewSheet";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Spec: specs/2026-06-10-prompt-card-cropped-ui/spec.md §7.1.
// Guards the cropped-preview-Sheet fix:
//   - AC1: the truncated title/description expose their full text via a
//     hover-activated, NON-native tooltip (never `title=""`). The full text
//     also stays in the DOM/accessibility tree (CSS truncation is visual
//     only), so screen-reader users get it without the tooltip.
//   - AC2: the bottom action bar renders in both read and edit mode.
//   - AC3: the read-mode scroll region no longer carries the
//     `h-[calc(100vh-320px)]` magic-number height that pushed the footer
//     below the Sheet bounds.

const LONG_TITLE =
	"Duplicate Merge — Acceptance Criteria Combiner For Confirmed Duplicate Backlog Items";
const LONG_DESCRIPTION =
	"Combines the acceptance criteria of two confirmed-duplicate backlog items into one set, folding in anything unique either side adds and removing only true redundancy.";

const { getById } = vi.hoisted(() => ({ getById: vi.fn() }));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		prompts: {
			get: {
				byId: {
					queryOptions: ({ input }: { input: unknown }) => ({
						queryKey: ["prompts.get.byId", input],
						queryFn: () => getById(input),
					}),
				},
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: {
			version: { create: vi.fn() },
			fork: { fork: vi.fn() },
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		basePath: "/app",
	}),
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

// Isolate the Sheet from the scope-badge's own data needs.
vi.mock("@saas/prompts/components/PromptScopeBadge", () => ({
	PromptScopeBadge: ({ scope }: { scope: string }) => <span>{scope}</span>,
}));

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

const basePrompt = {
	id: "p1",
	name: LONG_TITLE,
	description: LONG_DESCRIPTION,
	scope: "USER",
	format: "PLAIN_TEXT",
	category: null,
	tags: [],
	versions: [{ id: "ver-1", version: 1, content: "Body content here." }],
};

describe("PromptPreviewSheet — cropped-preview fix", () => {
	beforeEach(() => {
		getById.mockReset();
		getById.mockResolvedValue(basePrompt);
	});

	it("reveals the full title via a hover-activated, non-native tooltip (AC1)", async () => {
		const user = userEvent.setup();
		wrap(
			<PromptPreviewSheet
				open
				onOpenChange={vi.fn()}
				promptId="p1"
				promptScope="USER"
			/>,
		);

		const titleTrigger = await screen.findByText(LONG_TITLE);
		// The full text must be revealed by the Tooltip primitive, never a
		// native `title=""` attribute (which ignores i18n + the 500ms delay).
		expect(titleTrigger).not.toHaveAttribute("title");
		// Wired to the Radix Tooltip, not a plain truncated node.
		expect(titleTrigger).toHaveAttribute("data-slot", "tooltip-trigger");

		await user.hover(titleTrigger);

		const tooltip = await screen.findByRole(
			"tooltip",
			{},
			{ timeout: 2000 },
		);
		expect(tooltip).toHaveTextContent(LONG_TITLE);
	});

	it("reveals the full description via a hover-activated, non-native tooltip (AC1)", async () => {
		const user = userEvent.setup();
		wrap(
			<PromptPreviewSheet
				open
				onOpenChange={vi.fn()}
				promptId="p1"
				promptScope="USER"
			/>,
		);

		const descriptionTrigger = await screen.findByText(LONG_DESCRIPTION);
		expect(descriptionTrigger).not.toHaveAttribute("title");
		expect(descriptionTrigger).toHaveAttribute(
			"data-slot",
			"tooltip-trigger",
		);

		await user.hover(descriptionTrigger);

		const tooltip = await screen.findByRole(
			"tooltip",
			{},
			{ timeout: 2000 },
		);
		expect(tooltip).toHaveTextContent(LONG_DESCRIPTION);
	});

	it("does not render the h-[calc(100vh-320px)] magic-number height (AC3)", async () => {
		const { container } = wrap(
			<PromptPreviewSheet
				open
				onOpenChange={vi.fn()}
				promptId="p1"
				promptScope="USER"
			/>,
		);

		await screen.findByText(LONG_TITLE);
		// The regression that cropped the footer: a fixed calc() height on the
		// scroll area instead of flexing to fill its `flex-1 min-h-0` parent.
		expect(document.body.innerHTML).not.toContain("calc(100vh-320px)");
		expect(container.innerHTML).not.toContain("calc(100vh-320px)");
	});

	it("renders the read-mode action bar (AC2)", async () => {
		wrap(
			<PromptPreviewSheet
				open
				onOpenChange={vi.fn()}
				promptId="p1"
				promptScope="USER"
			/>,
		);

		await screen.findByText(LONG_TITLE);
		expect(
			screen.getByRole("button", { name: /^Edit$/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Copy/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /Open Full Page/ }),
		).toBeInTheDocument();
	});

	it("renders the edit-mode action bar when opened in edit mode (AC2)", async () => {
		wrap(
			<PromptPreviewSheet
				open
				onOpenChange={vi.fn()}
				promptId="p1"
				promptScope="USER"
				initialEditMode
			/>,
		);

		await screen.findByText(LONG_TITLE);
		expect(
			screen.getByRole("button", { name: /Save as New Version/ }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^Cancel$/ }),
		).toBeInTheDocument();
	});
});
