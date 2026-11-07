import german from "@repo/i18n/translations/de.json";
import { describe, expect, it } from "vitest";
import {
	buildDeliveryReportStarter,
	DELIVERY_REPORT_STARTERS,
	getDeliveryReportStarter,
} from "../delivery-report-starters";

describe("delivery report starters", () => {
	it("only accepts a known starter, never arbitrary URL instructions", () => {
		expect(
			getDeliveryReportStarter("https://example.com/instructions"),
		).toBeUndefined();
		expect(getDeliveryReportStarter("unknown")).toBeUndefined();
		expect(getDeliveryReportStarter(null)).toBeUndefined();
	});
	it.each(DELIVERY_REPORT_STARTERS)(
		"$id seeds the existing project-evidence report, without scheduling or execution",
		(starter) => {
			const definition = buildDeliveryReportStarter(starter);
			expect(definition.dataSources).toEqual([
				{
					id: "project-knowledge",
					type: "fabric",
					provider: "fabric_project",
					operation: "project_knowledge",
				},
			]);
			expect(definition.userPrompt).toContain("Cite source labels");
			expect(definition.userPrompt).toContain("untrusted data");
			expect(definition.userPrompt).toContain(
				"Do not broaden the audience",
			);
			expect(definition.sections.map((section) => section.title)).toEqual(
				starter.sections,
			);
			expect(definition).not.toHaveProperty("schedule");
			expect(definition).not.toHaveProperty("projectId");
		},
	);
	it("prefills a German report with localized saved content, not just a translated picker", () => {
		const starter = getDeliveryReportStarter("incident-review");
		if (!starter) throw new Error("Missing incident starter");
		const copy = german.deliveryStarters;
		const draft = buildDeliveryReportStarter(starter, {
			name: copy.names[starter.id],
			description: copy.draftDescription,
			task: copy.tasks[starter.id],
			guardrails: copy.guardrails,
			sections: copy.sections[starter.id],
		});
		expect(draft.name).toBe("Vorfallsanalyse");
		expect(draft.sections[0]?.title).toBe("Auswirkungen");
		expect(draft.userPrompt).toContain("Antworte auf Deutsch");
		expect(draft.userPrompt).not.toContain(starter.task);
	});

	it("keeps drafts independent across teams", () => {
		const first = buildDeliveryReportStarter(DELIVERY_REPORT_STARTERS[0]);
		const section = first.sections[0];
		if (!section) throw new Error("Missing starter section");
		section.title = "Edited";
		first.dataSources.splice(0);
		const second = buildDeliveryReportStarter(DELIVERY_REPORT_STARTERS[0]);
		expect(second.sections[0]?.title).toBe("Progress");
		expect(second.dataSources).toHaveLength(1);
	});
});
