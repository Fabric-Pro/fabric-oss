import { describe, expect, it } from "vitest";
import { PublishingSuggestionCycleScalarFieldEnumSchema } from "../prisma/zod";

describe("PublishingSuggestionCycle.preferencesHash", () => {
	it("exists on the generated model", () => {
		expect(
			PublishingSuggestionCycleScalarFieldEnumSchema.options,
		).toContain("preferencesHash");
	});
});
