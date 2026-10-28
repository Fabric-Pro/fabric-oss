import { expect, it } from "vitest";
import { limitSchema } from "../direct-stream-protocol";

it.each(["time", "iterations"])("preserves budgetLimit %s", (budgetLimit) => {
	expect(
		limitSchema.parse({
			kind: "internal_budget",
			message: "Example",
			budgetLimit,
		}),
	).toMatchObject({ budgetLimit });
});
