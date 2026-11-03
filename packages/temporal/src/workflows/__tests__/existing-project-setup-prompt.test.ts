import { describe, expect, it } from "vitest";
import { buildMultiRepoAnalysisPrompt } from "../existing-project-setup";

const APP = "https://github.com/example-org/app";
const RULES = "https://github.com/example-org/ai-rules";
const DOCS = "https://github.com/example-org/handbook";

describe("buildMultiRepoAnalysisPrompt", () => {
	it("marks the instructions and documentation repositories as not product code", () => {
		const prompt = buildMultiRepoAnalysisPrompt({
			repoUrls: [APP, RULES, DOCS],
			repoRoles: { [RULES]: "instructions", [DOCS]: "knowledge" },
			projectTypes: [],
			projectName: "Booking",
		});

		expect(prompt).toContain(`1. ${APP}\n`);
		expect(prompt).toContain(
			`2. ${RULES} — the project's coding instructions`,
		);
		expect(prompt).toContain(`3. ${DOCS} — the project's documentation`);
		expect(prompt).toContain(
			"The repositories marked above are not the product's code",
		);
	});

	it("reads every repository as code when no role is given", () => {
		const prompt = buildMultiRepoAnalysisPrompt({
			repoUrls: [APP],
			projectTypes: [],
			projectName: "Booking",
		});

		expect(prompt).toContain(`1. ${APP}\n`);
		expect(prompt).not.toContain("not the product's code");
	});
});
