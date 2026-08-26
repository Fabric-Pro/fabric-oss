import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertPipelineResultsEnabled } from "../pipeline-results-feature";

const BASE = "FABRIC_FEATURE_TEST_CASES";

let savedBase: string | undefined;

function setFlag(name: string, value: string | undefined) {
	if (value === undefined) {
		delete process.env[name];
	} else {
		process.env[name] = value;
	}
}

beforeEach(() => {
	savedBase = process.env[BASE];
});

afterEach(() => {
	setFlag(BASE, savedBase);
});

// The pipeline-specific dark-launch flag was dropped when the feature graduated;
// pipeline results now ride the base QA gate.
describe("assertPipelineResultsEnabled", () => {
	it("passes when the base Test Cases flag is on (no separate pipeline flag)", () => {
		setFlag(BASE, "true");
		expect(() => assertPipelineResultsEnabled()).not.toThrow();
	});

	it("fails closed when the base Test Cases flag is off", () => {
		setFlag(BASE, undefined);
		expect(() => assertPipelineResultsEnabled()).toThrow();
	});
});
