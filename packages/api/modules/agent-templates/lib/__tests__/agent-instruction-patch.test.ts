import { describe, expect, it } from "vitest";
import { agentInstructionPatchSchema } from "../agent-instruction-patch";

describe("partial saved-agent instruction updates", () => {
	it("accepts metadata-only patches without forcing duplicate inherited instructions", () => {
		expect(
			agentInstructionPatchSchema.parse({
				starterMessages: [
					{ id: "example-starter", prompt: "Create a brief" },
				],
			}),
		).toEqual({
			starterMessages: [
				{ id: "example-starter", prompt: "Create a brief" },
			],
		});
		expect(agentInstructionPatchSchema.parse(undefined)).toBeUndefined();
	});
	it.each(["role", "additionalContext"])(
		"still rejects an explicit blank %s",
		(field) => {
			expect(
				agentInstructionPatchSchema.safeParse({ [field]: "   " })
					.success,
			).toBe(false);
		},
	);
	it("trims explicit nonempty overrides while retaining metadata", () => {
		expect(
			agentInstructionPatchSchema.parse({
				role: " Reviewed instructions ",
				starterMessages: [],
			}),
		).toEqual({ role: "Reviewed instructions", starterMessages: [] });
	});
});
