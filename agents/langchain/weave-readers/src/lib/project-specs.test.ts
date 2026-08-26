/**
 * Project Specs Tests
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	formatProjectSpecsDisplay,
	mergeWithDefaults,
	ProjectSpecsSchema,
	parseProjectSpecs,
	validateProjectSpecs,
} from "./project-specs.js";

describe("parseProjectSpecs", () => {
	it("should parse valid specs", () => {
		const json = JSON.stringify({
			customPatterns: [
				{
					id: "custom-pattern",
					name: "Custom Pattern",
					severity: "high",
					grepPatterns: ["custom_regex"],
					description: "A custom pattern",
					remediation: "Fix it",
				},
			],
			disabledPatterns: ["sql-injection"],
			minSeverity: "high",
		});
		const specs = parseProjectSpecs(json);
		assert.ok(specs);
		assert.strictEqual(specs.customPatterns.length, 1);
		assert.strictEqual(specs.disabledPatterns[0], "sql-injection");
		assert.strictEqual(specs.minSeverity, "high");
	});

	it("should return null for invalid json", () => {
		const specs = parseProjectSpecs("not json");
		assert.strictEqual(specs, null);
	});

	it("should return null for invalid schema", () => {
		const specs = parseProjectSpecs('{"customPatterns": "not an array"}');
		assert.strictEqual(specs, null);
	});

	it("should return null for empty string", () => {
		const specs = parseProjectSpecs("");
		assert.strictEqual(specs, null);
	});
});

describe("validateProjectSpecs", () => {
	it("should return valid result for good specs", () => {
		const json = JSON.stringify({
			customPatterns: [],
			disabledPatterns: [],
		});
		const result = validateProjectSpecs(json);
		assert.strictEqual(result.valid, true);
		if (result.valid) {
			assert.ok(result.specs);
		}
	});

	it("should return error for invalid severity", () => {
		const json = JSON.stringify({
			minSeverity: "invalid",
		});
		const result = validateProjectSpecs(json);
		assert.strictEqual(result.valid, false);
		if (!result.valid) {
			assert.ok(result.error.includes("Validation failed"));
		}
	});

	it("should include path in error message", () => {
		const json = JSON.stringify({
			customPatterns: [
				{
					id: "test",
					// missing required fields
				},
			],
		});
		const result = validateProjectSpecs(json);
		assert.strictEqual(result.valid, false);
		if (!result.valid) {
			assert.ok(result.error.includes("name"));
		}
	});
});

describe("mergeWithDefaults", () => {
	const defaultPatterns = [
		{
			id: "sql-injection",
			name: "SQL Injection",
			severity: "critical" as const,
			grepPatterns: ["SELECT.*WHERE"],
			description: "SQL injection vulnerability",
			remediation: "Use parameterized queries",
			category: "Injection",
		},
		{
			id: "xss",
			name: "Cross-Site Scripting",
			severity: "high" as const,
			grepPatterns: ["innerHTML"],
			description: "XSS vulnerability",
			remediation: "Sanitize input",
			category: "Injection",
		},
		{
			id: "debug-code",
			name: "Debug Code",
			severity: "low" as const,
			grepPatterns: ["console.log"],
			description: "Debug code left in production",
			remediation: "Remove debug code",
			category: "Code Quality",
		},
	];

	it("should return all patterns when no project specs", () => {
		const specs = {
			customPatterns: [],
			disabledPatterns: [],
			extraSpecs: [],
		};
		const merged = mergeWithDefaults(specs, defaultPatterns);
		assert.strictEqual(merged.length, 3);
	});

	it("should remove disabled patterns", () => {
		const specs = {
			customPatterns: [],
			disabledPatterns: ["sql-injection"],
			extraSpecs: [],
		};
		const merged = mergeWithDefaults(specs, defaultPatterns);
		assert.strictEqual(merged.length, 2);
		assert.ok(merged.every((p) => p.id !== "sql-injection"));
	});

	it("should add custom patterns", () => {
		const specs = {
			customPatterns: [
				{
					id: "custom-rule",
					name: "Custom Rule",
					severity: "medium" as const,
					grepPatterns: ["custom_pattern"],
					description: "Custom security rule",
					remediation: "Follow custom guidelines",
				},
			],
			disabledPatterns: [],
			extraSpecs: [],
		};
		const merged = mergeWithDefaults(specs, defaultPatterns);
		assert.strictEqual(merged.length, 4);
		assert.ok(merged.some((p) => p.id === "custom-rule"));
	});

	it("should filter by minSeverity", () => {
		const specs = {
			customPatterns: [],
			disabledPatterns: [],
			extraSpecs: [],
			minSeverity: "high" as const,
		};
		const merged = mergeWithDefaults(specs, defaultPatterns);
		// Should include critical and high, but not low
		assert.ok(merged.every((p) => p.severity !== "low"));
		assert.ok(merged.some((p) => p.id === "sql-injection"));
		assert.ok(merged.some((p) => p.id === "xss"));
	});

	it("should filter by enabled categories", () => {
		const specs = {
			customPatterns: [],
			disabledPatterns: [],
			extraSpecs: [],
			enabledCategories: ["Injection"],
		};
		const merged = mergeWithDefaults(specs, defaultPatterns);
		assert.ok(merged.every((p) => p.category === "Injection"));
		assert.strictEqual(merged.length, 2);
	});

	it("should filter by disabled categories", () => {
		const specs = {
			customPatterns: [],
			disabledPatterns: [],
			extraSpecs: [],
			disabledCategories: ["Code Quality"],
		};
		const merged = mergeWithDefaults(specs, defaultPatterns);
		assert.ok(merged.every((p) => p.category !== "Code Quality"));
		assert.strictEqual(merged.length, 2);
	});

	it("should handle empty specs", () => {
		const specs = {
			customPatterns: [],
			disabledPatterns: [],
			extraSpecs: [],
		};
		const merged = mergeWithDefaults(specs, defaultPatterns);
		assert.strictEqual(merged.length, 3);
	});
});

describe("formatProjectSpecsDisplay", () => {
	it("should format specs with custom patterns", () => {
		const specs = {
			customPatterns: [
				{
					id: "custom",
					name: "Custom",
					severity: "high" as const,
					grepPatterns: [],
					description: "",
					remediation: "",
				},
			],
			disabledPatterns: [],
			extraSpecs: [],
		};
		const formatted = formatProjectSpecsDisplay(specs);
		assert.ok(formatted.includes("Custom Patterns"));
		assert.ok(formatted.includes("Custom"));
		assert.ok(formatted.includes("high"));
	});

	it("should format specs with disabled patterns", () => {
		const specs = {
			customPatterns: [],
			disabledPatterns: ["sql-injection", "xss"],
			extraSpecs: [],
		};
		const formatted = formatProjectSpecsDisplay(specs);
		assert.ok(formatted.includes("Disabled Patterns"));
		assert.ok(formatted.includes("sql-injection"));
		assert.ok(formatted.includes("xss"));
	});

	it("should format specs with minSeverity", () => {
		const specs = {
			customPatterns: [],
			disabledPatterns: [],
			extraSpecs: [],
			minSeverity: "critical" as const,
		};
		const formatted = formatProjectSpecsDisplay(specs);
		assert.ok(formatted.includes("Minimum Severity"));
		assert.ok(formatted.includes("critical"));
	});
});

describe("ProjectSpecsSchema", () => {
	it("should validate complete specs", () => {
		const specs = {
			customPatterns: [
				{
					id: "test",
					name: "Test",
					severity: "high",
					grepPatterns: ["pattern"],
					description: "Test pattern",
					remediation: "Fix it",
				},
			],
			disabledPatterns: ["id"],
			extraSpecs: ["spec1"],
			minSeverity: "medium",
			enabledCategories: ["cat1"],
			disabledCategories: ["cat2"],
		};
		const result = ProjectSpecsSchema.safeParse(specs);
		assert.strictEqual(result.success, true);
	});

	it("should apply defaults for optional fields", () => {
		const result = ProjectSpecsSchema.safeParse({});
		assert.strictEqual(result.success, true);
		if (result.success) {
			assert.deepStrictEqual(result.data.customPatterns, []);
			assert.deepStrictEqual(result.data.disabledPatterns, []);
		}
	});
});
