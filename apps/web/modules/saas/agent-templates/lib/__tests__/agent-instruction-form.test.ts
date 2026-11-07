import { describe, expect, it } from "vitest";
import { agentInstructionFormState } from "../agent-instruction-form";

describe("editing inherited saved agent instructions", () => {
	it("hydrates real inherited text when the instance only carries project context", () => {
		expect(
			agentInstructionFormState("Use the saved project evidence.", {
				projectId: "example-project",
			}),
		).toEqual({
			instructions: "Use the saved project evidence.",
			instructionsInherited: true,
		});
	});
	it("keeps existing nonempty additional-context and role overrides ahead of template text", () => {
		expect(
			agentInstructionFormState("Template", {
				additionalContext: "Context override",
				role: "Role override",
			}),
		).toEqual({
			instructions: "Context override",
			instructionsInherited: false,
		});
		expect(
			agentInstructionFormState("Template", { role: "Role override" }),
		).toEqual({
			instructions: "Role override",
			instructionsInherited: false,
		});
	});
	it("treats empty legacy overrides as inherited and still rejects genuinely empty instructions", () => {
		expect(agentInstructionFormState("Template", { role: "  " })).toEqual({
			instructions: "Template",
			instructionsInherited: true,
		});
		expect(agentInstructionFormState("", null)).toEqual({
			instructions: "",
			instructionsInherited: false,
		});
	});
});
