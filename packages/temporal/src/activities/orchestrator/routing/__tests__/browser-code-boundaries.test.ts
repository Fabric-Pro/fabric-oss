import { describe, expect, it } from "vitest";
import { analyzeStepRequirements } from "../../planning/step-assigner";
import { detectUserIntent } from "../intent";

describe("live browser/code detectors", () => {
	it.each([
		"Decode VIN 1HGCM82633A004352",
		"scan this barcode",
		"encode this value",
		"summarize the transcript",
		"update the description",
		"what is the postcode",
		"random thoughts",
		"the computer inventory",
		"run pythonic checks",
		"run scripture checks",
	])("rejects embedded keywords in %s", (message) => {
		expect(
			detectUserIntent(message).mentionedCapabilities ?? [],
		).not.toContain("code_execution");
		const result = analyzeStepRequirements({
			id: "example-step",
			description: message,
			type: "api",
			status: "pending",
			order: 1,
			inputs: {},
			outputs: {},
		});
		expect(result.needsBrowserAutomation).toBe(false);
		expect(result.needsCodeExecution).toBe(false);
	});
	it.each([
		["take screenshots of the competitor websites", true, false],
		["run the scripts", false, true],
		["clicked the login button", true, false],
		["computed totals", false, true],
		["run python3", false, true],
		["process the javascript files", false, true],
		["calculating totals", false, true],
		["inspect the dom", true, false],
	])("infers step execution for %s", (description, browser, code) => {
		const result = analyzeStepRequirements({
			id: "example-step",
			description,
			type: "api",
			status: "pending",
			order: 1,
			inputs: {},
			outputs: {},
		});
		expect(result.needsBrowserAutomation).toBe(browser);
		expect(result.needsCodeExecution).toBe(code);
	});
	it.each([
		"run scripts",
		"run python3",
		"execute scripts",
		"clicking on submit",
		"navigating to example.com",
	])("preserves execution metadata for %s", (message) => {
		expect(detectUserIntent(message).mentionedCapabilities ?? []).toContain(
			"code_execution",
		);
	});
});
