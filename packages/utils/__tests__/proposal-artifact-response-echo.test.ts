/**
 * The echo check of a Proposal's Main (Fizzy #2946): a text that repeats a
 * carried answer's or finding title's wording is flagged, a run the source
 * context or the previous Main already holds is not, and short factual
 * answers always pass. The same cases run against the worker's re-export in
 * `packages/temporal/src/lib/proposal-artifact/__tests__/settled-decisions.test.ts`.
 */

import { describe, expect, it } from "vitest";
import {
	buildEchoGuard,
	checkEcho,
	checkResponseEcho,
	echoedStableKeys,
	RESPONSE_ECHO_MIN_WORDS,
	TITLE_ECHO_MIN_WORDS,
} from "../lib/proposal-artifact/response-echo";

const SCOPE_ANSWER =
	"Data migration from the legacy CRM stays out of scope for both phases and is quoted separately once the export format is known";

describe("checkResponseEcho", () => {
	const MAIN_PREFIX =
		"## Scope\n\nThe engagement covers discovery, build and launch of the onboarding portal.";

	it("needs twelve words in a row", () => {
		expect(RESPONSE_ECHO_MIN_WORDS).toBe(12);
	});

	it("flags a Main that repeats an answer verbatim", () => {
		const result = checkResponseEcho({
			mainText: `${MAIN_PREFIX}\n\n${SCOPE_ANSWER}.`,
			carried: { responseTexts: [SCOPE_ANSWER], findingTitles: [] },
			sourceContext: ["Example Org needs an onboarding portal."],
			previousMain: "",
		});

		expect(result).toEqual({
			echoed: true,
			responseIndexes: [0],
			titleIndexes: [],
		});
	});

	it("sees through case, emphasis and punctuation", () => {
		const restyled =
			"**DATA MIGRATION** from the *legacy* CRM — stays out of scope, for both phases; and is quoted separately once the export format is known!";

		expect(
			checkResponseEcho({
				mainText: `${MAIN_PREFIX}\n\n${restyled}`,
				carried: { responseTexts: [SCOPE_ANSWER], findingTitles: [] },
			}).echoed,
		).toBe(true);
	});

	it("passes when the repeated run is in the source context", () => {
		expect(
			checkResponseEcho({
				mainText: `${MAIN_PREFIX}\n\n${SCOPE_ANSWER}.`,
				carried: { responseTexts: [SCOPE_ANSWER], findingTitles: [] },
				sourceContext: [
					"Unrelated source.",
					`Meeting notes: ${SCOPE_ANSWER}.`,
				],
			}).echoed,
		).toBe(false);
	});

	it("accepts the source context as one string too", () => {
		expect(
			checkResponseEcho({
				mainText: `${MAIN_PREFIX}\n\n${SCOPE_ANSWER}.`,
				carried: { responseTexts: [SCOPE_ANSWER], findingTitles: [] },
				sourceContext: `Meeting notes: ${SCOPE_ANSWER}.`,
			}).echoed,
		).toBe(false);
	});

	it("passes when the repeated run was already in the previous Main", () => {
		expect(
			checkResponseEcho({
				mainText: `${MAIN_PREFIX}\n\n${SCOPE_ANSWER}.`,
				carried: { responseTexts: [SCOPE_ANSWER], findingTitles: [] },
				sourceContext: [],
				previousMain: `# Old version\n\n${SCOPE_ANSWER}.`,
			}).echoed,
		).toBe(false);
	});

	it("still flags a run that only partly overlaps the source", () => {
		const firstTwelve = SCOPE_ANSWER.split(" ").slice(0, 12).join(" ");

		expect(
			checkResponseEcho({
				mainText: `${MAIN_PREFIX}\n\n${SCOPE_ANSWER}.`,
				carried: { responseTexts: [SCOPE_ANSWER], findingTitles: [] },
				sourceContext: [`Notes: ${firstTwelve}.`],
			}).echoed,
		).toBe(true);
	});

	it("does not join words across two source texts to excuse a run", () => {
		// Each text alone holds no twelve-word run of the answer's opening.
		const words = SCOPE_ANSWER.split(" ");
		expect(
			checkResponseEcho({
				mainText: `${MAIN_PREFIX}\n\n${SCOPE_ANSWER}.`,
				carried: { responseTexts: [SCOPE_ANSWER], findingTitles: [] },
				sourceContext: [
					words.slice(0, 6).join(" "),
					words.slice(6).join(" "),
				],
			}).echoed,
		).toBe(true);
	});

	it("draws the line at the threshold: eleven words pass, twelve do not", () => {
		const twelve =
			"one two three four five six seven eight nine ten eleven twelve";
		const eleven = twelve.split(" ").slice(0, 11).join(" ");

		expect(
			checkResponseEcho({
				mainText: `${MAIN_PREFIX} ${eleven} end.`,
				carried: { responseTexts: [eleven], findingTitles: [] },
			}).echoed,
		).toBe(false);
		expect(
			checkResponseEcho({
				mainText: `${MAIN_PREFIX} ${twelve} end.`,
				carried: { responseTexts: [twelve], findingTitles: [] },
			}).echoed,
		).toBe(true);
	});

	it("flags a long finding title repeated in Main", () => {
		const title =
			"The proposal does not explain how the support hours are counted after the first month of launch";

		expect(
			checkResponseEcho({
				mainText: `${MAIN_PREFIX}\n\n${title}.`,
				carried: {
					responseTexts: [],
					findingTitles: ["Short title", title],
				},
			}),
		).toEqual({ echoed: true, responseIndexes: [], titleIndexes: [1] });
	});

	describe("a finding title shorter than the threshold", () => {
		const TITLE = "Support hours after launch are unclear";
		const titled = (mainText: string, sourceContext: string[] = []) =>
			checkResponseEcho({
				mainText,
				carried: { responseTexts: [], findingTitles: ["Price", TITLE] },
				sourceContext,
				previousMain: null,
			});

		it("needs four words to count whole", () => {
			expect(TITLE_ECHO_MIN_WORDS).toBe(4);
		});

		it("flags a Main that holds the whole title", () => {
			expect(titled(`${MAIN_PREFIX}\n\n${TITLE}.`)).toEqual({
				echoed: true,
				responseIndexes: [],
				titleIndexes: [1],
			});
		});

		it("sees through case, whitespace, emphasis and punctuation", () => {
			for (const restyled of [
				"## SUPPORT HOURS AFTER LAUNCH ARE UNCLEAR",
				"**Support   hours** after\nlaunch — are *unclear*!",
				"Support-hours after launch are unclear.",
			]) {
				expect(titled(`${MAIN_PREFIX}\n\n${restyled}`).echoed).toBe(
					true,
				);
			}
		});

		it("flags a short Main that holds it", () => {
			expect(titled(`Note: ${TITLE}.`).echoed).toBe(true);
		});

		it("passes part of the title", () => {
			expect(
				titled(
					`${MAIN_PREFIX} Support hours after launch are listed below.`,
				).echoed,
			).toBe(false);
		});

		it("passes when the sources hold the title", () => {
			expect(
				titled(`${MAIN_PREFIX}\n\n${TITLE}.`, [
					`Call notes: ${TITLE.toLowerCase()}, the client said.`,
				]).echoed,
			).toBe(false);
		});

		it("passes when the previous Main held it", () => {
			expect(
				checkResponseEcho({
					mainText: `${MAIN_PREFIX}\n\n${TITLE}.`,
					carried: { responseTexts: [], findingTitles: [TITLE] },
					previousMain: `## Support\n\n${TITLE}.`,
				}).echoed,
			).toBe(false);
		});

		it("never flags a title of three words", () => {
			expect(
				checkResponseEcho({
					mainText: `${MAIN_PREFIX}\n\nThe price is missing here.`,
					carried: {
						responseTexts: [],
						findingTitles: [
							"Price is missing",
							"Price (USD) missing?",
						],
					},
				}).echoed,
			).toBe(false);
		});

		it("checks a recommendation by the long runs only, never whole", () => {
			const recommendation = "State when support hours are counted";
			const carried = {
				responseTexts: [],
				findingTitles: [TITLE, recommendation],
				recommendationIndexes: [1],
			};
			expect(
				checkResponseEcho({
					mainText: `${MAIN_PREFIX}\n\n${recommendation}.`,
					carried,
				}).echoed,
			).toBe(false);
			expect(
				checkResponseEcho({
					mainText: `${MAIN_PREFIX}\n\n${TITLE}.`,
					carried,
				}),
			).toEqual({ echoed: true, responseIndexes: [], titleIndexes: [0] });
		});

		it("keeps an answer of the same words to the answer threshold", () => {
			expect(
				checkResponseEcho({
					mainText: `${MAIN_PREFIX}\n\n${TITLE}.`,
					carried: { responseTexts: [TITLE], findingTitles: [] },
				}).echoed,
			).toBe(false);
		});
	});

	describe("an answer checked with shorter runs", () => {
		const PROMPT =
			"Write for the client only and never mention the internal review or its findings";
		const MAIN = `${MAIN_PREFIX}\n\nWe never mention the internal review or its findings here.`;

		it("flags a run of the length its caller gave", () => {
			expect(
				checkResponseEcho({
					mainText: MAIN,
					carried: {
						responseTexts: ["Other answer", PROMPT],
						findingTitles: [],
					},
					responseRunWords: (index) => (index === 1 ? 8 : 12),
				}),
			).toEqual({ echoed: true, responseIndexes: [1], titleIndexes: [] });
		});

		it("keeps the shared threshold without one", () => {
			expect(
				checkResponseEcho({
					mainText: MAIN,
					carried: { responseTexts: [PROMPT], findingTitles: [] },
				}).echoed,
			).toBe(false);
		});
	});

	describe("invisible characters", () => {
		// A zero-width space, a soft hyphen, a word joiner and a zero-width
		// joiner, each inside a word: drawn as nothing, read as nothing.
		const hide = (text: string) =>
			text
				.replace("migration", "migra\u200Btion")
				.replace("scope", "sco\u00ADpe")
				.replace("phases", "pha\u2060ses")
				.replace("separately", "separ\u200Dately")
				.replace("hours", "ho\u200Burs")
				.replace("launch", "laun\u00ADch");
		const TITLE = "Support hours after launch are unclear";

		it("do not hide a copied answer", () => {
			expect(
				checkResponseEcho({
					mainText: `${MAIN_PREFIX}\n\n${hide(SCOPE_ANSWER)}.`,
					carried: {
						responseTexts: [SCOPE_ANSWER],
						findingTitles: [],
					},
				}).echoed,
			).toBe(true);
		});

		it("do not hide a copied title", () => {
			expect(
				checkResponseEcho({
					mainText: `${MAIN_PREFIX}\n\n${hide(TITLE)}.`,
					carried: { responseTexts: [], findingTitles: [TITLE] },
				}).echoed,
			).toBe(true);
		});

		it("do not hide a run checked with shorter runs", () => {
			const prompt =
				"Write for the client only and never mention the internal review or its findings";
			expect(
				checkResponseEcho({
					mainText:
						"We never men\u200Btion the inter\u00ADnal review or its findings.",
					carried: { responseTexts: [prompt], findingTitles: [] },
					responseRunWords: () => 8,
				}).echoed,
			).toBe(true);
		});

		it("in the carried text or the source still match", () => {
			expect(
				checkResponseEcho({
					mainText: `${MAIN_PREFIX}\n\n${TITLE}.`,
					carried: {
						responseTexts: [],
						findingTitles: [hide(TITLE)],
					},
				}).echoed,
			).toBe(true);
			expect(
				checkResponseEcho({
					mainText: `${MAIN_PREFIX}\n\n${TITLE}.`,
					carried: { responseTexts: [], findingTitles: [TITLE] },
					sourceContext: [hide(TITLE)],
				}).echoed,
			).toBe(false);
		});
	});

	it("passes when nothing was carried", () => {
		expect(
			checkResponseEcho({
				mainText: `${MAIN_PREFIX}\n\n${SCOPE_ANSWER}.`,
				carried: { responseTexts: [], findingTitles: [] },
			}).echoed,
		).toBe(false);
	});

	/**
	 * Plain factual answers: what a member types when the review asks "what
	 * is the price?" or "how long is phase one?". Main must be free to state
	 * them, copied or not, with or without the source saying the same.
	 */
	const FACTUAL_ANSWERS = [
		"$48,000 fixed fee for both phases.",
		"The price is USD 12,500 per month, billed monthly.",
		"Twelve weeks from kickoff.",
		"Phase one takes 6 weeks; phase two takes 8 weeks.",
		"Go-live is 3 March 2027.",
		"Kickoff on 2026-11-02.",
		"Example Org",
		"Jordan Example is the sponsor.",
		"Yes.",
		"Payment is due within thirty days of each phase.",
	];

	it.each(FACTUAL_ANSWERS)(
		"lets the short factual answer %j through",
		(answer) => {
			const main = [
				"## Commercials",
				"",
				`${answer} ${answer}`,
				"",
				`The team confirmed: ${answer}`,
			].join("\n");
			for (const sourceContext of [[], [`Call notes: ${answer}`]]) {
				expect(
					checkResponseEcho({
						mainText: main,
						carried: {
							responseTexts: [answer],
							findingTitles: ["Price is missing"],
						},
						sourceContext,
						previousMain: null,
					}).echoed,
				).toBe(false);
			}
		},
	);
});

describe("buildEchoGuard and checkEcho", () => {
	const MAIN_PREFIX =
		"## Scope\n\nThe engagement covers discovery, build and launch of the onboarding portal.";
	const MAIN = `${MAIN_PREFIX}\n\n${SCOPE_ANSWER}.`;
	const ANSWER_ONLY = { responseTexts: [SCOPE_ANSWER], findingTitles: [] };
	const words = SCOPE_ANSWER.split(" ");
	const twelve =
		"one two three four five six seven eight nine ten eleven twelve";
	const eleven = twelve.split(" ").slice(0, 11).join(" ");
	const longTitle =
		"The proposal does not explain how the support hours are counted after the first month of launch";

	/** The inputs of the checkResponseEcho cases above. */
	const FIXTURES: Array<Parameters<typeof checkResponseEcho>[0]> = [
		{
			mainText: MAIN,
			carried: ANSWER_ONLY,
			sourceContext: ["Example Org needs an onboarding portal."],
			previousMain: "",
		},
		{
			mainText: `${MAIN_PREFIX}\n\n**DATA MIGRATION** from the *legacy* CRM — stays out of scope, for both phases; and is quoted separately once the export format is known!`,
			carried: ANSWER_ONLY,
		},
		{
			mainText: MAIN,
			carried: ANSWER_ONLY,
			sourceContext: [
				"Unrelated source.",
				`Meeting notes: ${SCOPE_ANSWER}.`,
			],
		},
		{
			mainText: MAIN,
			carried: ANSWER_ONLY,
			sourceContext: `Meeting notes: ${SCOPE_ANSWER}.`,
		},
		{
			mainText: MAIN,
			carried: ANSWER_ONLY,
			sourceContext: [],
			previousMain: `# Old version\n\n${SCOPE_ANSWER}.`,
		},
		{
			mainText: MAIN,
			carried: ANSWER_ONLY,
			sourceContext: [`Notes: ${words.slice(0, 12).join(" ")}.`],
		},
		{
			mainText: MAIN,
			carried: ANSWER_ONLY,
			sourceContext: [
				words.slice(0, 6).join(" "),
				words.slice(6).join(" "),
			],
		},
		{
			mainText: `${MAIN_PREFIX} ${eleven} end.`,
			carried: { responseTexts: [eleven], findingTitles: [] },
		},
		{
			mainText: `${MAIN_PREFIX} ${twelve} end.`,
			carried: { responseTexts: [twelve], findingTitles: [] },
		},
		{
			mainText: `${MAIN_PREFIX}\n\n${longTitle}.`,
			carried: {
				responseTexts: [],
				findingTitles: ["Short title", longTitle],
			},
		},
		{
			mainText: MAIN,
			carried: { responseTexts: [], findingTitles: [] },
		},
		{
			mainText: "Too short to hold a run.",
			carried: ANSWER_ONLY,
		},
		{
			mainText: `${MAIN_PREFIX}\n\n**Support hours** after launch are unclear.`,
			carried: {
				responseTexts: [],
				findingTitles: [
					"Price",
					"Support hours after launch are unclear",
				],
			},
		},
		{
			mainText: `${MAIN_PREFIX}\n\nSupport hours after launch are unclear.`,
			carried: {
				responseTexts: [],
				findingTitles: ["Support hours after launch are unclear"],
			},
			sourceContext: ["Support hours after launch are unclear."],
		},
		{
			mainText: MAIN,
			carried: ANSWER_ONLY,
			responseRunWords: () => 8,
		},
	];

	it.each(FIXTURES.map((input, index) => [index, input] as const))(
		"agrees with checkResponseEcho on fixture %i",
		(_index, input) => {
			const { mainText, ...fixed } = input;

			expect(checkEcho(buildEchoGuard(fixed), mainText)).toEqual(
				checkResponseEcho(input),
			);
		},
	);

	it("gives a reused guard's answers as a fresh check would, whatever came before", () => {
		const carried = {
			responseTexts: [SCOPE_ANSWER],
			findingTitles: ["Short title", longTitle],
		};
		const fixed = {
			carried,
			sourceContext: [`Meeting notes: ${longTitle}.`],
			previousMain: null,
		};
		const guard = buildEchoGuard(fixed);
		// The live previews of one run, then its Main: clean, allowed,
		// echoing, clean again, and both kinds at once.
		const mains = [
			MAIN_PREFIX,
			`${MAIN_PREFIX}\n\n${longTitle}.`,
			MAIN,
			`${MAIN_PREFIX}\n\nNothing settled is repeated here at all, not one run of twelve words.`,
			`${MAIN}\n\n${longTitle}.`,
		];

		const reused = mains.map((mainText) => checkEcho(guard, mainText));

		expect(reused).toEqual(
			mains.map((mainText) => checkResponseEcho({ ...fixed, mainText })),
		);
		expect(reused.map((result) => result.echoed)).toEqual([
			false,
			false,
			true,
			false,
			true,
		]);
		expect(guard.carried).toBe(carried);
	});

	it("does not see a change to the source array after it was built", () => {
		const sourceContext = ["Unrelated source."];
		const guard = buildEchoGuard({
			carried: ANSWER_ONLY,
			sourceContext,
		});
		sourceContext.push(`Meeting notes: ${SCOPE_ANSWER}.`);

		expect(checkEcho(guard, MAIN).echoed).toBe(true);
	});
});

describe("echoedStableKeys (Fizzy #2946)", () => {
	const carried = {
		responseTexts: ["first answer", "second answer"],
		findingTitles: ["First title", "Second title", "Third title"],
		responseKeys: ["k1:a", "k1:c"],
		titleKeys: ["k1:a", "k1:b", "k1:c"],
	};

	it("maps echoed answer and title indexes to their keys, once each", () => {
		expect(
			echoedStableKeys(carried, {
				responseIndexes: [1],
				titleIndexes: [0, 2],
			}),
		).toEqual(["k1:c", "k1:a"]);
	});

	it("returns no key for carried text that came without keys", () => {
		expect(
			echoedStableKeys(
				{ responseTexts: ["answer"], findingTitles: ["Title"] },
				{ responseIndexes: [0], titleIndexes: [0] },
			),
		).toEqual([]);
	});
});
