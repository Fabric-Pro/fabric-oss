import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ basePath: "/app/acme" }),
}));

import { LinkedTicketsPanel } from "../LinkedTicketsPanel";

const done = {
	storyId: "s1",
	identifier: "F-101",
	title: "Shipped thing",
	statusName: "Done",
	isDone: true,
};
const open = {
	storyId: "s2",
	identifier: "F-102",
	title: "Open thing",
	statusName: "In Progress",
	isDone: false,
};

describe("LinkedTicketsPanel", () => {
	it("renders links to story detail with done/open indicators and status names", () => {
		render(<LinkedTicketsPanel projectId="p1" tickets={[done, open]} />);
		const links = screen.getAllByRole("link");
		expect(links[0]).toHaveAttribute(
			"href",
			"/app/acme/projects/p1/stories/s1",
		);
		expect(links[1]).toHaveAttribute(
			"href",
			"/app/acme/projects/p1/stories/s2",
		);
		expect(screen.getByLabelText("Completed")).toBeInTheDocument();
		expect(screen.getByLabelText("Not completed")).toBeInTheDocument();
		expect(screen.getByText("Done")).toBeInTheDocument();
		expect(screen.getByText("In Progress")).toBeInTheDocument();
	});

	it("renders the exact empty-state copy when no tickets", () => {
		render(<LinkedTicketsPanel projectId="p1" tickets={[]} />);
		expect(
			screen.getByText("No tickets created from this meeting."),
		).toBeInTheDocument();
	});
});
