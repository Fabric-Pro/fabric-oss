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
import { type VisualSpec, visualSpecFacts } from "../lib/glossy/visual-spec";

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

		it("fails 'with the pilot' reversed to 'without the pilot'", () => {
			expect(
				violationsOf(
					rewrite(
						"Delivered with the pilot.",
						"Delivered without the pilot.",
					),
				),
			).toEqual([
				expect.objectContaining({
					kind: "structural",
					text: "without",
				}),
			]);
		});

		it("fails an added 'never' even when the source negates with 'not'", () => {
			// The swap also drops the source's "not", which the negation
			// check reports on its own.
			expect(
				kindsOf(
					rewrite(
						"The old warehouse is not needed after the pilot.",
						"The old warehouse is never needed after the pilot.",
					),
				),
			).toEqual(["structural", "negation"]);
		});

		it("fails a second 'not' added to a source that states one", () => {
			// The source already uses the "not" group, so a check on group
			// presence alone would accept this reversal of the second statement.
			expect(
				violationsOf(
					rewrite(
						"X is not in scope. Y is in scope.",
						"X is not in scope. Y is not in scope.",
					),
				),
			).toEqual([
				expect.objectContaining({ kind: "structural", text: "not" }),
			]);
		});

		it("counts per occurrence: 'not X and Y' to 'not X and not Y' fails", () => {
			expect(
				violationsOf(
					rewrite(
						"The pilot does not cover billing and covers reporting.",
						"The pilot does not cover billing and does not cover reporting.",
					),
				),
			).toEqual([
				expect.objectContaining({
					kind: "structural",
					text: "not",
					message: expect.stringContaining(
						"1 in the source, 2 in the rewrite",
					),
				}),
			]);
		});

		it("fails 'not X or Y' rephrased as 'neither X nor Y': a known false positive of counting", () => {
			// Pinned on purpose: "neither … nor" is two negating words for one
			// negation, as the dropped count needs it to be ("not A. not B." may
			// become "Neither A nor B"). Rejecting this only keeps the source
			// wording.
			expect(
				kindsOf(
					rewrite(
						"The budget does not cover travel or training.",
						"The budget covers neither travel nor training.",
					),
				),
			).toEqual(["structural"]);
		});

		it.each([
			[
				"'no' and 'not' kept as 'no' and 'does not'",
				"There is no contingency, and travel is not covered.",
				"The budget has no contingency and does not cover travel.",
			],
			[
				"'isn't' kept as 'is not'",
				"A second data centre isn't planned for 2026.",
				"A second data centre is not planned for 2026.",
			],
		])(
			"passes a rewrite with as many negating words per group as its source: %s",
			(_label, source, output) => {
				expect(rewrite(source, output)).toEqual({ pass: true });
			},
		);
	});

	describe("negation", () => {
		it("fails 'not in scope' rewritten as 'in scope'", () => {
			expect(
				violationsOf(
					rewrite(
						"Data migration is not in scope for Phase 1.",
						"Data migration is in scope for Phase 1.",
					),
				),
			).toEqual([
				expect.objectContaining({ kind: "negation", text: "not" }),
			]);
		});

		it.each([
			[
				"isn't",
				"A second data centre isn't planned for 2026.",
				"A second data centre is planned for 2026.",
			],
			[
				"no longer",
				"The nightly batch will no longer run after cutover.",
				"The nightly batch will run after cutover.",
			],
			[
				"without",
				"The rollout starts without a pilot in Q3 2026.",
				"The rollout starts with a pilot in Q3 2026.",
			],
			[
				"won't",
				"The vendor won't renew the support contract.",
				"The vendor renews the support contract.",
			],
			[
				"can't",
				"The current platform can't scale past 400 users.",
				"The current platform scales past 400 users.",
			],
			[
				"don't",
				"Branch offices don't need new hardware.",
				"Branch offices need new hardware.",
			],
			[
				"doesn't",
				"The budget doesn't include contingency.",
				"The budget includes contingency.",
			],
			[
				"aren't",
				"Contractors aren't covered by the licence.",
				"Contractors are covered by the licence.",
			],
			[
				"wasn't",
				"The pilot wasn't extended past the first site.",
				"The pilot was extended past the first site.",
			],
			[
				"shouldn't",
				"Teams shouldn't migrate before the audit.",
				"Teams migrate before the audit.",
			],
			[
				"cannot",
				"The archive cannot move to the cloud.",
				"The archive moves to the cloud.",
			],
			[
				"never",
				"Customer data is never stored offshore.",
				"Customer data is stored offshore.",
			],
			[
				"none",
				"None of the three vendors meets the baseline.",
				"All three vendors meet the baseline.",
			],
			[
				"neither, nor",
				"Neither the budget nor the timeline changes.",
				"The budget and the timeline change.",
			],
		])("fails a dropped '%s'", (dropped, source, output) => {
			expect(violationsOf(rewrite(source, output))).toEqual([
				expect.objectContaining({ kind: "negation", text: dropped }),
			]);
		});

		it("counts per occurrence: 'not X and not Y' to 'not X and Y' fails", () => {
			expect(
				kindsOf(
					rewrite(
						"The pilot does not cover billing and does not cover reporting.",
						"The pilot does not cover billing and covers reporting.",
					),
				),
			).toEqual(["negation"]);
		});

		it("passes a negation kept in other words", () => {
			expect(
				rewrite(
					"Data migration is not in scope for Phase 1.",
					"Data migration is not included in scope for Phase 1.",
				),
			).toEqual({ pass: true });
		});

		it("fails two negated statements merged under one negation, which the rewrite prompt forbids", () => {
			expect(
				violationsOf(
					rewrite(
						"Data migration is not in scope. Reporting is not in scope.",
						"Data migration and reporting are not in scope.",
					),
				),
			).toEqual([
				expect.objectContaining({
					kind: "negation",
					text: "not",
					message: expect.stringContaining(
						"2 in the source, 1 in the rewrite",
					),
				}),
			]);
		});

		it("passes the same merge when each negation keeps its own word", () => {
			expect(
				rewrite(
					"Data migration is not in scope. Reporting is not in scope.",
					"Neither data migration nor reporting is in scope.",
				),
			).toEqual({ pass: true });
		});

		it("fails a negation moved to another statement (flipped from a pinned known limit): the clause check aligns the statements and compares their polarity", () => {
			// Flipped on purpose: this once passed because the section-wide
			// count is unchanged. Each clause now aligns with its rewrite by
			// shared content words, so the move shows in both statements.
			expect(
				violationsOf(
					rewrite(
						"Data migration is not in scope; reporting is in scope.",
						"Data migration is in scope; reporting is not in scope.",
					),
				),
			).toEqual([
				expect.objectContaining({
					kind: "negation",
					text: "Data migration is not in scope",
					message: expect.stringContaining(
						'Reverses the polarity of "Data migration is not in scope"',
					),
				}),
				expect.objectContaining({
					kind: "negation",
					text: "reporting is in scope",
					message: expect.stringContaining(
						'the rewrite\'s matching clause "reporting is not in scope"',
					),
				}),
			]);
		});

		it.each([
			[
				"sentences",
				"Data migration is not in scope. Reporting is in scope.",
				"Data migration is in scope. Reporting is not in scope.",
			],
			[
				"list items",
				"- Data migration is not in scope\n- Reporting is in scope",
				"- Data migration is in scope\n- Reporting is not in scope",
			],
			[
				"paragraphs",
				"Data migration is not in scope for Phase 1\n\nReporting is in scope for Phase 1",
				"Data migration is in scope for Phase 1\n\nReporting is not in scope for Phase 1",
			],
		])("fails a negation moved between %s", (_label, source, output) => {
			expect(kindsOf(rewrite(source, output))).toEqual([
				"negation",
				"negation",
			]);
		});

		it("passes the same statements reordered with each negation kept", () => {
			expect(
				rewrite(
					"Data migration is not in scope; reporting is in scope.",
					"Reporting is in scope; data migration is not in scope.",
				),
			).toEqual({ pass: true });
		});

		it.each([
			[
				"a negated statement folded into a positive one",
				"The pilot does not include billing. It covers reporting and analytics for the finance team.",
				"The pilot covers reporting and analytics for finance, not billing.",
			],
			[
				"a trailing negation turned into its own clause",
				"The pilot covers billing, but not reporting, in Q3 2026.",
				"The pilot does not cover reporting; it covers billing in Q3 2026.",
			],
		])(
			"passes %s: only one end of the apparent move aligns",
			(_label, source, output) => {
				// A moved negation leaves an aligned clause and reaches another.
				// When only one end aligns, the other clause was condensed or
				// restructured, and the totals judge it.
				expect(rewrite(source, output)).toEqual({ pass: true });
			},
		);

		it("passes a sentence soft-wrapped across lines: a line break alone does not end a clause", () => {
			expect(
				rewrite(
					"Data migration for the Phase 1 rollout is\nnot in scope.",
					"Data migration for the Phase 1 rollout is not in scope.",
				),
			).toEqual({ pass: true });
		});

		it("applies only the section-wide counts to a Brief merge of two negated statements", () => {
			// The merged clause matches both source clauses, so neither aligns
			// and only the existing section-wide counts judge the merge.
			const source =
				"Data migration is not in scope. Reporting is not in scope.";
			expect(
				rewrite(
					source,
					"Neither data migration nor reporting is in scope.",
					{
						lengthMode: "brief",
					},
				),
			).toEqual({ pass: true });
			expect(
				violationsOf(
					rewrite(
						source,
						"Data migration and reporting are not in scope.",
						{
							lengthMode: "brief",
						},
					),
				),
			).toEqual([
				expect.objectContaining({ kind: "negation", text: "not" }),
			]);
		});

		it("passes a faithful reordered rewrite with no negation", () => {
			expect(
				rewrite(
					"The migration completes in Q3 2026 and reduces licence spend. The platform team owns the cutover.",
					"The platform team owns the cutover. The migration completes in Q3 2026 and cuts licence spend.",
				),
			).toEqual({ pass: true });
		});

		it("fails an added 'without disruption' (flipped from passing): the rewrite prompt forbids adding 'without', so both directions count it", () => {
			// Flipped on purpose: this once passed because only the dropped
			// direction counted "without". A false positive here only keeps
			// the source wording, which is the safe side.
			expect(
				violationsOf(
					rewrite(
						"The cutover to the new platform runs over one weekend in Q3 2026.",
						"The cutover runs over one weekend in Q3 2026 without disruption.",
					),
				),
			).toEqual([
				expect.objectContaining({
					kind: "structural",
					text: "without",
				}),
			]);
		});

		it.each([
			[
				"No. of seats",
				"Licence count: No. of seats in Phase 1 is 40.",
				"Licence count: the number of seats in Phase 1 is 40.",
			],
			[
				"No. 4471",
				"Purchase order No. 4471 covers the Phase 1 licences.",
				"Purchase order 4471 covers the Phase 1 licences.",
			],
		])(
			"passes a dropped '%s': the abbreviation is not a negator",
			(_label, source, output) => {
				expect(rewrite(source, output)).toEqual({ pass: true });
			},
		);

		it.each([
			[
				"no-code",
				"The team builds the intake form with a no-code tool.",
				"The team builds the intake form with a visual tool.",
			],
			[
				"no-show",
				"Each no-show is rebooked within 2 days.",
				"Each missed session is rebooked within 2 days.",
			],
			[
				"go/no-go",
				"The go/no-go review closes Phase 1 in Q3 2026.",
				"The launch review closes Phase 1 in Q3 2026.",
			],
			[
				"yes-no",
				"The board takes a yes-no vote in Q3 2026.",
				"The board votes in Q3 2026.",
			],
			[
				"not only",
				"The new platform is not only faster but also cheaper.",
				"The new platform is faster and cheaper.",
			],
			[
				"no matter",
				"The cutover happens in Q3 2026 no matter how the pilot ends.",
				"The cutover happens in Q3 2026 whatever the pilot shows.",
			],
			[
				"no doubt",
				"There is no doubt the pilot met its 90% target.",
				"The pilot clearly met its 90% target.",
			],
		])(
			"passes a dropped '%s', which negates nothing",
			(_label, source, output) => {
				expect(rewrite(source, output)).toEqual({ pass: true });
			},
		);

		it.each([
			[
				"no-code",
				"The team builds the intake form with a visual tool.",
				"The team builds the intake form with a no-code tool.",
			],
			[
				"not only",
				"The new platform is faster and cheaper than the current one.",
				"The new platform is not only faster but also cheaper.",
			],
			[
				"no matter",
				"The cutover happens in Q3 2026 whatever the pilot shows.",
				"The cutover happens in Q3 2026 no matter how the pilot ends.",
			],
			[
				"no doubt",
				"The pilot clearly met its 90% target in Q3 2026.",
				"There is no doubt the pilot met its 90% target.",
			],
			[
				"No. 4471",
				"Purchase order 4471 covers the Phase 1 licences.",
				"Purchase order No. 4471 covers the Phase 1 licences.",
			],
		])(
			"passes an added '%s' too: both directions skip the same uses",
			(_label, source, output) => {
				expect(rewrite(source, output)).toEqual({ pass: true });
			},
		);

		it("still fails a real 'not' dropped next to 'not only' and a 'no-' compound", () => {
			expect(
				violationsOf(
					rewrite(
						"The no-code builder is not only faster but also cheaper, and it is not hosted offshore.",
						"The no-code builder is faster and cheaper, and it is hosted offshore.",
					),
				),
			).toEqual([
				expect.objectContaining({
					kind: "negation",
					text: "not",
					message: expect.stringContaining(
						"1 in the source, 0 in the rewrite",
					),
				}),
			]);
		});

		it.each([
			[
				"no-one",
				"The rollout means no-one on the team needs new hardware.",
				"The rollout means everyone on the team needs new hardware.",
			],
			[
				"no-longer",
				"The no-longer-supported client retires in Q3 2026.",
				"The supported client retires in Q3 2026.",
			],
		])("still counts '%s' as a negation", (_label, source, output) => {
			expect(violationsOf(rewrite(source, output))).toEqual([
				expect.objectContaining({ kind: "negation", text: "no" }),
			]);
		});

		it("still counts a 'not-' compound, which usually negates", () => {
			expect(
				kindsOf(
					rewrite(
						"Phase 2 remains not-yet-funded in Q3 2026.",
						"Phase 2 remains funded in Q3 2026.",
					),
				),
			).toEqual(["negation"]);
		});

		it("still counts a sentence-ending 'No.' as a negation", () => {
			expect(
				kindsOf(
					rewrite(
						"Is Phase 2 funded? No. The board reviews it in Q3 2026.",
						"The board reviews Phase 2 in Q3 2026.",
					),
				),
			).toEqual(["negation"]);
		});

		it.each([
			[
				"a link target",
				"The [runbook](https://example.com/no-downtime) covers the Q3 2026 cutover.",
				"The runbook covers the Q3 2026 cutover.",
			],
			[
				"an image's alt text",
				"![No change in headcount](https://example.com/chart.png)\nRevenue grows 4% in Q3 2026.",
				"Revenue grows 4% in Q3 2026.",
			],
		])(
			"ignores a negating word in %s, which a rewrite may drop",
			(_label, source, output) => {
				expect(rewrite(source, output)).toEqual({ pass: true });
			},
		);

		it("passes a source and output with no negator", () => {
			expect(
				rewrite(
					"The migration completes in Q3 2026 and reduces licence spend.",
					"The migration completes in Q3 2026.",
				),
			).toEqual({ pass: true });
		});

		it("still reports an added negator as structural, not as a dropped negation", () => {
			expect(
				kindsOf(
					rewrite(
						"The migration completes in Q3 2026 and reduces licence spend.",
						"The migration does not complete before Q3 2026.",
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

describe("checkVisualFacts placeholders (Fizzy #2589 follow-up)", () => {
	/** What extraction checks a visual against: the heading, then the body. */
	const headingOnly = "Options Considered\n\n";
	const options = [
		"Options Considered",
		"",
		"We compared a managed platform with an in-house build.",
		"The managed platform ships faster; the in-house build gives full control.",
	].join("\n");
	/** A template body: each placeholder is in the source, so no word is new. */
	const template = [
		"Owner Details",
		"",
		"Owner: [Owner Name]. Sponsor: \\[Sponsor Name\\]. Budget: TBD. Scope: TBC.",
		"Launch: TBA. Region: N/A. Risk: unknown. Notes: placeholder.",
		"Lorem ipsum dolor sit amet. Choose <Option X>.",
	].join("\n");

	const unknownComparison: VisualSpec = {
		kind: "comparison",
		title: "Options Considered",
		items: [
			{ title: "<UNKNOWN>", points: ["<UNKNOWN>"] },
			{ title: "<UNKNOWN>", points: ["<UNKNOWN>"] },
		],
	};

	it("fails a comparison of <UNKNOWN> items for a heading-only section", () => {
		expect(
			violationsOf(
				checkVisualFacts(
					visualSpecFacts(unknownComparison),
					headingOnly,
				),
			),
		).toEqual([
			expect.objectContaining({ kind: "placeholder", text: "<UNKNOWN>" }),
		]);
	});

	it("fails a comparison of <UNKNOWN> items for a section with real text", () => {
		expect(
			violationsOf(
				checkVisualFacts(visualSpecFacts(unknownComparison), options),
			),
		).toEqual([
			expect.objectContaining({ kind: "placeholder", text: "<UNKNOWN>" }),
		]);
	});

	it.each([
		"TBD",
		"TBC",
		"TBA",
		"Placeholder",
		"Lorem ipsum",
		"Lorem ipsum dolor sit amet",
		"[Owner Name]",
		String.raw`\[Sponsor Name\]`,
		"<Option X>",
		"**TBD**",
		"TBD.",
	])(
		"fails the whole-value placeholder label %j even when the source has it",
		(label) => {
			expect(
				violationsOf(
					checkVisualFacts(
						{ kind: "org_chart", labels: [label], figures: [] },
						template,
					),
				),
			).toEqual([
				expect.objectContaining({ kind: "placeholder", text: label }),
			]);
		},
	);

	it("fails a placeholder stat value and a placeholder figure", () => {
		const stat = visualSpecFacts({
			kind: "stat",
			items: [{ value: "TBD", label: "Budget" }],
		});
		expect(kindsOf(checkVisualFacts(stat, template))).toEqual([
			"placeholder",
		]);
		expect(
			kindsOf(
				checkVisualFacts(
					{ kind: "stat", labels: ["Budget"], figures: ["TBA"] },
					template,
				),
			),
		).toEqual(["placeholder"]);
	});

	describe("N/A and Unknown, which a source can state as content", () => {
		const breakdown = [
			"Responses by Region",
			"",
			"North 60%, South 15%, Unknown 25%.",
			"The legacy connector is N/A for the new platform.",
		].join("\n");

		it("passes a stat whose source says Unknown", () => {
			const stat = visualSpecFacts({
				kind: "stat",
				items: [
					{ value: "60%", label: "North" },
					{ value: "25%", label: "Unknown" },
				],
			});
			expect(checkVisualFacts(stat, breakdown)).toEqual({ pass: true });
		});

		it("passes a comparison cell the source states as N/A", () => {
			const comparison = visualSpecFacts({
				kind: "comparison",
				items: [
					{ title: "Legacy connector", points: ["N/A"] },
					{ title: "North", points: ["60%"] },
				],
			});
			expect(checkVisualFacts(comparison, breakdown)).toEqual({
				pass: true,
			});
		});

		it.each(["N/A", "n/a", "**N/A**", "Unknown", "unknown"])(
			"fails %j when the source never states it",
			(label) => {
				expect(
					violationsOf(
						checkVisualFacts(
							{
								kind: "comparison",
								labels: [label],
								figures: [],
							},
							options,
						),
					),
				).toEqual([
					expect.objectContaining({
						kind: "placeholder",
						text: label,
					}),
				]);
			},
		);

		it("does not read a bracketed <Unknown> or [N/A] in the source as stating it", () => {
			const bracketed = "Region: <Unknown>. Owner: [N/A].";
			expect(
				kindsOf(
					checkVisualFacts(
						{
							kind: "comparison",
							labels: ["Unknown", "N/A"],
							figures: [],
						},
						bracketed,
					),
				),
			).toEqual(["placeholder", "placeholder"]);
		});

		it("still fails a comparison of <UNKNOWN> items when the source says Unknown", () => {
			const comparison = visualSpecFacts({
				kind: "comparison",
				items: [
					{ title: "<UNKNOWN>", points: ["<UNKNOWN>"] },
					{ title: "<UNKNOWN>", points: ["<UNKNOWN>"] },
				],
			});
			expect(
				violationsOf(checkVisualFacts(comparison, breakdown)),
			).toEqual([
				expect.objectContaining({
					kind: "placeholder",
					text: "<UNKNOWN>",
				}),
			]);
		});
	});

	it("reads angle brackets inside a label as text, not markup", () => {
		expect(
			violationsOf(
				checkVisualFacts(
					{
						kind: "comparison",
						labels: ["Managed platform <UNKNOWN>"],
						figures: [],
					},
					options,
				),
			),
		).toEqual([
			expect.objectContaining({
				kind: "label",
				text: "Managed platform <UNKNOWN>",
			}),
		]);
	});

	it("passes a real comparison of the section's options", () => {
		const comparison: VisualSpec = {
			kind: "comparison",
			title: "Options Considered",
			items: [
				{ title: "Managed platform", points: ["Ships faster"] },
				{ title: "In-house build", points: ["Full control"] },
			],
		};
		expect(checkVisualFacts(visualSpecFacts(comparison), options)).toEqual({
			pass: true,
		});
	});

	it("passes a real label that only contains a placeholder word", () => {
		expect(
			checkVisualFacts(
				{
					kind: "comparison",
					labels: ["Unknown risk", "Owner placeholder notes"],
					figures: [],
				},
				template,
			),
		).toEqual({ pass: true });
	});
});

/** What extraction checks a visual against: the heading, then the body. */
function sectionText(heading: string, ...body: string[]): string {
	return [heading, "", ...body].join("\n");
}

describe("checkVisualFacts flows (Fizzy #2589 follow-up)", () => {
	/** The fact check's input for a flow, as extraction builds it. */
	function flowFacts(
		heading: string | null,
		steps: ReadonlyArray<{ label: string; lane?: string }>,
	) {
		return {
			...visualSpecFacts({ kind: "flow", steps: [...steps] }),
			heading,
			flowSteps: steps.map((step) => step.label),
		};
	}

	it("fails a flow drawn from an Open Questions section", () => {
		const section = sectionText(
			"Open Questions",
			"- Who approves the budget?",
			"- Which vendor hosts the platform?",
			"- When does the pilot start?",
		);
		const result = checkVisualFacts(
			flowFacts("11) Open Questions", [
				{ label: "Who approves the budget?" },
				{ label: "Which vendor hosts the platform?" },
				{ label: "When does the pilot start?" },
			]),
			section,
		);
		expect(violationsOf(result)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "flow-sequence",
					text: "11) Open Questions",
				}),
			]),
		);
		expect(new Set(kindsOf(result))).toEqual(new Set(["flow-sequence"]));
	});

	it.each([
		"In Scope",
		"4.2 Out of Scope",
		"Scope / In Scope / Out of Scope",
		"**Key Risks and Assumptions**",
		"Goals / Non-Goals",
		"6) Deliverables (Required)",
		"Stakeholders",
		"Dependencies",
		"Success Metrics",
		"Requirements",
		"Capabilities",
		"Features",
		"Questions",
	])(
		"fails a flow under the list-type heading %j, even with numbered steps",
		(heading) => {
			const section = sectionText(
				heading,
				"1. Discovery workshop",
				"2. Design review",
				"3. Pilot launch",
			);
			expect(
				violationsOf(
					checkVisualFacts(
						flowFacts(heading, [
							{ label: "Discovery workshop" },
							{ label: "Design review" },
							{ label: "Pilot launch" },
						]),
						section,
					),
				),
			).toEqual([
				expect.objectContaining({
					kind: "flow-sequence",
					text: heading,
				}),
			]);
		},
	);

	it.each([
		"Risk Mitigation Process",
		"Delivery Approach",
		"Scope Review Workflow",
		"Next Steps",
	])("does not read %j as a list-type heading", (heading) => {
		const section = sectionText(
			heading,
			"First the team holds a discovery workshop, then a design review, and finally the pilot launch.",
		);
		expect(
			checkVisualFacts(
				flowFacts(heading, [
					{ label: "Discovery workshop" },
					{ label: "Design review" },
					{ label: "Pilot launch" },
				]),
				section,
			),
		).toEqual({ pass: true });
	});

	it.each([
		[
			"questions ending in a question mark",
			[
				"Is the budget approved?",
				"Is the vendor selected?",
				"Is the launch date agreed?",
			],
		],
		[
			"Q-numbered questions",
			[
				"Q1: Is the budget approved",
				"Q2: Is the vendor selected",
				"Q3: Is the launch date agreed",
			],
		],
	])("fails a flow of %s", (_label, labels) => {
		const section = sectionText(
			"Decision Points",
			"First, Q1: is the budget approved? Then Q2: is the vendor selected?",
			"Finally Q3: is the launch date agreed?",
		);
		expect(
			violationsOf(
				checkVisualFacts(
					flowFacts(
						"Decision Points",
						labels.map((label) => ({ label })),
					),
					section,
				),
			),
		).toEqual([
			expect.objectContaining({
				kind: "flow-sequence",
				text: "3 of 3 steps are questions",
			}),
		]);
	});

	it("reads a quarter-labelled step as a step, not a question", () => {
		const section = sectionText(
			"Rollout Plan",
			"1. Q1: Discovery",
			"2. Q2: Design",
			"3. Q3) Rollout",
		);
		expect(
			checkVisualFacts(
				flowFacts("Rollout Plan", [
					{ label: "Q1: Discovery" },
					{ label: "Q2: Design" },
					{ label: "Q3) Rollout" },
				]),
				section,
			),
		).toEqual({ pass: true });
	});

	it("reads a Q-numbered label that opens with an interrogative as a question", () => {
		const section = sectionText(
			"Decision Points",
			"First, Q1: which vendor hosts the platform?",
			"Then Q2: should the pilot start early?",
		);
		expect(
			violationsOf(
				checkVisualFacts(
					flowFacts("Decision Points", [
						{ label: "Q1: Which vendor hosts the platform" },
						{ label: "Q2) Should the pilot start early" },
					]),
					section,
				),
			),
		).toEqual([
			expect.objectContaining({
				kind: "flow-sequence",
				text: "2 of 2 steps are questions",
			}),
		]);
	});

	it.each([
		"Decision Criteria",
		"Key Evaluation Criteria",
		"Options",
		"Alternatives",
		"Benefits",
		"Constraints",
		"Unknowns",
		"Known Issues",
		"Objectives",
		"Outcomes",
		"Metrics",
		"KPIs",
		"Principles",
		"Considerations",
		"Roles and Responsibilities",
	])(
		"fails a flow under the list-type heading %j, even with numbered steps",
		(heading) => {
			const section = sectionText(
				heading,
				"1. Discovery workshop",
				"2. Design review",
				"3. Pilot launch",
			);
			expect(
				violationsOf(
					checkVisualFacts(
						flowFacts(heading, [
							{ label: "Discovery workshop" },
							{ label: "Design review" },
							{ label: "Pilot launch" },
						]),
						section,
					),
				),
			).toEqual([
				expect.objectContaining({
					kind: "flow-sequence",
					text: heading,
				}),
			]);
		},
	);

	it.each([
		// A process word makes the heading a process, whatever list term it holds.
		"Risk Process",
		"Requirements Workflow",
		// A word after the list term is the heading's head noun: a process.
		"Risk Management",
		"Issue Escalation",
		"Implementation Steps",
	])("reads %j as a process heading, not a list", (heading) => {
		const section = sectionText(
			heading,
			"1. Discovery workshop",
			"2. Design review",
			"3. Pilot launch",
		);
		expect(
			checkVisualFacts(
				flowFacts(heading, [
					{ label: "Discovery workshop" },
					{ label: "Design review" },
					{ label: "Pilot launch" },
				]),
				section,
			),
		).toEqual({ pass: true });
	});

	it.each([
		["Approval Flow"],
		["Onboarding journey"],
		["Release Pipeline"],
		["Contract Lifecycle"],
		["Escalation Path"],
		["Delivery Stages"],
	])(
		"reads the heading %j as naming a process that states an order",
		(heading) => {
			const section = sectionText(
				heading,
				"- Submit the request",
				"- Review the request",
				"- Grant access",
			);
			expect(
				checkVisualFacts(
					flowFacts(heading, [
						{ label: "Submit the request" },
						{ label: "Review the request" },
						{ label: "Grant access" },
					]),
					section,
				),
			).toEqual({ pass: true });
		},
	);

	it("does not read a Cash Flow heading as naming a process", () => {
		const section = sectionText(
			"Cash Flow",
			"- Licence savings",
			"- Support savings",
			"- Hosting costs",
		);
		expect(
			violationsOf(
				checkVisualFacts(
					flowFacts("Cash Flow", [
						{ label: "Licence savings" },
						{ label: "Support savings" },
						{ label: "Hosting costs" },
					]),
					section,
				),
			),
		).toEqual([
			expect.objectContaining({
				kind: "flow-sequence",
				text: "no numbered steps or sequencing words",
			}),
		]);
	});

	it.each([
		"The rollout runs in three phases: pilot, regional, global.",
		"The rollout follows this sequence: pilot, regional, global.",
	])("reads %j as sequencing language", (sentence) => {
		expect(
			checkVisualFacts(
				flowFacts("Rollout", [
					{ label: "Pilot" },
					{ label: "Regional" },
					{ label: "Global" },
				]),
				sectionText("Rollout", sentence),
			),
		).toEqual({ pass: true });
	});

	describe("a flow the author placed", () => {
		const capabilities = sectionText(
			"Platform Overview",
			"- Automated invoice matching",
			"- Supplier portal",
			"- Spend analytics dashboard",
		);
		const capabilitySteps = [
			{ label: "Automated invoice matching" },
			{ label: "Supplier portal" },
			{ label: "Spend analytics dashboard" },
		];

		it("skips the stated-order rule", () => {
			expect(
				checkVisualFacts(
					{
						...flowFacts("Platform Overview", capabilitySteps),
						authorRequested: true,
					},
					capabilities,
				),
			).toEqual({ pass: true });
			expect(
				kindsOf(
					checkVisualFacts(
						flowFacts("Platform Overview", capabilitySteps),
						capabilities,
					),
				),
			).toEqual(["flow-sequence"]);
		});

		it("still fails under a list-type heading", () => {
			const section = sectionText(
				"Open Questions",
				"- Automated invoice matching",
				"- Supplier portal",
				"- Spend analytics dashboard",
			);
			expect(
				violationsOf(
					checkVisualFacts(
						{
							...flowFacts("Open Questions", capabilitySteps),
							authorRequested: true,
						},
						section,
					),
				),
			).toEqual([
				expect.objectContaining({
					kind: "flow-sequence",
					text: "Open Questions",
				}),
			]);
		});

		it("still fails a flow of questions", () => {
			const section = sectionText(
				"Platform Overview",
				"- Is the budget approved?",
				"- Is the vendor selected?",
			);
			expect(
				violationsOf(
					checkVisualFacts(
						{
							...flowFacts("Platform Overview", [
								{ label: "Is the budget approved?" },
								{ label: "Is the vendor selected?" },
							]),
							authorRequested: true,
						},
						section,
					),
				),
			).toEqual([
				expect.objectContaining({
					kind: "flow-sequence",
					text: "2 of 2 steps are questions",
				}),
			]);
		});
	});

	it("fails a flow from an unordered capability list with no sequencing language", () => {
		const section = sectionText(
			"Platform Overview",
			"- Automated invoice matching",
			"- Supplier portal",
			"- Spend analytics dashboard",
			"- Approval rules engine",
		);
		expect(
			violationsOf(
				checkVisualFacts(
					flowFacts("Platform Overview", [
						{ label: "Automated invoice matching" },
						{ label: "Supplier portal" },
						{ label: "Spend analytics dashboard" },
						{ label: "Approval rules engine" },
					]),
					section,
				),
			),
		).toEqual([
			expect.objectContaining({
				kind: "flow-sequence",
				text: "no numbered steps or sequencing words",
			}),
		]);
	});

	describe("reads the order from the flow's own steps", () => {
		const noOrder = expect.objectContaining({
			kind: "flow-sequence",
			text: "no numbered steps or sequencing words",
		});

		it("fails a flow of bullets when only an unrelated sentence has a sequencing word", () => {
			const section = sectionText(
				"Market Context",
				"- Growing demand for self-service",
				"- Consolidation among vendors",
				"- Pressure on licence margins",
				"",
				"We revisit pricing next quarter.",
			);
			expect(
				violationsOf(
					checkVisualFacts(
						flowFacts("Market Context", [
							{ label: "Growing demand for self-service" },
							{ label: "Consolidation among vendors" },
							{ label: "Pressure on licence margins" },
						]),
						section,
					),
				),
			).toEqual([noOrder]);
		});

		it("fails a flow whose steps are not the section's numbered entries", () => {
			const section = sectionText(
				"Delivery Model",
				"1. Platform team",
				"2. Data team",
				"3. Security team",
				"",
				"- Weekly demos",
				"- Shared backlog",
				"- Joint planning",
			);
			expect(
				violationsOf(
					checkVisualFacts(
						flowFacts("Delivery Model", [
							{ label: "Weekly demos" },
							{ label: "Shared backlog" },
							{ label: "Joint planning" },
						]),
						section,
					),
				),
			).toEqual([noOrder]);
		});

		it("fails a flow that reorders the section's numbered entries", () => {
			const section = sectionText(
				"Onboarding",
				"1. Submit the access request",
				"2. Review the access request",
				"3. Grant access",
			);
			expect(
				violationsOf(
					checkVisualFacts(
						flowFacts("Onboarding", [
							{ label: "Grant access" },
							{ label: "Submit the access request" },
							{ label: "Review the access request" },
						]),
						section,
					),
				),
			).toEqual([noOrder]);
		});

		it("fails a flow with only one step among the numbered entries", () => {
			const section = sectionText(
				"Onboarding",
				"1. Submit the access request",
				"2. Pay the invoice",
				"",
				"- Grant access",
				"- Archive the ticket",
			);
			expect(
				violationsOf(
					checkVisualFacts(
						flowFacts("Onboarding", [
							{ label: "Submit the access request" },
							{ label: "Grant access" },
							{ label: "Archive the ticket" },
						]),
						section,
					),
				),
			).toEqual([noOrder]);
		});

		it("does not count a Start node as a named step", () => {
			const section = sectionText(
				"Market Context",
				"- Growing demand for self-service",
				"- Consolidation among vendors",
				"",
				"Price talks start next quarter.",
			);
			expect(
				violationsOf(
					checkVisualFacts(
						flowFacts("Market Context", [
							{ label: "Start" },
							{ label: "Growing demand for self-service" },
							{ label: "Consolidation among vendors" },
						]),
						section,
					),
				),
			).toEqual([noOrder]);
		});

		it.each([
			[
				"a sentence that names the steps",
				[
					"First we submit the request, then legal reviews it, and finally sales signs.",
				],
				["Submit request", "Legal reviews", "Sales signs"],
			],
			[
				"bullets that carry their own sequencing words",
				[
					"- Submit the request",
					"- Then review the request",
					"- Finally approve the request",
				],
				[
					"Submit the request",
					"Review the request",
					"Approve the request",
				],
			],
			[
				"a numbered list of the steps, one soft-wrapped",
				[
					"1. Submit the",
					"   access request",
					"2) Review the access request",
					"3. Grant access",
				],
				[
					"Submit the access request",
					"Review the access request",
					"Grant access",
				],
			],
			[
				"a numbered list with a step before and between its entries",
				["1. Submit the access request", "2. Grant access"],
				["Start", "Submit the access request", "Grant access"],
			],
		])("passes a flow from %s", (_label, body, labels) => {
			expect(
				checkVisualFacts(
					flowFacts(
						"Contract Signature",
						labels.map((label) => ({ label })),
					),
					sectionText("Contract Signature", ...body),
				),
			).toEqual({ pass: true });
		});
	});

	it("passes a flow from an ordered list", () => {
		const section = sectionText(
			"Onboarding",
			"1. Submit the access request",
			"2) Review the access request",
			"3. Grant access",
		);
		expect(
			checkVisualFacts(
				flowFacts("Onboarding", [
					{ label: "Submit the access request" },
					{ label: "Review the access request" },
					{ label: "Grant access" },
				]),
				section,
			),
		).toEqual({ pass: true });
	});

	it('passes a flow from "First … then … finally …"', () => {
		const section = sectionText(
			"Rollout",
			"First we migrate the pilot team, then we migrate the remaining teams, and finally we retire the legacy system.",
		);
		expect(
			checkVisualFacts(
				flowFacts("Rollout", [
					{ label: "Migrate the pilot team" },
					{ label: "Migrate the remaining teams" },
					{ label: "Retire the legacy system" },
				]),
				section,
			),
		).toEqual({ pass: true });
	});

	it("passes a swimlane flow from a real process section", () => {
		const section = sectionText(
			"Request Handling",
			"The account team submits the request. Then the finance team reviews the budget.",
			"Once the budget is approved, the delivery lead schedules the kickoff.",
		);
		expect(
			checkVisualFacts(
				flowFacts("Request Handling", [
					{ label: "Submits the request", lane: "Account team" },
					{ label: "Reviews the budget", lane: "Finance team" },
					{ label: "Schedules the kickoff", lane: "Delivery lead" },
				]),
				section,
			),
		).toEqual({ pass: true });
	});

	it("reads a heading that names a process as stating an order", () => {
		const section = sectionText(
			"Order process",
			"Sales qualifies the lead, Legal reviews the contract, and Sales signs the order.",
		);
		const steps = [
			{ label: "Qualifies the lead", lane: "Sales" },
			{ label: "Reviews the contract", lane: "Legal" },
			{ label: "Signs the order", lane: "Sales" },
		];
		expect(
			checkVisualFacts(flowFacts("Order process", steps), section),
		).toEqual({ pass: true });
		// Without the heading, nothing in the section states the order.
		expect(
			kindsOf(checkVisualFacts(flowFacts(null, steps), section)),
		).toEqual(["flow-sequence"]);
	});

	it("leaves other kinds alone", () => {
		const section = sectionText(
			"Open Questions",
			"Who approves the budget?",
		);
		expect(
			checkVisualFacts(
				{
					kind: "comparison",
					labels: ["Budget"],
					figures: [],
					heading: "Open Questions",
				},
				section,
			),
		).toEqual({ pass: true });
	});
});

describe("checkVisualFacts org charts (Fizzy #2589 follow-up)", () => {
	type Node = { id: string; label: string; parentId: string | null };

	/** The fact check's input for an org chart, as extraction builds it. */
	function orgChartFacts(nodes: Node[]) {
		const labelById = new Map(nodes.map((node) => [node.id, node.label]));
		return {
			...visualSpecFacts({ kind: "org_chart", nodes }),
			orgChartEdges: nodes.flatMap((node) => {
				const parent =
					node.parentId === null
						? undefined
						: labelById.get(node.parentId);
				return parent === undefined
					? []
					: [{ child: node.label, parent }];
			}),
		};
	}

	const twoNodes: Node[] = [
		{ id: "sponsor", label: "Sponsor", parentId: null },
		{ id: "lead", label: "Delivery lead", parentId: "sponsor" },
	];

	function reportingLines(result: FactGuardResult) {
		return violationsOf(result)
			.filter((item) => item.kind === "reporting-line")
			.map((item) => item.text);
	}

	it("fails an org chart built from a flat Role | Person table", () => {
		const section = sectionText(
			"Stakeholders",
			"| Role | Person |",
			"|---|---|",
			"| Sponsor | Person A |",
			"| Delivery Lead | Person B |",
			"| Product Owner | Person C |",
			"",
			"No formal governance structure is documented.",
		);
		const result = checkVisualFacts(
			orgChartFacts([
				{ id: "sponsor", label: "Sponsor", parentId: null },
				{ id: "lead", label: "Delivery Lead", parentId: "sponsor" },
				{ id: "po", label: "Product Owner", parentId: "sponsor" },
			]),
			section,
		);
		expect(kindsOf(result)).toEqual(["reporting-line", "reporting-line"]);
		expect(reportingLines(result)).toEqual([
			"Delivery Lead → Sponsor",
			"Product Owner → Sponsor",
		]);
	});

	it('passes a two-node chart from "The delivery lead reports to the sponsor."', () => {
		expect(
			checkVisualFacts(
				orgChartFacts(twoNodes),
				sectionText(
					"Governance",
					"The delivery lead reports to the sponsor.",
				),
			),
		).toEqual({ pass: true });
	});

	it("fails an eight-node chart where only one reporting line is stated", () => {
		const section = sectionText(
			"Team",
			"The delivery lead reports to the sponsor.",
			"The product owner, the architect, the QA lead, the analyst, the designer, and the engineer work on the project.",
		);
		const result = checkVisualFacts(
			orgChartFacts([
				...twoNodes,
				{ id: "po", label: "Product owner", parentId: "lead" },
				{ id: "arch", label: "Architect", parentId: "lead" },
				{ id: "qa", label: "QA lead", parentId: "lead" },
				{ id: "analyst", label: "Analyst", parentId: "po" },
				{ id: "designer", label: "Designer", parentId: "po" },
				{ id: "engineer", label: "Engineer", parentId: "arch" },
			]),
			section,
		);
		expect(new Set(kindsOf(result))).toEqual(new Set(["reporting-line"]));
		expect(reportingLines(result)).toEqual([
			"Product owner → Delivery lead",
			"Architect → Delivery lead",
			"QA lead → Delivery lead",
			"Analyst → Product owner",
			"Designer → Product owner",
			"Engineer → Architect",
		]);
	});

	it.each([
		[
			"an undefined reporting structure",
			"Reporting lines are not yet defined.",
		],
		[
			"a negated relation",
			"The delivery lead does not report to the sponsor.",
		],
		[
			"a relation left open",
			"The delivery lead reports to the sponsor (TBD).",
		],
		[
			"a relation to be confirmed",
			"The delivery lead reports to the sponsor, to be confirmed.",
		],
		[
			"a responsibility, not a hierarchy",
			"The sponsor manages the delivery lead.",
		],
		[
			"a position, not a reporting line",
			"The delivery lead works under the sponsor.",
		],
	])("supports no edge from %s", (_label, sentence) => {
		const section = sectionText(
			"Governance",
			"The sponsor and the delivery lead lead the project.",
			sentence,
		);
		expect(
			reportingLines(checkVisualFacts(orgChartFacts(twoNodes), section)),
		).toEqual(["Delivery lead → Sponsor"]);
	});

	it('does not read "The product owner manages the backlog." as a reporting line', () => {
		const section = sectionText(
			"Ownership",
			"The product owner manages the backlog.",
		);
		expect(
			reportingLines(
				checkVisualFacts(
					orgChartFacts([
						{ id: "po", label: "Product owner", parentId: null },
						{ id: "backlog", label: "Backlog", parentId: "po" },
					]),
					section,
				),
			),
		).toEqual(["Backlog → Product owner"]);
	});

	it("reads the edge's direction from the phrase", () => {
		const section = sectionText(
			"Governance",
			"The delivery lead reports to the sponsor.",
		);
		expect(
			reportingLines(
				checkVisualFacts(
					orgChartFacts([
						{ id: "lead", label: "Delivery lead", parentId: null },
						{ id: "sponsor", label: "Sponsor", parentId: "lead" },
					]),
					section,
				),
			),
		).toEqual(["Sponsor → Delivery lead"]);
	});

	it.each([
		"The delivery team is led by the delivery lead, who reports directly to the sponsor.",
		"Direct reports of the sponsor: the delivery lead. The delivery team is led by the delivery lead.",
		"The delivery team is led by the delivery lead. The delivery lead reports into the sponsor.",
		"The delivery team is led by the delivery lead. The delivery lead reports directly into the sponsor.",
		"The delivery team is led by the delivery lead. The delivery lead answers to the sponsor.",
	])("passes relations stated as %j", (sentence) => {
		expect(
			checkVisualFacts(
				orgChartFacts([
					...twoNodes,
					{ id: "team", label: "Delivery team", parentId: "lead" },
				]),
				sectionText("Governance", sentence),
			),
		).toEqual({ pass: true });
	});

	it("supports each row of a Reports to column", () => {
		const section = sectionText(
			"Governance",
			"| Role | Person | Reports to |",
			"|---|---|---|",
			"| Sponsor | Person A | — |",
			"| Delivery Lead | Person B | Sponsor |",
			"| Product Owner | Person C | **Delivery Lead** |",
			"| QA Lead | Person D | TBD |",
		);
		const nodes: Node[] = [
			{ id: "sponsor", label: "Sponsor (Person A)", parentId: null },
			{ id: "lead", label: "Delivery Lead", parentId: "sponsor" },
			{ id: "po", label: "Product Owner", parentId: "lead" },
		];
		expect(checkVisualFacts(orgChartFacts(nodes), section)).toEqual({
			pass: true,
		});
		expect(
			reportingLines(
				checkVisualFacts(
					orgChartFacts([
						...nodes,
						{ id: "qa", label: "QA Lead", parentId: "lead" },
						{
							id: "person",
							label: "Person C",
							parentId: "sponsor",
						},
					]),
					section,
				),
			),
		).toEqual(["QA Lead → Delivery Lead", "Person C → Sponsor (Person A)"]);
	});

	describe("reads each reporting line from its own clause", () => {
		/** A chart of `[child, parent]` edges, rooted at the first parent. */
		function chart(edges: ReadonlyArray<readonly [string, string]>) {
			const ids = new Map<string, string>();
			const id = (label: string) => {
				if (!ids.has(label)) {
					ids.set(label, `n${ids.size}`);
				}
				return ids.get(label) as string;
			};
			const parentOf = new Map(
				edges.map(([child, parent]) => [child, parent]),
			);
			const labels = new Set(edges.flat());
			return orgChartFacts(
				[...labels].map((label) => {
					const parent = parentOf.get(label);
					return {
						id: id(label),
						label,
						parentId: parent === undefined ? null : id(parent),
					};
				}),
			);
		}

		function unstated(
			sentence: string,
			edges: ReadonlyArray<readonly [string, string]>,
		) {
			return reportingLines(
				checkVisualFacts(
					chart(edges),
					sectionText("Governance", sentence),
				),
			);
		}

		it.each([
			[
				"two clauses joined by while",
				"The product manager reports to the CEO, while the analyst reports to the CFO.",
				[
					["Product manager", "CEO"],
					["Analyst", "CFO"],
				],
				[
					["Product manager", "CFO"],
					["CEO", "CFO"],
				],
			],
			[
				"two clauses joined by a semicolon",
				"The delivery lead reports to the sponsor; the product owner reports to the delivery lead.",
				[
					["Delivery lead", "Sponsor"],
					["Product owner", "Delivery lead"],
				],
				[
					["Sponsor", "Delivery lead"],
					["Delivery lead", "Product owner"],
				],
			],
			[
				"a relative clause that holds the next reporting line",
				"The analyst reports to the product owner, who reports to the delivery lead.",
				[
					["Analyst", "Product owner"],
					["Product owner", "Delivery lead"],
				],
				[["Analyst", "Delivery lead"]],
			],
			[
				"a second clause with a compound subject",
				"The PM reports to the sponsor, and the tech lead and QA lead report to the PM.",
				[
					["PM", "Sponsor"],
					["Tech lead", "PM"],
					["QA lead", "PM"],
				],
				[
					["Sponsor", "PM"],
					["PM", "Tech lead"],
				],
			],
			[
				"two clauses joined by and",
				"The analyst reports to the product owner and the designer reports to the delivery lead.",
				[
					["Analyst", "Product owner"],
					["Designer", "Delivery lead"],
				],
				[
					["Analyst", "Delivery lead"],
					["Product owner", "Delivery lead"],
				],
			],
			[
				"a shared subject",
				"The analyst is managed by the product owner and reports to the delivery lead.",
				[
					["Analyst", "Product owner"],
					["Analyst", "Delivery lead"],
				],
				[["Product owner", "Delivery lead"]],
			],
			[
				"a subject described between commas",
				"The delivery team, managed by the delivery lead, has a reporting line to the sponsor.",
				[
					["Delivery team", "Delivery lead"],
					["Delivery team", "Sponsor"],
				],
				[["Delivery lead", "Sponsor"]],
			],
			[
				"a subject described without commas",
				"The delivery team led by the delivery lead reports to the sponsor.",
				[
					["Delivery team", "Delivery lead"],
					["Delivery team", "Sponsor"],
				],
				[["Delivery lead", "Sponsor"]],
			],
			[
				"a relative clause that describes its antecedent, then a new clause",
				"The analyst reports to the product owner, who leads delivery and the designer reports to the delivery lead.",
				[
					["Analyst", "Product owner"],
					["Designer", "Delivery lead"],
				],
				[
					["Product owner", "Delivery lead"],
					["Analyst", "Delivery lead"],
				],
			],
			[
				"a leading subordinate clause",
				"While the analyst reports to the product owner, the designer reports to the delivery lead.",
				[
					["Analyst", "Product owner"],
					["Designer", "Delivery lead"],
				],
				[
					["Analyst", "Delivery lead"],
					["Product owner", "Delivery lead"],
				],
			],
			[
				"a subject described by two parents",
				"The delivery team, managed by the delivery lead and the architect, reports to the sponsor.",
				[
					["Delivery team", "Delivery lead"],
					["Delivery team", "Architect"],
					["Delivery team", "Sponsor"],
				],
				[["Architect", "Sponsor"]],
			],
			[
				"a clause that opens with its reporting phrase",
				"The delivery lead reports to the sponsor; reporting to the delivery lead are the analyst and the designer.",
				[
					["Delivery lead", "Sponsor"],
					["Analyst", "Delivery lead"],
					["Designer", "Delivery lead"],
				],
				[
					["Delivery lead", "Analyst"],
					["Analyst", "Sponsor"],
				],
			],
		] as const)(
			"supports only the stated edges of %s",
			(_label, sentence, stated, invented) => {
				for (const edge of stated) {
					expect(unstated(sentence, [edge])).toEqual([]);
				}
				for (const edge of invented) {
					expect(unstated(sentence, [edge])).toEqual([
						`${edge[0]} → ${edge[1]}`,
					]);
				}
			},
		);

		it("keeps a parent's description out of the next relation", () => {
			const sentence =
				"The designer owns design and reports to the delivery lead, who leads delivery.";
			expect(unstated(sentence, [["Designer", "Delivery lead"]])).toEqual(
				[],
			);
		});

		it("reads a list of subjects before one reporting phrase", () => {
			const sentence =
				"The product owner, the architect, and the QA lead report to the delivery lead.";
			expect(
				unstated(sentence, [
					["Product owner", "Delivery lead"],
					["Architect", "Delivery lead"],
					["QA lead", "Delivery lead"],
				]),
			).toEqual([]);
		});
	});

	describe("reads negation and open questions in the relation's own clause", () => {
		it.each([
			"The delivery lead reports to the sponsor; the board is not involved.",
			"The board is not involved, and the delivery lead reports to the sponsor.",
			"The delivery lead reports to the sponsor, while the board's role is TBD.",
		])("supports the edge stated by %j", (sentence) => {
			expect(
				checkVisualFacts(
					orgChartFacts(twoNodes),
					sectionText("Governance", sentence),
				),
			).toEqual({ pass: true });
		});

		it.each([
			"The delivery lead does not report to the sponsor.",
			// The negation sits in the relation's own clause, after its parent.
			"The delivery lead reports to the sponsor, not the board.",
			"The analyst reports to the product owner; the delivery lead does not report to the sponsor.",
			"The analyst reports to the delivery lead, who does not report to the sponsor.",
		])("supports no edge from %j", (sentence) => {
			expect(
				reportingLines(
					checkVisualFacts(
						orgChartFacts(twoNodes),
						sectionText("Governance", sentence),
					),
				),
			).toEqual(["Delivery lead → Sponsor"]);
		});
	});

	it.each([
		"The delivery lead writes a report to the sponsor.",
		"The delivery lead sends a weekly report to the sponsor.",
		"The delivery lead's answers to the sponsor are due in May.",
	])("does not read the noun in %j as a reporting line", (sentence) => {
		expect(
			reportingLines(
				checkVisualFacts(
					orgChartFacts(twoNodes),
					sectionText("Governance", sentence),
				),
			),
		).toEqual(["Delivery lead → Sponsor"]);
	});

	it.each(["Line manager", "Manager", "Reports into", "Answers to"])(
		"supports each row of a %j column",
		(column) => {
			const section = sectionText(
				"Governance",
				`| Role | ${column} |`,
				"|---|---|",
				"| Sponsor | — |",
				"| Delivery lead | Sponsor |",
			);
			expect(checkVisualFacts(orgChartFacts(twoNodes), section)).toEqual({
				pass: true,
			});
		},
	);

	it("supports a table row that states the relation in a cell", () => {
		const section = sectionText(
			"Governance",
			"| Role | Line |",
			"|---|---|",
			"| Delivery lead | Reports to the sponsor |",
		);
		expect(checkVisualFacts(orgChartFacts(twoNodes), section)).toEqual({
			pass: true,
		});
	});

	it("skips the edge check when a caller passes no edges", () => {
		expect(
			checkVisualFacts(
				{
					kind: "org_chart",
					labels: ["Sponsor", "Delivery lead"],
					figures: [],
				},
				sectionText("Stakeholders", "Sponsor. Delivery lead."),
			),
		).toEqual({ pass: true });
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

	it.each([
		[
			"many negated clauses",
			"Data migration is not in scope; ".repeat(20_000),
		],
		[
			"clauses that all share their content words, under the clause cap",
			"Data migration is not in scope for the platform team. ".repeat(
				390,
			),
		],
		["a long punctuation run", `It is not ${"!".repeat(20_000)}x`],
	])("stays fast on %s, which the clause check splits", (_label, hostile) => {
		const started = Date.now();
		checkRewrite({
			source: hostile,
			output: hostile,
			isKeySection: false,
			lengthMode: "standard",
		});
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	it.each([
		[
			"many reporting phrases in one statement",
			"The lead reports to ".repeat(20_000),
		],
		[
			"many short reporting statements",
			"The lead reports to the sponsor. ".repeat(20_000),
		],
		[
			"a long table with a Reports to column",
			`| Role | Reports to |\n|---|---|\n${"| Lead | Sponsor |\n".repeat(20_000)}`,
		],
		[
			"a long run of question marks and brackets",
			`${"?)".repeat(20_000)}x`,
		],
		["a long table-separator run", `| a |\n${"-|:".repeat(20_000)}x`],
		["a long run of numbered lines", "1. step\n".repeat(20_000)],
	])("checks flow and org chart structure fast on %s", (_label, hostile) => {
		const started = Date.now();
		checkVisualFacts(
			{
				kind: "org_chart",
				labels: [],
				figures: [],
				orgChartEdges: Array.from({ length: 15 }, (_, index) => ({
					child: `Lead ${index}`,
					parent: "Sponsor",
				})),
			},
			hostile,
		);
		checkVisualFacts(
			{
				kind: "flow",
				labels: [],
				figures: [],
				heading: hostile,
				flowSteps: [hostile, hostile],
			},
			hostile,
		);
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	/** Steps that each split into many parts, none named by the section. */
	const manyPartSteps = Array.from({ length: 20 }, (_, step) =>
		Array.from({ length: 80 }, (_, part) => `w${step}x${part}`).join(", "),
	);

	it.each([
		["one long line of sequencing words", "then step, ".repeat(40_000)],
		[
			"one long line of numbered-looking text",
			`1. ${"then step 2. ".repeat(30_000)}`,
		],
		["many sequenced bullets", "- then review\n".repeat(20_000)],
		["many numbered entries", "1. then review\n".repeat(20_000)],
		["many soft-wrapped entries", "1. then\n   review\n".repeat(10_000)],
	])("reads a flow's step order fast on %s", (_label, hostile) => {
		const started = Date.now();
		const result = checkVisualFacts(
			{
				kind: "flow",
				labels: [],
				figures: [],
				heading: "Market Context",
				flowSteps: manyPartSteps,
			},
			hostile,
		);
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(kindsOf(result)).toEqual(["flow-sequence"]);
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
