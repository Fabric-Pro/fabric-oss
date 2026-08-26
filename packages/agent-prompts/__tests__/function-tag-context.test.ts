import { describe, expect, it } from "vitest";
import { getFunctionTagContextClause } from "../src/core/function-tag-context";

describe("getFunctionTagContextClause", () => {
	it("returns '' for an empty composition", () => {
		expect(
			getFunctionTagContextClause({
				composition: [],
				requesterLabels: [],
			}),
		).toBe("");
	});

	it("renders a mixed composition with the requester lens", () => {
		const out = getFunctionTagContextClause({
			composition: [
				{ label: "Developer", count: 3 },
				{ label: "Architect", count: 1 },
				{ label: "Stakeholder", count: 2 },
			],
			requesterLabels: ["Developer"],
		});
		expect(out).toContain("PROJECT CONTRIBUTOR ROLES");
		expect(out).toContain("3 × Developer, 1 × Architect, 2 × Stakeholder");
		expect(out).toContain(
			"You are assisting a contributor whose role is: Developer.",
		);
		expect(out).toMatchSnapshot();
	});

	it("omits the requester line when there is no requester lens", () => {
		const out = getFunctionTagContextClause({
			composition: [{ label: "Developer", count: 1 }],
			requesterLabels: [],
		});
		expect(out).not.toContain("You are assisting a contributor");
	});
});
