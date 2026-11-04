import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => true,
}));

import { UnifiedAgentListView } from "../UnifiedAgentListView";

const instance = {
	_type: "instance",
	id: "example-agent",
	name: "Example reporter",
	organizationId: "example-org",
	updatedAt: "2026-01-01",
	template: {
		displayName: "A long delivery reporting template for a software team",
	},
};
describe("agent directory source and actions", () => {
	it("labels template metadata honestly and makes the full truncated source keyboard accessible", async () => {
		render(
			<UnifiedAgentListView
				items={[instance]}
				basePath="/app/example-org"
				onDeleteInstance={vi.fn()}
			/>,
		);
		expect(
			screen.queryByRole("columnheader", { name: "Tags" }),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("columnheader", { name: "Source" }),
		).toBeInTheDocument();
		const source = screen.getByRole("button", {
			name: instance.template.displayName,
		});
		source.focus();
		expect(await screen.findByRole("tooltip")).toHaveTextContent(
			`Template: ${instance.template.displayName}`,
		);
		expect(
			screen.getByRole("link", { name: instance.name }),
		).toHaveAttribute(
			"href",
			"/app/example-org/agents?agentId=example-agent",
		);
	});
	it("keeps detail, edit, duplicate and delete actions bound to the selected agent", async () => {
		const remove = vi.fn();
		render(
			<UnifiedAgentListView
				items={[instance]}
				basePath="/app/example-org"
				onDeleteInstance={remove}
			/>,
		);
		fireEvent.keyDown(
			screen.getByRole("button", {
				name: `Actions for ${instance.name}`,
			}),
			{ key: "Enter" },
		);
		expect(
			await screen.findByRole("menuitem", { name: "Edit" }),
		).toHaveAttribute("href", "/app/example-org/agents/example-agent/edit");
		expect(
			screen.getByRole("menuitem", { name: "Duplicate" }),
		).toHaveAttribute(
			"href",
			"/app/example-org/agents/example-agent/duplicate",
		);
		fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
		expect(remove).toHaveBeenCalledWith(instance.id);
	});
});
