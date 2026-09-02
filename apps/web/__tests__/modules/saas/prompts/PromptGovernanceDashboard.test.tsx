/**
 * The organization's prompt configuration, seen whole (FR24), restructured per
 * the PM's review (Fizzy #2068 F7): the view is "Org Overrides", and the
 * actions split into two collapsible groups — the ones this organization has
 * overridden, and the ones falling back to Universal or built-in text.
 *
 * A personal override is deliberately NOT counted as configured: it belongs to
 * one person and is not an organization-level answer. That is the assertion
 * most likely to be "fixed" by someone who has not read this.
 */

import { PromptGovernanceDashboard } from "@saas/prompts/components/PromptGovernanceDashboard";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { catalogList } = vi.hoisted(() => ({ catalogList: vi.fn() }));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		prompts: { catalog: { list: (i: unknown) => catalogList(i) } },
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: "org-1",
		basePath: "/app/acme",
	}),
}));

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

const entry = (
	targetKey: string,
	effectiveScope: "SYSTEM" | "ORG" | "USER" | null,
) => ({
	targetKey,
	documentType: "GENERAL",
	storyKind: null,
	effectiveScope,
	prompts: [],
});

describe("PromptGovernanceDashboard (Org Overrides)", () => {
	beforeEach(() => {
		catalogList.mockReset();
		catalogList.mockResolvedValue({ entries: [] });
	});

	it("counts how many actions have no organization prompt", async () => {
		wrap(<PromptGovernanceDashboard />);

		expect(
			await screen.findByText(/actions have no organization prompt/i),
		).toBeInTheDocument();
	});

	it("splits the actions into the two collapsible sections", async () => {
		catalogList.mockResolvedValue({
			entries: [
				entry("test_case_drafter", "ORG"),
				entry("project_document_generator", "SYSTEM"),
			],
		});

		wrap(<PromptGovernanceDashboard />);

		expect(
			screen.getByRole("button", { name: /organization overrides/i }),
		).toHaveAttribute("aria-expanded", "true");
		expect(
			screen.getByRole("button", { name: /no organization override/i }),
		).toHaveAttribute("aria-expanded", "true");
	});

	it("collapses a section on click, hiding its rows", async () => {
		catalogList.mockResolvedValue({
			entries: [
				entry("test_case_drafter", "ORG"),
				entry("project_document_generator", "SYSTEM"),
			],
		});

		const user = userEvent.setup();
		wrap(<PromptGovernanceDashboard />);

		const before = screen.getAllByRole("listitem").length;
		await user.click(
			screen.getByRole("button", { name: /organization overrides/i }),
		);
		expect(
			screen.getByRole("button", { name: /organization overrides/i }),
		).toHaveAttribute("aria-expanded", "false");
		expect(screen.getAllByRole("listitem").length).toBe(before - 1);
	});

	it("marks an action the organization has configured, inside the overrides section", async () => {
		catalogList.mockResolvedValue({
			entries: [entry("test_case_drafter", "ORG")],
		});

		wrap(<PromptGovernanceDashboard />);

		const section = screen
			.getByRole("button", { name: /organization overrides/i })
			.closest("section");
		expect(section).not.toBeNull();
		expect(
			await within(section as HTMLElement).findAllByText("Organization"),
		).not.toHaveLength(0);
	});

	it("says plainly when an action falls back to the Fabric default", async () => {
		catalogList.mockResolvedValue({
			entries: [entry("test_case_drafter", "SYSTEM")],
		});

		wrap(<PromptGovernanceDashboard />);

		expect(
			await screen.findAllByText(/falling back to the fabric default/i),
		).not.toHaveLength(0);
	});

	it("does not count a personal override as organization coverage", async () => {
		// One person's own prompt is not the organization's answer. Counting it
		// would report the gap as closed when nobody has configured anything.
		catalogList.mockResolvedValue({
			entries: [entry("test_case_drafter", "USER")],
		});

		wrap(<PromptGovernanceDashboard />);

		await screen.findByText(/actions have no organization prompt/i);
		expect(screen.queryByText("Organization")).not.toBeInTheDocument();
	});

	it("links each row to that action in the catalog", async () => {
		wrap(<PromptGovernanceDashboard />);

		const links = await screen.findAllByRole("link");
		expect(links[0]).toHaveAttribute(
			"href",
			expect.stringContaining("/prompts/catalog?action="),
		);
	});

	it("announces a stable error and lets the user retry", async () => {
		catalogList
			.mockRejectedValueOnce(new Error("database host unavailable"))
			.mockResolvedValueOnce({ entries: [] });

		const user = userEvent.setup();
		wrap(<PromptGovernanceDashboard />);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"Could not load your organization's prompt configuration.",
		);
		expect(alert).not.toHaveTextContent("database host unavailable");

		await user.click(
			within(alert).getByRole("button", { name: "Try again" }),
		);
		expect(
			await screen.findByText(/actions have no organization prompt/i),
		).toBeInTheDocument();
	});
});
