import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NodeConfigEditor } from "../NodeConfigEditor";

vi.mock("../../lib/node-definitions", async () => {
	const { SYSTEM_NODES } = await import("../../lib/system-nodes");
	return {
		getNodeDefinition: (type: string) =>
			SYSTEM_NODES.find((node) => node.type === type),
	};
});
vi.mock("../../lib/plugins/registry", () => ({
	findActionById: () => undefined,
}));
vi.mock("../ActionConfigPanel", () => ({ ActionConfigPanel: () => null }));
vi.mock("../config-fields/AiModelSelector", () => ({
	AiModelSelector: () => null,
}));
vi.mock("../config-fields/CapabilitySelector", () => ({
	CapabilitySelector: () => null,
}));
vi.mock("../config-fields/McpServerSelector", () => ({
	McpServerSelector: () => null,
}));
vi.mock("../config-fields/McpToolSelector", () => ({
	McpToolSelector: () => null,
}));

describe("Script Transform configuration", () => {
	it("edits raw code and response deadline without losing other configuration", () => {
		const onUpdate = vi.fn();
		const config = {
			code: "return inputs.source;",
			language: "javascript",
			timeout: 5000,
			inputKeys: ["$source"],
		};
		render(
			<NodeConfigEditor
				node={{
					id: "script",
					type: "script-transform",
					position: { x: 0, y: 0 },
					data: { label: "Transform", config },
				}}
				onUpdate={onUpdate}
				onDelete={vi.fn()}
			/>,
		);
		const code =
			"return { literal: '{{source.data}}', value: inputs.source };";
		const inputKeys = screen.getByLabelText(/Input keys/);
		expect(inputKeys).toHaveValue(JSON.stringify(["$source"], null, 2));
		fireEvent.change(inputKeys, {
			target: { value: '["$source", "$previous"]' },
		});
		expect(onUpdate).toHaveBeenLastCalledWith("script", {
			config: { ...config, inputKeys: '["$source", "$previous"]' },
		});
		fireEvent.change(
			screen.getByLabelText(/Code \(async function body\)/),
			{ target: { value: code } },
		);
		expect(onUpdate).toHaveBeenLastCalledWith("script", {
			config: { ...config, code },
		});
		fireEvent.change(screen.getByLabelText(/Response deadline/), {
			target: { value: "8000" },
		});
		expect(onUpdate).toHaveBeenLastCalledWith("script", {
			config: { ...config, timeout: 8000 },
		});
		expect(screen.getByRole("combobox", { name: /Language/ })).toBeTruthy();
		expect(
			screen.getByText(/do not interpolate it into code/),
		).toBeTruthy();
		expect(screen.getByText("{{Transform.result}}")).toBeTruthy();
		expect(screen.getByText("{{Transform.logs}}")).toBeTruthy();
	});
});
