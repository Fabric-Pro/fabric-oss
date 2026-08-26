import { describe, expect, it } from "vitest";
import { renderInstanceReport } from "../src/activities/template-instance";

const baseInput = {
	instance: { name: "UAT Report", description: null },
	template: { name: "Board Report", definition: { sections: [] } },
	dataResults: [],
	aiResults: [],
	outputFormat: "MARKDOWN" as const,
};

describe("renderInstanceReport partial notice", () => {
	it("prepends a partial-data notice when isPartial is true (markdown)", async () => {
		const out = await renderInstanceReport({
			...baseInput,
			isPartial: true,
		});
		expect(out.markdown).toMatch(/partial data/i);
	});

	it("omits the notice on a complete run", async () => {
		const out = await renderInstanceReport({
			...baseInput,
			isPartial: false,
		});
		expect(out.markdown).not.toMatch(/partial data/i);
	});

	it("prepends the notice in HTML format", async () => {
		const out = await renderInstanceReport({
			...baseInput,
			outputFormat: "HTML",
			isPartial: true,
		});
		expect(out.markdown).toMatch(/partial data/i);
	});
});
