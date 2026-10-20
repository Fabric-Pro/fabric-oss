import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ActionWithContext } from "../../lib/plugins/types";
import { ActionConfigPanel } from "../ActionConfigPanel";

vi.mock("@shared/hooks/use-available-models", () => ({
	useAvailableModels: vi.fn(),
}));

describe("plugin-owned action configuration", () => {
	it("renders the structured editor once and preserves its config contract", () => {
		const onChange = vi.fn();
		const action: ActionWithContext = {
			slug: "example",
			label: "Example",
			description: "Example structured action",
			category: "AI",
			integrationType: "MCP",
			integrationLabel: "MCP",
			actionId: "mcp/example",
			nodeType: "mcp-example",
			configFields: [
				{ key: "nested", label: "Discovery metadata", type: "text" },
			],
			configComponent: ({ config, onChange: change }) => (
				<button
					type="button"
					onClick={() =>
						change({ ...config, nested: { mode: "selected" } })
					}
				>
					Edit structured config
				</button>
			),
		};
		render(
			<ActionConfigPanel
				action={action}
				config={{ existing: true }}
				onChange={onChange}
			/>,
		);
		expect(
			screen.getAllByRole("button", { name: "Edit structured config" }),
		).toHaveLength(1);
		expect(
			screen.queryByLabelText("Discovery metadata"),
		).not.toBeInTheDocument();
		fireEvent.click(
			screen.getByRole("button", { name: "Edit structured config" }),
		);
		expect(onChange).toHaveBeenCalledWith({
			existing: true,
			nested: { mode: "selected" },
		});
	});
});
