import { describe, expect, it } from "vitest";
import { recommendDocuments } from "../document-recommendations";

describe("design system document recommendation", () => {
	const project = {
		name: "Example",
		projectTypes: [],
		description: "",
		goals: "",
		techStack: [],
		features: [],
	};

	it("does not recommend it for generic web and mobile copy", () => {
		const recommendations = recommendDocuments({
			...project,
			description: "Build a web app with a modern UI for mobile users",
		});
		expect(
			recommendations.some(({ type }) => type === "DESIGN_SYSTEM"),
		).toBe(false);
	});

	it("recommends it when the project explicitly calls for a design system", () => {
		const recommendations = recommendDocuments({
			...project,
			description:
				"Create a design system and reusable component library",
		});
		expect(
			recommendations.some(({ type }) => type === "DESIGN_SYSTEM"),
		).toBe(true);
	});
});
