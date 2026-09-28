import { describe, expect, it } from "vitest";
import {
	type CheckRewriteInput,
	checkRewrite,
	checkVisualFacts,
	extractFacts,
	type FactGuardResult,
	isKeySection,
	normalizeFact,
} from "../lib/glossy/fact-guard";

function violationsOf(result: FactGuardResult) {
	return result.pass ? [] : result.violations;
}

function kindsOf(result: FactGuardResult) {
	return violationsOf(result).map((violation) => violation.kind);
}

function rewrite(
	source: string,
	output: string,
	overrides: Partial<CheckRewriteInput> = {},
): FactGuardResult {
	return checkRewrite({
		source,
		output,
		isKeySection: false,
		lengthMode: "standard",
		...overrides,
	});
}

describe("normalizeFact", () => {
	describe("normalization table", () => {
		it.each([
			["$240k", "$240,000"],
			["$240k", "USD 240K"],
			["$240,000", "USD 240K"],
			["15%", "15 percent"],
			["3–5", "3 to 5"],
			["Q3 2026", "third quarter of 2026"],
			["Phase 2", "second phase"],
			["twelve", "12"],
		])("%s matches %s", (left, right) => {
			const normalized = normalizeFact(left);
			expect(normalized).not.toBeNull();
			expect(normalizeFact(right)).toBe(normalized);
		});

		it("£240k does not match $240k", () => {
			expect(normalizeFact("£240k")).not.toBeNull();
			expect(normalizeFact("£240k")).not.toBe(normalizeFact("$240k"));
		});
	});

	describe("further equivalences", () => {
		it.each([
			["$1.2M", "$1,200,000"],
			["$1.2M", "USD 1.2 million"],
			["€3–5M", "€3M to €5M"],
			["240,000 dollars", "$240k"],
			["10–15%", "10% to 15%"],
			["15 per cent", "15%"],
			["Q3'26", "Q3 2026"],
			["2026 Q3", "Q3 2026"],
			["3Q26", "Q3 2026"],
			["H2 2026", "second half of 2026"],
			["FY26", "FY2026"],
			["15 March 2026", "March 15, 2026"],
			["15 March 2026", "2026-03-15"],
			["the 15th of March", "March 15"],
			["Sept 2026", "September 2026"],
			["twenty-five", "25"],
			["one hundred and twenty", "120"],
			["three million", "3M"],
			["Phase two", "Phase 2"],
			["3rd stage", "third stage"],
			["year one", "Year 1"],
		])("%s matches %s", (left, right) => {
			const normalized = normalizeFact(left);
			expect(normalized).not.toBeNull();
			expect(normalizeFact(right)).toBe(normalized);
		});
	});

	describe("rounding, unit conversion, and changed values do not match", () => {
		it.each([
			["$237,500", "$240k"],
			["15.4%", "15%"],
			["$240k", "€240k"],
			["240k", "$240k"],
			["18 months", "1.5 years"],
			["Q3 2026", "Q4 2026"],
			["Q3 2026", "Q3 FY2026"],
		])("%s does not match %s", (left, right) => {
			expect(normalizeFact(left)).not.toBe(normalizeFact(right));
		});
	});

	it.each([
		"the migration team",
		"a percentage of users",
		"May require approval",
		"COVID-19 recovery",
		"S3 bucket",
	])("returns null for %j, which states no figure or date", (text) => {
		expect(normalizeFact(text)).toBeNull();
	});
});

describe("extractFacts", () => {
	it("extracts money, dates, percentages, names, and commitment terms", () => {
		const facts = extractFacts(
			"The board approved $240k. Contoso guarantees a 15% saving by Q3 2026.",
		);

		expect(facts.map((fact) => [fact.kind, fact.text])).toEqual([
			["money", "$240k"],
			["name", "Contoso"],
			["commitment", "guarantees"],
			["percent", "15%"],
			["date", "Q3 2026"],
		]);
	});

	it("does not read ordered-list markers or heading numbers as figures", () => {
		const facts = extractFacts("## 5. Scope\n1. Pilot\n2) Rollout");

		expect(facts.filter((fact) => fact.kind === "number")).toEqual([]);
	});

	it("does not read digits inside URLs, emails, or HTML tags as figures", () => {
		const facts = extractFacts(
			'See https://example.com/v2/report-2026 or dev2@example.com <img width="300">',
		);

		expect(facts.filter((fact) => fact.kind !== "name")).toEqual([]);
	});

	it("marks a sentence-initial capitalized word as sentence-initial", () => {
		const names = extractFacts(
			"Contoso leads.\n- Northwind supports: Fabrikam reviews with Tailspin.",
		).filter((fact) => fact.kind === "name");

		expect(names.map((fact) => [fact.text, fact.sentenceInitial])).toEqual([
			["Contoso", true],
			["Northwind", true],
			["Fabrikam", true],
			["Tailspin", false],
		]);
	});
});

describe("checkRewrite", () => {
	describe("presence", () => {
		const source =
			"The budget is 240k, with the platform live in Q3 2026. Databricks will host the new pipeline.";

		it("passes a condensed rewrite that keeps its facts", () => {
			const output =
				"Databricks hosts the new pipeline, live in Q3 2026 on a 240k budget.";

			expect(rewrite(source, output, { lengthMode: "brief" })).toEqual({
				pass: true,
			});
		});

		it("covers AE2: fails when a Brief rewrite turns 240k into 250k", () => {
			const output =
				"The budget is 250k, with the platform live in Q3 2026.";

			expect(
				violationsOf(rewrite(source, output, { lengthMode: "brief" })),
			).toEqual([
				expect.objectContaining({ kind: "presence", text: "250k" }),
			]);
		});

		it("fails a changed date", () => {
			const output =
				"The budget is 240k, with the platform live in Q4 2026.";

			expect(violationsOf(rewrite(source, output))).toEqual([
				expect.objectContaining({ kind: "presence", text: "Q4 2026" }),
			]);
		});

		it("passes an equivalent form of a source figure", () => {
			const output =
				"The budget is 240,000, with the platform live in the third quarter of 2026.";

			expect(rewrite(source, output)).toEqual({ pass: true });
		});

		it("fails a rounded figure", () => {
			expect(
				violationsOf(
					rewrite(
						"The licence costs $237,500 a year.",
						"The licence costs about $240k a year.",
					),
				),
			).toEqual([
				expect.objectContaining({ kind: "presence", text: "$240k" }),
			]);
		});

		it("fails a rounded percentage", () => {
			expect(
				kindsOf(
					rewrite("Churn falls by 15.4%.", "Churn falls by 15%."),
				),
			).toEqual(["presence"]);
		});

		it("fails a unit conversion", () => {
			expect(
				violationsOf(
					rewrite(
						"Delivery takes 18 months.",
						"Delivery takes 1.5 years.",
					),
				),
			).toEqual([
				expect.objectContaining({ kind: "presence", text: "1.5" }),
			]);
		});

		it("fails a currency conversion", () => {
			expect(
				kindsOf(
					rewrite("The pilot costs $240k.", "The pilot costs €240k."),
				),
			).toEqual(["presence"]);
		});

		it("fails a derived total", () => {
			expect(
				violationsOf(
					rewrite(
						"Licences cost $100k and services cost $140k.",
						"Licences and services cost $240k in total.",
					),
				),
			).toEqual([
				expect.objectContaining({ kind: "presence", text: "$240k" }),
			]);
		});

		it("passes a figure that drops its currency", () => {
			expect(
				rewrite("The pilot costs $240k.", "The pilot costs 240k."),
			).toEqual({ pass: true });
		});

		it("fails a figure that gains a currency the source did not state", () => {
			expect(
				kindsOf(
					rewrite("The pilot costs 240k.", "The pilot costs $240k."),
				),
			).toEqual(["presence"]);
		});

		describe("proper names", () => {
			const namesSource =
				"The data team will migrate the warehouse to Databricks.";

			it("fails a sentence-initial invented name", () => {
				expect(
					violationsOf(
						rewrite(
							namesSource,
							"Contoso will migrate the warehouse to Databricks.",
						),
					),
				).toEqual([
					expect.objectContaining({
						kind: "presence",
						text: "Contoso",
					}),
				]);
			});

			it("passes a sentence-initial common word", () => {
				expect(
					rewrite(
						namesSource,
						"Overall, the data team will move the warehouse to Databricks.",
					),
				).toEqual({ pass: true });
			});

			it("passes a sentence-initial gerund the source does not use", () => {
				expect(
					rewrite(
						namesSource,
						"Migrating the warehouse to Databricks falls to the data team.",
					),
				).toEqual({ pass: true });
			});

			it("fails an invented name mid-sentence", () => {
				expect(
					violationsOf(
						rewrite(
							namesSource,
							"The data team and Northwind will migrate it to Databricks.",
						),
					),
				).toEqual([
					expect.objectContaining({
						kind: "presence",
						text: "Northwind",
					}),
				]);
			});

			it("passes a source name in another case or with a possessive", () => {
				expect(
					rewrite(
						"The warehouse moves to databricks.",
						"Databricks's platform hosts the warehouse.",
					),
				).toEqual({ pass: true });
			});

			it("passes a sentence-initial derived form of a source word", () => {
				expect(
					rewrite(
						"We will retire the old warehouse after the pilot.",
						"**Retirement:** the old warehouse goes after the pilot.",
					),
				).toEqual({ pass: true });
			});

			it("passes a title-cased word the output also uses in lower case", () => {
				expect(
					rewrite(
						"We will retire the old warehouse once the pilot ends and staff are trained.",
						"After the pilot, a Cutover retires the old warehouse; cutover needs trained staff.",
					),
				).toEqual({ pass: true });
			});
		});

		it("fails a commitment term the source does not make", () => {
			expect(
				violationsOf(
					rewrite(
						"The migration is expected to save $50k a year.",
						"The migration is guaranteed to save $50k a year.",
					),
				),
			).toContainEqual(
				expect.objectContaining({
					kind: "presence",
					text: "guaranteed",
				}),
			);
		});

		it("passes a commitment term the source already makes", () => {
			expect(
				rewrite(
					"The vendor has committed to a fixed rate.",
					"The vendor commits to a fixed rate.",
				),
			).toEqual({ pass: true });
		});

		it("does not count a figure found only in a stripped evidence quote", () => {
			// Callers pass the cleaned source (U3): the evidence quote is gone.
			const raw =
				'The budget is $240k ("Vendor quote of $310k, 2026 pricing sheet").';
			const cleaned = "The budget is $240k.";
			const output = "The budget is $240k, under the $310k quote.";

			expect(rewrite(raw, output)).toEqual({ pass: true });
			expect(violationsOf(rewrite(cleaned, output))).toContainEqual(
				expect.objectContaining({ kind: "presence", text: "$310k" }),
			);
		});

		it("does not treat a reformatted numbered list as new figures", () => {
			expect(
				rewrite(
					"The rollout has three steps: pilot, migrate, and retire the old warehouse.",
					"Rollout steps:\n1. Pilot\n2. Migrate\n3. Retire the old warehouse",
				),
			).toEqual({ pass: true });
		});

		it("passes a verbatim copy of an alphanumeric label like 'Option 2B'", () => {
			expect(
				rewrite("We recommend Option 2B.", "We recommend Option 2B."),
			).toEqual({ pass: true });
		});

		it("passes a sentence-initial hyphenated compound", () => {
			expect(
				rewrite(
					"The platform launches in Q3 2026.",
					"Go-live is in Q3 2026.",
				),
			).toEqual({ pass: true });
		});

		it("passes an acronym for words the source spells out", () => {
			expect(
				rewrite("The net present value is $4.5M.", "The NPV is $4.5M."),
			).toEqual({ pass: true });
		});

		it("treats a table cell as a clause start", () => {
			expect(
				rewrite(
					"| Stage | Timing |\n|---|---|\n| Pilot | Q1 2027 |",
					"| Stage | Timing |\n|---|---|\n| Pilot | Q1 2027 |",
				),
			).toEqual({ pass: true });
			expect(
				extractFacts("| Stage | Kickoff |").map(
					(fact) => fact.sentenceInitial,
				),
			).toEqual([true]);
		});

		it("passes an imperative that shares a stem with a source noun", () => {
			expect(
				rewrite(
					"The board's approval of $1.2M is requested.",
					"Approve the $1.2M request.",
				),
			).toEqual({ pass: true });
		});

		it("does not treat an idiomatic 'first step' as a new figure", () => {
			expect(
				rewrite(
					"Approval by the board comes before the pilot.",
					"The first step is board approval, then the pilot.",
				),
			).toEqual({ pass: true });
		});

		it("does not treat 'one' as a pronoun as a new figure", () => {
			expect(
				rewrite(
					"The main risk is vendor lock-in.",
					"One risk stands out: vendor lock-in.",
				),
			).toEqual({ pass: true });
		});
	});

	describe("hedge (covers AE11)", () => {
		const source =
			"Assumed: the new platform delivers a 30% efficiency gain.";

		it("fails a hedged 30% figure restated without a qualifier", () => {
			expect(
				violationsOf(
					rewrite(
						source,
						"The new platform delivers a 30% efficiency gain.",
					),
				),
			).toEqual([
				expect.objectContaining({ kind: "hedge", text: "30%" }),
			]);
		});

		it("passes the same figure with 'expected'", () => {
			expect(
				rewrite(
					source,
					"The new platform is expected to deliver a 30% efficiency gain.",
				),
			).toEqual({ pass: true });
		});

		it.each([
			"indicative",
			"assumed",
			"to be confirmed",
			"dependent on vendor pricing",
			"expected",
			"estimated",
			"approximately",
			"projected",
			"anticipated",
			"subject to approval",
		])("recognises %j as marking the source statement", (qualifier) => {
			const hedgedSource = `The saving is 30% (${qualifier}).`;

			expect(
				kindsOf(rewrite(hedgedSource, "The saving is 30%.")),
			).toEqual(["hedge"]);
			expect(
				rewrite(hedgedSource, `The saving is 30% (${qualifier}).`),
			).toEqual({ pass: true });
		});

		it("needs the qualifier in the same output sentence as the figure", () => {
			expect(
				violationsOf(
					rewrite(
						"The saving is an estimated 30% in the first year.",
						"Savings are estimated. The saving is 30% in the first year.",
					),
				),
			).toEqual([
				expect.objectContaining({ kind: "hedge", text: "30%" }),
			]);
		});

		it("does not require a qualifier when the source also states the figure plainly", () => {
			expect(
				rewrite(
					"The saving is an estimated 30%. The pilot confirmed 30% on one team.",
					"The pilot confirmed a 30% saving on one team.",
				),
			).toEqual({ pass: true });
		});
	});

	describe("must-keep (covers AE12)", () => {
		const source =
			"We request a budget of $240k and a decision by 15 March 2026.";
		const output = "We request a decision by 15 March 2026.";

		it("fails a key section whose rewrite omits the source budget", () => {
			expect(
				violationsOf(
					rewrite(source, output, {
						isKeySection: true,
						lengthMode: "brief",
					}),
				),
			).toEqual([
				expect.objectContaining({ kind: "must-keep", text: "$240k" }),
			]);
		});

		it("passes the same rewrite in a non-key section", () => {
			expect(
				rewrite(source, output, {
					isKeySection: false,
					lengthMode: "brief",
				}),
			).toEqual({ pass: true });
		});

		it("passes a key section that keeps the figure in another form", () => {
			expect(
				rewrite(
					source,
					"We need $240,000 and a decision by 15 March 2026.",
					{
						isKeySection: true,
						lengthMode: "brief",
					},
				),
			).toEqual({ pass: true });
		});

		it("fails a key section that drops the day from a date", () => {
			expect(
				violationsOf(
					rewrite(
						source,
						"We request $240k and a decision in March 2026.",
						{
							isKeySection: true,
						},
					),
				),
			).toEqual([
				expect.objectContaining({
					kind: "must-keep",
					text: "15 March 2026",
				}),
			]);
		});
	});

	describe("structural", () => {
		const source =
			"The migration completes in Q3 2026 and reduces licence spend.";

		it.each([
			[
				"a new URL",
				"The migration completes in Q3 2026. See https://example.com/plan.",
			],
			[
				"a new email address",
				"The migration completes in Q3 2026. Mail dev@example.com.",
			],
			[
				"a markdown link",
				"The [migration](https://example.com) completes in Q3 2026.",
			],
			[
				"a markdown image",
				"![chart](data:image/png;base64,AAAA) The migration completes in Q3 2026.",
			],
			["an HTML tag", "The migration <b>completes</b> in Q3 2026."],
			["a code fence", "```\nThe migration completes in Q3 2026.\n```"],
			[
				"a visual-slot tag",
				'<visual-slot data-slot-id="s1" data-kind="timeline" data-hint=""></visual-slot>\nThe migration completes in Q3 2026.',
			],
			["a heading", "## Timeline\nThe migration completes in Q3 2026."],
			[
				"an added 'not'",
				"The migration does not complete before Q3 2026.",
			],
		])("fails %s", (_label, output) => {
			expect(kindsOf(rewrite(source, output))).toContain("structural");
		});

		it("names what the output added", () => {
			expect(
				violationsOf(
					rewrite(
						source,
						"The migration completes in Q3 2026. See https://example.com/plan.",
					),
				),
			).toContainEqual(
				expect.objectContaining({
					kind: "structural",
					text: "https://example.com/plan",
				}),
			);
		});

		it("passes a URL, link, or negator the source already has", () => {
			const withLink =
				"The [plan](https://example.com/plan) does not change the Q3 2026 date.";

			expect(
				rewrite(
					withLink,
					"The [plan](https://example.com/plan) does not change Q3 2026.",
				),
			).toEqual({ pass: true });
		});

		it("counts every fence-marker line, even one nested inside another fence", () => {
			// Deliberately not `scanFences`: a marker the source quotes inside
			// a fence vouches for the output's, and a marker the output nests
			// inside its own fence still counts as added.
			const statement = "The migration completes in Q3 2026.";
			const lines = (...parts: string[]) => parts.join("\n");
			expect(
				rewrite(
					lines("~~~", "```", statement, "```", "~~~"),
					lines("```", statement, "```"),
				),
			).toEqual({ pass: true });
			expect(
				kindsOf(
					rewrite(
						lines("```", statement, "```"),
						lines("```", "~~~", statement, "```"),
					),
				),
			).toContain("structural");
		});

		it("treats 'not' and 'no' as the same negator", () => {
			expect(
				rewrite(
					"There is no contingency in the current budget.",
					"The budget does not include contingency.",
				),
			).toEqual({ pass: true });
		});

		it("fails an added 'never' even when the source negates with 'not'", () => {
			expect(
				kindsOf(
					rewrite(
						"The old warehouse is not needed after the pilot.",
						"The old warehouse is never needed after the pilot.",
					),
				),
			).toEqual(["structural"]);
		});
	});

	describe("length", () => {
		const source = "The migration completes in Q3 2026.";

		it("fails a Brief output longer than its source", () => {
			expect(
				kindsOf(
					rewrite(
						source,
						"The migration fully completes in Q3 2026.",
						{
							lengthMode: "brief",
						},
					),
				),
			).toEqual(["length"]);
		});

		it("passes the same output in Standard, which allows 1.25 times the source", () => {
			expect(
				rewrite(source, "The migration fully completes in Q3 2026.", {
					lengthMode: "standard",
				}),
			).toEqual({ pass: true });
		});

		it("fails a Standard output longer than 1.25 times its source", () => {
			expect(
				kindsOf(
					rewrite(
						source,
						"The migration of the whole data estate fully completes in Q3 2026.",
						{ lengthMode: "standard" },
					),
				),
			).toEqual(["length"]);
		});

		it("ignores whitespace runs when measuring", () => {
			expect(
				rewrite(source, "  The   migration\ncompletes in Q3 2026.  ", {
					lengthMode: "brief",
				}),
			).toEqual({ pass: true });
		});

		it("fails an empty output for a non-empty source", () => {
			expect(kindsOf(rewrite(source, "   "))).toEqual(["length"]);
		});
	});
});

describe("checkVisualFacts (covers AE4)", () => {
	const section = [
		"## Implementation Phases",
		"The Databricks migration phase starts in Q3 2026 and the retirement phase follows in Q1 2027.",
		"The platform lead owns the rollout, which costs $240k.",
	].join("\n");

	it("fails a timeline date absent from the section", () => {
		expect(
			violationsOf(
				checkVisualFacts(
					{
						kind: "timeline",
						labels: ["Migration", "Retirement"],
						figures: ["Q3 2026", "Q2 2027"],
					},
					section,
				),
			),
		).toEqual([
			expect.objectContaining({ kind: "presence", text: "Q2 2027" }),
		]);
	});

	it('passes "Migration" for "Databricks migration phase"', () => {
		expect(
			checkVisualFacts(
				{
					kind: "timeline",
					labels: ["Migration"],
					figures: ["Q3 2026"],
				},
				section,
			),
		).toEqual({ pass: true });
	});

	it("fails a paraphrase with new words", () => {
		expect(
			violationsOf(
				checkVisualFacts(
					{
						kind: "timeline",
						labels: ["Platform move"],
						figures: [],
					},
					section,
				),
			),
		).toEqual([
			expect.objectContaining({ kind: "label", text: "Platform move" }),
		]);
	});

	it("checks a date inside a label with the same normalizer", () => {
		expect(
			checkVisualFacts(
				{
					kind: "timeline",
					labels: ["Retirement, first quarter of 2027"],
					figures: [],
				},
				section,
			),
		).toEqual({ pass: true });
		expect(
			kindsOf(
				checkVisualFacts(
					{
						kind: "timeline",
						labels: ["Retirement Q2 2027"],
						figures: [],
					},
					section,
				),
			),
		).toEqual(["presence"]);
	});

	it("reads a label's alphanumeric code as one word", () => {
		expect(
			checkVisualFacts(
				{ kind: "comparison", labels: ["Option 2B"], figures: [] },
				"We compared Option 2A with Option 2B.",
			),
		).toEqual({ pass: true });
	});

	it("normalizes figures before comparing", () => {
		expect(
			checkVisualFacts(
				{ kind: "stat", labels: ["Rollout"], figures: ["$240,000"] },
				section,
			),
		).toEqual({ pass: true });
	});

	it.each([
		["comparison", ["Pros", "Cons"]],
		["timeline", ["Start", "Retirement phase"]],
		["org_chart", ["Owner", "Platform lead"]],
	])("allows the %s kind's structural words", (kind, labels) => {
		expect(
			checkVisualFacts({ kind, labels, figures: [] }, section),
		).toEqual({
			pass: true,
		});
	});

	it("keeps the allowlist per kind", () => {
		expect(
			kindsOf(
				checkVisualFacts(
					{ kind: "timeline", labels: ["Pros"], figures: [] },
					section,
				),
			),
		).toEqual(["label"]);
	});
});

describe("untrusted input size", () => {
	it("stays fast on long runs of markup-shaped and digit-shaped text", () => {
		const hostile = [
			"![".repeat(20_000),
			"[".repeat(20_000),
			"<a ".repeat(20_000),
			"1".repeat(20_000),
			"1,000".repeat(5_000),
			`Q3${" ".repeat(20_000)}x`,
			"a".repeat(20_000),
			"a.".repeat(20_000),
		].join("\n");

		const started = Date.now();
		checkRewrite({
			source: hostile,
			output: hostile,
			isKeySection: true,
			lengthMode: "standard",
		});
		expect(Date.now() - started).toBeLessThan(2_000);
	});
});

describe("isKeySection", () => {
	it.each([
		[["Executive Summary"]],
		[["5. Executive Summary (Required)"]],
		[["**Recommendation**"]],
		[["Decision Required"]],
		[["Investment"]],
		[["Budget"]],
		[["Cost Breakdown"]],
		[["Costs and Benefits"]],
		[["Financials", "Budget"]],
		[["Recommendation", "Timeline"]],
	])("treats %j as a key section", (headingPath) => {
		expect(isKeySection(headingPath)).toBe(true);
	});

	it.each([
		[["Implementation Phases"]],
		[["Risks"]],
		[["Costa Rica Office"]],
		[["Background", "Context"]],
		[[]],
	])("does not treat %j as a key section", (headingPath) => {
		expect(isKeySection(headingPath)).toBe(false);
	});
});
