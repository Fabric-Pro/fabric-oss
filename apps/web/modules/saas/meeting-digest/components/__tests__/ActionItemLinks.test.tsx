import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ basePath: "/app/acme" }),
}));

import type { ActionItemLinkView } from "../../lib/types";
import { ActionItemLinks } from "../ActionItemLinks";

const link = (
	overrides: Partial<ActionItemLinkView> = {},
): ActionItemLinkView => ({
	id: "l1",
	itemKey: "key-a",
	storyId: "s1",
	origin: "AUTO",
	confidence: 0.92,
	similarity: 0.7,
	reasoning: "The item asks for the download this feature describes.",
	identifier: "F-101",
	title: "Digest download",
	statusName: "In Progress",
	isDone: false,
	...overrides,
});

describe("ActionItemLinks", () => {
	it("renders nothing at all when there are no links (FR8/AC2)", () => {
		const { container } = render(
			<ActionItemLinks
				projectId="p1"
				links={[]}
				onRemove={vi.fn()}
				removingLinkIds={new Set()}
			/>,
		);
		// Not an empty state, not a "no matches" line — literally nothing, so an
		// unmatched action item never reads as a failure.
		expect(container).toBeEmptyDOMElement();
	});

	it("links each chip to the work item's detail page", () => {
		render(
			<ActionItemLinks
				projectId="p1"
				links={[link()]}
				onRemove={vi.fn()}
				removingLinkIds={new Set()}
			/>,
		);
		expect(screen.getByRole("link", { name: /F-101/ })).toHaveAttribute(
			"href",
			"/app/acme/projects/p1/stories/s1",
		);
	});

	it("shows every match as its own independently removable chip (AC3)", () => {
		const onRemove = vi.fn();
		render(
			<ActionItemLinks
				projectId="p1"
				links={[
					link(),
					link({
						id: "l2",
						storyId: "s2",
						identifier: "F-102",
						title: "Agenda generation",
					}),
				]}
				onRemove={onRemove}
				removingLinkIds={new Set()}
			/>,
		);

		expect(screen.getAllByRole("listitem")).toHaveLength(2);

		fireEvent.click(
			screen.getByRole("button", {
				name: "Remove link to F-102 Agenda generation",
			}),
		);
		expect(onRemove).toHaveBeenCalledTimes(1);
		expect(onRemove).toHaveBeenCalledWith("l2");
	});

	it("disables a chip's remove button while its removal is in flight", () => {
		render(
			<ActionItemLinks
				projectId="p1"
				links={[link()]}
				onRemove={vi.fn()}
				removingLinkIds={new Set(["l1"])}
			/>,
		);
		expect(
			screen.getByRole("button", {
				name: "Remove link to F-101 Digest download",
			}),
		).toBeDisabled();
	});

	it("labels an auto link as a suggestion with its confidence", async () => {
		render(
			<ActionItemLinks
				projectId="p1"
				links={[link()]}
				onRemove={vi.fn()}
				removingLinkIds={new Set()}
			/>,
		);

		fireEvent.focus(screen.getByRole("link", { name: /F-101/ }));

		// Advisory wording per ai-copy-tone.md — a match is offered, not asserted.
		expect(
			await screen.findAllByText(/Suggested from this meeting/),
		).not.toHaveLength(0);
		expect(await screen.findAllByText(/92% confidence/)).not.toHaveLength(
			0,
		);
	});

	it("states a created link as fact rather than as a suggestion", async () => {
		render(
			<ActionItemLinks
				projectId="p1"
				links={[link({ origin: "CREATED", confidence: null })]}
				onRemove={vi.fn()}
				removingLinkIds={new Set()}
			/>,
		);

		fireEvent.focus(screen.getByRole("link", { name: /F-101/ }));

		expect(
			await screen.findAllByText(/Created from this action item/),
		).not.toHaveLength(0);
		expect(screen.queryByText(/Suggested/)).toBeNull();
	});

	it("falls back to a dash when a work item has no identifier yet", () => {
		render(
			<ActionItemLinks
				projectId="p1"
				links={[link({ identifier: null })]}
				onRemove={vi.fn()}
				removingLinkIds={new Set()}
			/>,
		);
		expect(
			screen.getByRole("button", { name: /Remove link to —/ }),
		).toBeInTheDocument();
	});
});
