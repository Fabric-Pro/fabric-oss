import { fireEvent, render, screen } from "@testing-library/react";
import { type ReactNode, useState } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@ui/components/select", () => ({
	Select: ({
		value,
		onValueChange,
		children,
	}: {
		value: string;
		onValueChange: (value: string) => void;
		children: ReactNode;
	}) => (
		<select
			value={value}
			onChange={(event) => onValueChange(event.target.value)}
		>
			{children}
		</select>
	),
	SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
	SelectItem: ({
		value,
		children,
	}: {
		value: string;
		children: ReactNode;
	}) => <option value={value}>{children}</option>,
	SelectTrigger: () => null,
	SelectValue: () => null,
}));
vi.mock("../config-fields/AiModelSelector", () => ({
	AiModelSelector: ({
		value,
		onChange,
	}: {
		value: string;
		onChange: (value: string) => void;
	}) => (
		<input
			aria-label="Review model"
			value={value}
			onChange={(event) => onChange(event.target.value)}
		/>
	),
}));
vi.mock("../../lib/plugins/mcp/AdoReviewInstructionFields", () => ({
	AdoReviewInstructionFields: () => <p>Instruction selectors</p>,
}));

import { adoStoryReviewConfigSchema } from "@repo/temporal/ado-story-review-config";
import { AdoStoryReviewConfigFields } from "../../lib/plugins/mcp/AdoStoryReviewConfigFields";

function renderEditor(initial: Record<string, unknown> = {}) {
	const changed = vi.fn();
	function Editor() {
		const [config, setConfig] = useState(initial);
		return (
			<AdoStoryReviewConfigFields
				config={config}
				onChange={(next) => {
					changed(next);
					setConfig(next);
				}}
			/>
		);
	}
	render(<Editor />);
	return changed;
}

describe("ADO story review configuration", () => {
	it("preserves the selected-assignee draft while the unique name is still empty", () => {
		const changed = renderEditor({ rubric: "Review completeness." });
		fireEvent.change(screen.getByRole("combobox"), {
			target: { value: "selected" },
		});
		expect(screen.getByLabelText("ADO member unique name")).toHaveValue("");
		fireEvent.change(screen.getByLabelText("ADO member unique name"), {
			target: { value: "member@example.com" },
		});
		expect(changed).toHaveBeenLastCalledWith(
			expect.objectContaining({
				assignee: {
					mode: "selected",
					uniqueName: "member@example.com",
				},
			}),
		);
		expect(
			screen.queryByRole("list", {
				name: "Review configuration problems",
			}),
		).not.toBeInTheDocument();
	});

	it("uses canonical schema defaults while keeping all existing config during edits", () => {
		const changed = renderEditor({ workspaceFrameId: "workspace-1" });
		fireEvent.change(screen.getByLabelText("Review criteria"), {
			target: { value: "Check testable acceptance criteria." },
		});
		const saved = changed.mock.lastCall?.[0];
		expect(saved).toMatchObject({
			workspaceFrameId: "workspace-1",
			assignee: { mode: "current" },
		});
		expect(adoStoryReviewConfigSchema.safeParse(saved).success).toBe(true);
	});

	it("keeps draft arrays editable and validates them before activation", () => {
		const changed = renderEditor({ rubric: "Review completeness." });
		const types = screen.getByLabelText("Work item types (one per line)");
		fireEvent.change(types, { target: { value: "Story\n" } });
		expect(types).toHaveValue("Story\n");
		expect(
			screen.getByRole("list", { name: "Review configuration problems" }),
		).toBeInTheDocument();
		fireEvent.change(types, { target: { value: "Story\nRequirement" } });
		expect(changed).toHaveBeenLastCalledWith(
			expect.objectContaining({
				workItemTypes: ["Story", "Requirement"],
			}),
		);
	});

	it("lets the author change and clear the model override and parent Workspace", () => {
		const changed = renderEditor({
			rubric: "Review completeness.",
			model: "example-model",
			workspaceFrameId: "workspace-1",
		});
		fireEvent.change(screen.getByLabelText("Review model"), {
			target: { value: "another-model" },
		});
		expect(changed).toHaveBeenLastCalledWith(
			expect.objectContaining({ model: "another-model" }),
		);
		fireEvent.click(
			screen.getByRole("button", {
				name: "Use agent preference or default model",
			}),
		);
		expect(changed).toHaveBeenLastCalledWith(
			expect.objectContaining({ model: undefined }),
		);
		fireEvent.change(
			screen.getByLabelText("Parent Workspace ID (optional)"),
			{ target: { value: "" } },
		);
		expect(changed).toHaveBeenLastCalledWith(
			expect.objectContaining({ workspaceFrameId: undefined }),
		);
	});

	it("edits exact sprint filters and removes the optional mode without changing direct selections", () => {
		const changed = renderEditor({ rubric: "Review completeness." });
		fireEvent.click(
			screen.getByRole("switch", {
				name: "Use sprint tasks and linked story context",
			}),
		);
		const iterations = screen.getByLabelText(
			"Exact iteration paths (one or two, one per line)",
		);
		fireEvent.change(iterations, {
			target: { value: "Example\\Sprint 1\nExample\\Sprint 2" },
		});
		fireEvent.change(
			screen.getByLabelText(
				"Assignment fields (System.AssignedTo or Custom.Engineer, one per line)",
			),
			{
				target: { value: "System.AssignedTo\nCustom.Engineer" },
			},
		);
		fireEvent.change(
			screen.getByLabelText("Assigned task types (one per line)"),
			{ target: { value: "Task\nBug" } },
		);
		fireEvent.change(
			screen.getByLabelText(
				"Assigned types whose parents are followed (one per line)",
			),
			{ target: { value: "Task\nBug" } },
		);
		fireEvent.change(
			screen.getByLabelText(
				"Immediate context relations (child or related, one per line)",
			),
			{ target: { value: "related" } },
		);
		fireEvent.change(
			screen.getByLabelText(
				"Excluded assigned states (optional, one per line)",
			),
			{ target: { value: "Removed" } },
		);
		const saved = adoStoryReviewConfigSchema.parse(
			changed.mock.lastCall?.[0],
		);
		expect(saved.sprintContext).toEqual({
			iterationPaths: ["Example\\Sprint 1", "Example\\Sprint 2"],
			assignmentFields: ["Custom.Engineer", "System.AssignedTo"],
			assignedItemTypes: ["Bug", "Task"],
			parentSourceTypes: ["Bug", "Task"],
			relationKinds: ["related"],
			excludedAssignedStates: ["Removed"],
		});
		fireEvent.click(
			screen.getByRole("switch", {
				name: "Use sprint tasks and linked story context",
			}),
		);
		expect(changed.mock.lastCall?.[0]).not.toHaveProperty("sprintContext");
		expect(
			screen.queryByLabelText(
				"Exact iteration paths (one or two, one per line)",
			),
		).not.toBeInTheDocument();
	});
});
