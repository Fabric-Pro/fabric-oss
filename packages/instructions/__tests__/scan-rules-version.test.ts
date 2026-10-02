import { describe, expect, it } from "vitest";
import {
	computeScanRulesVersion,
	INSTRUCTION_SCAN_RULES_VERSION,
	SCANNER_REVISION,
} from "../src/scan-rules-version";
import {
	SECRET_FILE_PATTERNS,
	SECRET_RULES,
	SECRET_SCANNER_PARAMETERS,
} from "../src/secrets";

const current = {
	contentRules: SECRET_RULES,
	filenamePatterns: SECRET_FILE_PATTERNS,
	parameters: SECRET_SCANNER_PARAMETERS,
	revision: SCANNER_REVISION,
};

describe("INSTRUCTION_SCAN_RULES_VERSION", () => {
	it("is the version of the live rule set, and stable", () => {
		expect(INSTRUCTION_SCAN_RULES_VERSION).toBe(
			computeScanRulesVersion(current),
		);
		expect(INSTRUCTION_SCAN_RULES_VERSION).toMatch(/^[0-9a-f]{16}$/);
	});

	it("changes when a content rule's pattern changes", () => {
		const [first, ...rest] = SECRET_RULES;
		if (first === undefined) {
			throw new Error("the rule set is empty");
		}
		const edited = computeScanRulesVersion({
			...current,
			contentRules: [
				{ id: first.id, signature: `${first.signature}|tightened` },
				...rest,
			],
		});
		expect(edited).not.toBe(INSTRUCTION_SCAN_RULES_VERSION);
	});

	it("changes when a rule is added or removed", () => {
		expect(
			computeScanRulesVersion({
				...current,
				contentRules: [
					...SECRET_RULES,
					{ id: "new-rule", signature: "regex:x/" },
				],
			}),
		).not.toBe(INSTRUCTION_SCAN_RULES_VERSION);
		expect(
			computeScanRulesVersion({
				...current,
				contentRules: SECRET_RULES.slice(1),
			}),
		).not.toBe(INSTRUCTION_SCAN_RULES_VERSION);
	});

	it("changes when a filename rule or a matcher parameter changes", () => {
		expect(
			computeScanRulesVersion({
				...current,
				filenamePatterns: [...SECRET_FILE_PATTERNS, "**/*.cer"],
			}),
		).not.toBe(INSTRUCTION_SCAN_RULES_VERSION);
		expect(
			computeScanRulesVersion({
				...current,
				parameters: {
					...SECRET_SCANNER_PARAMETERS,
					placeholderPrefixes: [
						...SECRET_SCANNER_PARAMETERS.placeholderPrefixes,
						"{{",
					],
				},
			}),
		).not.toBe(INSTRUCTION_SCAN_RULES_VERSION);
	});

	it("changes when the hand-maintained revision is bumped", () => {
		expect(
			computeScanRulesVersion({
				...current,
				revision: SCANNER_REVISION + 1,
			}),
		).not.toBe(INSTRUCTION_SCAN_RULES_VERSION);
	});

	it("gives every content rule a signature", () => {
		for (const rule of SECRET_RULES) {
			expect(rule.signature.length).toBeGreaterThan(0);
		}
	});
});
