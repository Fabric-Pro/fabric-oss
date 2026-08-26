/**
 * Design-pattern compliance, checked against rules a project declared.
 *
 * The failure being guarded is a finding the checker cannot prove: a rule that
 * quietly matches more than its author meant produces a confidently-wrong
 * architecture finding, and somebody spends an afternoon looking for a violation
 * that is not there. So most of these pin what does NOT match.
 */

import { describe, expect, it } from "vitest";

import {
	findArchitectureViolations,
	globToRegExp,
	parseArchitectureRules,
} from "../lib/architecture-rules";

const edge = (from: string, to: string) => ({ from, to });

describe("globToRegExp", () => {
	it("keeps a single star inside one segment", () => {
		// The distinction that makes `src/*.ts` mean what its author expects.
		expect(globToRegExp("src/*.ts").test("src/a.ts")).toBe(true);
		expect(globToRegExp("src/*.ts").test("src/deep/a.ts")).toBe(false);
	});

	it("lets a double star cross directories", () => {
		expect(globToRegExp("src/**/*.ts").test("src/a/b/c.ts")).toBe(true);
	});

	it("matches zero directories for `**/`", () => {
		// `src/**/x.ts` should match `src/x.ts`. Getting this wrong makes a rule
		// silently skip the top level, which is where most violations live.
		expect(globToRegExp("src/**/x.ts").test("src/x.ts")).toBe(true);
	});

	it("treats regex metacharacters in a path as literal", () => {
		// A dot is a dot. Without escaping, `a.ts` would match `axts`.
		expect(globToRegExp("src/a.ts").test("src/axts")).toBe(false);
		expect(globToRegExp("src/a.ts").test("src/a.ts")).toBe(true);
	});

	it("anchors both ends", () => {
		expect(globToRegExp("src/db").test("app/src/db")).toBe(false);
		expect(globToRegExp("src/db").test("src/db/index.ts")).toBe(false);
	});
});

describe("findArchitectureViolations", () => {
	const rule = {
		kind: "forbidden" as const,
		from: "src/ui/**",
		to: "src/db/**",
		reason: "the UI must not reach the database directly",
	};

	it("reports an import that breaks a declared rule", () => {
		const v = findArchitectureViolations({
			edges: [edge("src/ui/page.tsx", "src/db/client.ts")],
			rules: [rule],
		});

		expect(v).toHaveLength(1);
		expect(v[0].fromPath).toBe("src/ui/page.tsx");
		expect(v[0].rule.reason).toBe(
			"the UI must not reach the database directly",
		);
	});

	it("reports nothing when the project declared nothing", () => {
		// The honest answer for a repository whose conventions were never
		// recorded. Inferring them from folder names is the bug this replaced.
		expect(
			findArchitectureViolations({
				edges: [edge("src/ui/page.tsx", "src/db/client.ts")],
				rules: [],
			}),
		).toEqual([]);
	});

	it("leaves the allowed direction alone", () => {
		expect(
			findArchitectureViolations({
				edges: [edge("src/db/client.ts", "src/ui/theme.ts")],
				rules: [rule],
			}),
		).toEqual([]);
	});

	it("ignores a self-import", () => {
		expect(
			findArchitectureViolations({
				edges: [edge("src/ui/a.ts", "src/ui/a.ts")],
				rules: [
					{
						kind: "forbidden" as const,
						from: "src/ui/**",
						to: "src/ui/**",
						reason: "x",
					},
				],
			}),
		).toEqual([]);
	});

	it("reports one import once even when two rules forbid it", () => {
		// Three findings on one line reads as three problems.
		const v = findArchitectureViolations({
			edges: [edge("src/ui/page.tsx", "src/db/client.ts")],
			rules: [
				rule,
				{
					kind: "forbidden" as const,
					from: "src/**",
					to: "src/db/**",
					reason: "another rule",
				},
			],
		});

		expect(v).toHaveLength(1);
	});
});

describe("findArchitectureViolations — required imports", () => {
	// The half that makes design-pattern compliance checkable: a team states the
	// pattern ("every route imports the guard") and the graph settles it. Nothing
	// is inferred, so a project that declares no required rule gets none of this.
	const guard = {
		kind: "required" as const,
		from: "src/routes/**",
		to: "src/auth/guard.ts",
		reason: "every route checks the session",
	};

	it("reports a file that imports nothing matching the pattern", () => {
		const v = findArchitectureViolations({
			edges: [edge("src/routes/orders.ts", "src/db/client.ts")],
			rules: [guard],
		});

		expect(v).toHaveLength(1);
		expect(v[0].fromPath).toBe("src/routes/orders.ts");
		// No offending import exists — that is the finding.
		expect(v[0].toPath).toBeNull();
		expect(v[0].rule.reason).toBe("every route checks the session");
	});

	it("says nothing about a file that follows the pattern", () => {
		expect(
			findArchitectureViolations({
				edges: [
					edge("src/routes/orders.ts", "src/auth/guard.ts"),
					edge("src/routes/orders.ts", "src/db/client.ts"),
				],
				rules: [guard],
			}),
		).toEqual([]);
	});

	it("leaves files outside the pattern alone", () => {
		expect(
			findArchitectureViolations({
				edges: [edge("src/jobs/nightly.ts", "src/db/client.ts")],
				rules: [guard],
			}),
		).toEqual([]);
	});

	it("reports a file once per rule, not once per import it has", () => {
		const v = findArchitectureViolations({
			edges: [
				edge("src/routes/orders.ts", "src/db/client.ts"),
				edge("src/routes/orders.ts", "src/lib/money.ts"),
				edge("src/routes/orders.ts", "src/lib/dates.ts"),
			],
			rules: [guard],
		});

		expect(v).toHaveLength(1);
	});

	it("does not let a self-import satisfy the requirement", () => {
		// A file importing itself is a parser artifact; treating it as compliance
		// would let the pattern be satisfied by nothing at all.
		const v = findArchitectureViolations({
			edges: [edge("src/routes/guard.ts", "src/routes/guard.ts")],
			rules: [
				{
					kind: "required" as const,
					from: "src/routes/**",
					to: "src/routes/**",
					reason: "x",
				},
			],
		});

		expect(v).toHaveLength(1);
	});

	it("checks forbidden and required rules in the same pass", () => {
		const v = findArchitectureViolations({
			edges: [edge("src/routes/orders.ts", "src/db/client.ts")],
			rules: [
				guard,
				{
					kind: "forbidden" as const,
					from: "src/routes/**",
					to: "src/db/**",
					reason: "routes go through a service",
				},
			],
		});

		expect(v).toHaveLength(2);
		expect(v.filter((x) => x.toPath === null)).toHaveLength(1);
	});
});

describe("parseArchitectureRules", () => {
	it("reads the documented one-line form", () => {
		const { rules, errors } = parseArchitectureRules(
			"src/ui/** -> src/db/** : the UI must not reach the database",
		);

		expect(errors).toEqual([]);
		expect(rules).toEqual([
			{
				kind: "forbidden",
				from: "src/ui/**",
				to: "src/db/**",
				reason: "the UI must not reach the database",
			},
		]);
	});

	it("reads a required-import rule and marks it as one", () => {
		const { rules, errors } = parseArchitectureRules(
			"src/routes/** => src/auth/guard.ts : every route checks the session",
		);

		expect(errors).toEqual([]);
		expect(rules).toEqual([
			{
				kind: "required",
				from: "src/routes/**",
				to: "src/auth/guard.ts",
				reason: "every route checks the session",
			},
		]);
	});

	it("still requires a reason on a required-import rule", () => {
		const { rules, errors } = parseArchitectureRules(
			"src/routes/** => src/auth/guard.ts",
		);

		expect(rules).toEqual([]);
		expect(errors[0].problem).toContain("add ': why'");
	});

	it("skips blank lines and comments so rules can be grouped", () => {
		const { rules, errors } = parseArchitectureRules(
			"# layering\n\nsrc/ui/** -> src/db/** : no direct db\n",
		);

		expect(errors).toEqual([]);
		expect(rules).toHaveLength(1);
	});

	it("names the line that is wrong instead of rejecting the box", () => {
		// Rejecting everything because line 2 is malformed makes the author hunt
		// for it.
		const { rules, errors } = parseArchitectureRules(
			"src/ui/** -> src/db/** : ok\nsrc/ui/** src/db/**\n",
		);

		expect(rules).toHaveLength(1);
		expect(errors).toEqual([
			{
				line: 2,
				text: "src/ui/** src/db/**",
				problem: "missing '->' or '=>' between the two paths",
			},
		]);
	});

	it("requires a reason, because a finding without one is unactionable", () => {
		const { rules, errors } = parseArchitectureRules(
			"src/ui/** -> src/db/**",
		);

		expect(rules).toEqual([]);
		expect(errors[0].problem).toContain("add ': why'");
	});

	it("requires both sides of the arrow", () => {
		const { rules, errors } = parseArchitectureRules("-> src/db/** : why");

		expect(rules).toEqual([]);
		expect(errors[0].problem).toContain("both sides");
	});
});
