/**
 * Weft Quality Tests
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	checkScopeCreep,
	checkStubTodoPlaceholder,
	detectFakeTests,
	formatQualityReport,
	generateVerdict,
	runQualityChecks,
} from "./weft-quality.js";

describe("checkStubTodoPlaceholder", () => {
	it("should find empty TODO comments", () => {
		const content = "// TODO";
		const checks = checkStubTodoPlaceholder(content);
		const emptyTodo = checks.find((c) => c.id === "empty-todo");
		assert.ok(emptyTodo);
	});

	it("should find FIXME comments", () => {
		const content = "// FIXME";
		const checks = checkStubTodoPlaceholder(content);
		const emptyFixme = checks.find((c) => c.id === "empty-fixme");
		assert.ok(emptyFixme);
	});

	it("should find console.log", () => {
		const content = `console.log("debug");`;
		const checks = checkStubTodoPlaceholder(content);
		const consoleLog = checks.find((c) => c.id === "console-log");
		assert.ok(consoleLog);
	});

	it("should find empty function body", () => {
		const content = "function test() {}";
		const checks = checkStubTodoPlaceholder(content);
		const emptyFn = checks.find((c) => c.id === "empty-function");
		assert.ok(emptyFn);
	});

	it("should find throw in function", () => {
		const content = `function test() { throw new Error("TODO"); }`;
		const checks = checkStubTodoPlaceholder(content);
		const throwStub = checks.find((c) => c.id === "stub-throw");
		assert.ok(throwStub);
	});

	it("should return empty for clean code", () => {
		const content = `
			function calculateTotal(items) {
				return items.reduce((sum, item) => sum + item.price, 0);
			}
		`;
		const checks = checkStubTodoPlaceholder(content);
		// Should not find any of the stub patterns
		const stubIssues = checks.filter(
			(c) =>
				c.id === "empty-todo" ||
				c.id === "empty-fixme" ||
				c.id === "console-log" ||
				c.id === "empty-function",
		);
		assert.strictEqual(stubIssues.length, 0);
	});

	it("should include file and line in checks", () => {
		const content = "// TODO\nfunction test() {}";
		const checks = checkStubTodoPlaceholder(content, "test.ts");
		assert.ok(checks.every((c) => c.file === "test.ts"));
		assert.ok(checks.every((c) => c.line !== undefined));
	});
});

describe("detectFakeTests", () => {
	it("should find todo in test", () => {
		const content = `it("test", () => { todo(); });`;
		const checks = detectFakeTests(content);
		const todoTest = checks.find((c) => c.id === "todo-in-test");
		assert.ok(todoTest);
	});

	it("should not flag tests with proper assertions", () => {
		const content = `
			it("adds numbers", () => {
				assert.equal(1 + 1, 2);
			});
		`;
		const checks = detectFakeTests(content);
		const fakeIssues = checks.filter(
			(c) =>
				c.id === "empty-test-body" ||
				c.id === "empty-test-function" ||
				c.id === "always-pass-test" ||
				c.id === "missing-assertion",
		);
		assert.strictEqual(fakeIssues.length, 0);
	});
});

describe("checkScopeCreep", () => {
	it("should detect missing features from spec", () => {
		const spec =
			"The system shall authenticate users with OAuth2 and store sessions";
		const impl = "The system authenticates users with OAuth2";
		const checks = checkScopeCreep(impl, spec);
		const missing = checks.find((c) => c.id === "missing-features");
		assert.ok(missing);
	});

	it("should not flag when implementation matches spec", () => {
		const spec = "The system authenticates users with OAuth2";
		const impl = "The system authenticates users with OAuth2";
		const checks = checkScopeCreep(impl, spec);
		assert.strictEqual(checks.length, 0);
	});
});

describe("generateVerdict", () => {
	it("should approve clean implementation", () => {
		const { verdict } = generateVerdict("WORK", []);
		assert.strictEqual(verdict, "APPROVE");
	});

	it("should reject critical issues in work mode", () => {
		const checks = [
			{
				severity: "critical" as const,
				id: "t1",
				name: "n",
				description: "d",
				message: "m",
			},
		];
		const { verdict } = generateVerdict("WORK", checks);
		assert.strictEqual(verdict, "REJECT");
	});

	it("should needs-changes for high issues in work mode", () => {
		const checks = [
			{
				severity: "high" as const,
				id: "t1",
				name: "n",
				description: "d",
				message: "m",
			},
		];
		const { verdict } = generateVerdict("WORK", checks);
		assert.strictEqual(verdict, "NEEDS_CHANGES");
	});

	it("should be lenient for plan mode", () => {
		const checks = [
			{
				severity: "high" as const,
				id: "t1",
				name: "n",
				description: "d",
				message: "m",
			},
		];
		const { verdict } = generateVerdict("PLAN", checks);
		assert.strictEqual(verdict, "APPROVE");
	});

	it("should needs-changes for multiple high issues in plan mode", () => {
		const checks = [
			{
				severity: "high" as const,
				id: "t1",
				name: "n",
				description: "d",
				message: "m",
			},
			{
				severity: "high" as const,
				id: "t2",
				name: "n",
				description: "d",
				message: "m",
			},
			{
				severity: "high" as const,
				id: "t3",
				name: "n",
				description: "d",
				message: "m",
			},
		];
		const { verdict } = generateVerdict("PLAN", checks);
		assert.strictEqual(verdict, "NEEDS_CHANGES");
	});
});

describe("runQualityChecks", () => {
	it("should run all checks", () => {
		const content = "// TODO\nfunction test() {}";
		const report = runQualityChecks(content, "WORK");
		assert.strictEqual(report.mode, "WORK");
		assert.ok(report.summary.total > 0);
	});

	it("should generate verdict based on checks", () => {
		const content = `it("test", () => {});`;
		const report = runQualityChecks(content, "WORK");
		assert.ok(report.verdict);
		assert.ok(report.recommendation);
	});
});

describe("formatQualityReport", () => {
	it("should format approve verdict", () => {
		const report = runQualityChecks("const x = 1;", "WORK");
		const formatted = formatQualityReport(report);
		assert.ok(formatted.includes("APPROVE"));
		assert.ok(formatted.includes("Quality Review"));
		assert.ok(formatted.includes("WORK"));
	});

	it("should format issues with severity", () => {
		const content = "// TODO\nfunction test() {}";
		const report = runQualityChecks(content, "WORK");
		const formatted = formatQualityReport(report);
		assert.ok(formatted.includes("TODO") || report.summary.total > 0);
	});
});
