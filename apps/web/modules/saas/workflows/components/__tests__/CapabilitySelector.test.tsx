import { AGENT_TASK_CAPABILITY_KEYS } from "@repo/temporal/agent-task-capabilities";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
	CapabilitySelector,
	capabilityOptions,
} from "../config-fields/CapabilitySelector";

describe("capabilityOptions", () => {
	it("offers only capabilities the worker accepts for an unattended agent", () => {
		const keys = capabilityOptions().map((option) => option.key);

		expect(keys.length).toBeGreaterThan(0);
		for (const key of keys) {
			expect(AGENT_TASK_CAPABILITY_KEYS).toContain(key);
		}
	});

	it("offers Project Context, the one that lets the agent read the project", () => {
		const projectContext = capabilityOptions().find(
			(option) => option.key === "project-context",
		);

		expect(projectContext?.name).toBe("Project Context");
		expect(projectContext?.description).toBeTruthy();
	});

	it("never offers what the worker refuses: web, code, frames or other agents", () => {
		const keys = capabilityOptions().map((option) => option.key);

		expect(keys).not.toContain("web-search");
		expect(keys).not.toContain("web-search-browse");
		expect(keys).not.toContain("code-interpreter");
		expect(keys).not.toContain("create-frames");
		expect(keys).not.toContain("run-agent");
	});

	it("leaves out agent memory, which a scheduled task cannot use", () => {
		expect(capabilityOptions().map((option) => option.key)).not.toContain(
			"agent-memory",
		);
	});
});

describe("CapabilitySelector", () => {
	const label = "Fabric data and tools the agent may use";

	it("labels the group and each choice for assistive technology", () => {
		render(<CapabilitySelector label={label} onChange={vi.fn()} />);

		expect(screen.getByRole("group", { name: label })).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", { name: /^Project Context/ }),
		).toBeInTheDocument();
	});

	it("shows the capabilities the node already has as ticked", () => {
		render(
			<CapabilitySelector
				label={label}
				value={["project-context"]}
				onChange={vi.fn()}
			/>,
		);

		expect(
			screen.getByRole("checkbox", { name: /^Project Context/ }),
		).toBeChecked();
	});

	it("adds the capability key when a box is ticked", () => {
		const onChange = vi.fn();
		render(<CapabilitySelector label={label} onChange={onChange} />);

		fireEvent.click(
			screen.getByRole("checkbox", { name: /^Project Context/ }),
		);

		expect(onChange).toHaveBeenCalledWith(["project-context"]);
	});

	it("removes only that key when a box is cleared, keeping one it has no row for", () => {
		const onChange = vi.fn();
		render(
			<CapabilitySelector
				label={label}
				value={["search", "project-context"]}
				onChange={onChange}
			/>,
		);

		fireEvent.click(
			screen.getByRole("checkbox", { name: /^Project Context/ }),
		);

		expect(onChange).toHaveBeenCalledWith(["search"]);
	});
});
