/**
 * Evidence-fidelity eval cases for documents generated with external web
 * research.
 *
 * Each case pins one scenario from the evidence standard:
 *
 * 1. the prompt text the module produces for the scenario carries the rule the
 *    scenario depends on (this exercises the real builders);
 * 2. the expected properties of a finished document are mechanically
 *    checkable: a compliant document passes every property, and each violating
 *    document fails exactly the property it targets.
 *
 * The documents are hand-written fixtures, not model output. These cases prove
 * the rules are emitted and the properties are detectable; they do not prove
 * how a model behaves. To judge a real generated document, run it through
 * `checkDocument` with the scenario's properties. The checker matches figures
 * and labels literally, so a reworded figure ("61 percent") is not caught, it
 * cannot tell whether a named gap is the right one, and a notice that claims
 * success in words it does not list still passes; those need human review.
 */

import { describe, expect, it } from "vitest";
import {
	buildResearchNoticeGuidance,
	buildWebResearchEvidenceGuidance,
	formatWebResearchOutcome,
	normalizeResearchSourceUrl,
	RESEARCH_INCOMPLETE_LABEL,
	RESEARCH_NOT_AUTHORIZED_LABEL,
	type WebResearchOutcome,
} from "../prompts/web-research-evidence";

type NoticeKind = "none" | "incomplete" | "not-authorized";

interface DocumentProperties {
	/** Which notice the document must open with, if any. */
	notice: NoticeKind;
	/** The only external URLs the document may link to. */
	allowedUrls: string[];
	/** Every sentence holding `figure` must carry a link to `url`. */
	citations?: Array<{ figure: string; url: string }>;
	/** Text that must not appear: unverified figures, unread URLs. */
	forbiddenText?: string[];
	/** Every sentence holding `figure` must also hold every qualifier. */
	qualifiedClaims?: Array<{ figure: string; qualifiers: string[] }>;
	/** Every sentence holding `figure` must attribute it to `vendor`. */
	vendorClaims?: Array<{ figure: string; vendor: string }>;
}

const PROPERTY_NAMES = [
	"notice",
	"urls",
	"citations",
	"forbiddenText",
	"qualifiers",
	"vendorAttribution",
] as const;

type PropertyName = (typeof PROPERTY_NAMES)[number];

/** Where a piece of prompt text travels to the model. */
type PromptPart = "evidence" | "notice" | "facts";

interface EvidenceCase {
	name: string;
	/** What the document's instructions or the user ask for, as a reviewer would read them. */
	instructions: string;
	allowWebResearch: boolean;
	outcome?: WebResearchOutcome;
	/** Rules the module must emit for this scenario. */
	expectedRules: Array<{ in: PromptPart; pattern: RegExp | string }>;
	properties: DocumentProperties;
	compliant: string;
	violations: Array<{ property: PropertyName; document: string }>;
}

const NOTICE_LABELS: Record<Exclude<NoticeKind, "none">, string> = {
	incomplete: RESEARCH_INCOMPLETE_LABEL,
	"not-authorized": RESEARCH_NOT_AUTHORIZED_LABEL,
};

const URL_IN_TEXT = /https?:\/\/[^\s)>\]"'`]+/g;

/** Sentence punctuation that ends a bare URL rather than belonging to it. */
const TRAILING_PUNCTUATION = /[.,;:!?]+$/;

function normalizedUrls(urls: string[]): Set<string> {
	return new Set(
		urls
			.map((url) => normalizeResearchSourceUrl(url))
			.filter((url): url is string => url !== null),
	);
}

/** Every URL the text links to, as written (sentence punctuation removed). */
function linkedUrls(text: string): string[] {
	return (text.match(URL_IN_TEXT) ?? []).map((url) =>
		url.replace(TRAILING_PUNCTUATION, ""),
	);
}

function citedUrls(text: string): Set<string> {
	return normalizedUrls(linkedUrls(text));
}

/**
 * The notice the document opens with (first block after the H1 title) and the
 * text of that blockquote.
 */
function openingNotice(document: string): { kind: NoticeKind; text: string } {
	const lines = document.split("\n");
	let index = 0;
	const skipBlank = () => {
		while (index < lines.length && lines[index].trim() === "") {
			index++;
		}
	};
	skipBlank();
	if (lines[index]?.startsWith("# ")) {
		index++;
	}
	skipBlank();
	const quoted: string[] = [];
	while (index < lines.length && lines[index].startsWith(">")) {
		quoted.push(lines[index].replace(/^>\s?/, ""));
		index++;
	}
	const text = quoted.join(" ");
	for (const [kind, label] of Object.entries(NOTICE_LABELS)) {
		if (text.startsWith(`**${label}.**`)) {
			return { kind: kind as NoticeKind, text };
		}
	}
	return { kind: "none", text };
}

/**
 * An incomplete-research notice names at least one real gap, or, when only an
 * incidental lead failed, says the request is still covered.
 */
const NAMES_A_GAP = /Evidence gaps:\s*(?!(?:none|n\/a|nothing|complete)\b)\S/i;
const STATES_REQUEST_COVERED =
	/\bstill covers? everything the instructions asked for\b/i;

/** A not-authorized notice must say the research was not done. */
const STATES_NOT_DONE =
	/\b(?:was not done|not fulfilled|internal project context only)\b/i;

/** Wording that claims the research succeeded, which no notice may contain. */
const CLAIMS_RESEARCH_SUCCEEDED =
	/\b(?:completed|carried out|performed|conducted)\b[^.]*\bresearch\b|\bresearch\b[^.]*\b(?:was|were) (?:completed|done|verified|successful)\b|\beverything (?:was|is) verified\b/i;

/**
 * Whether the notice says what its kind requires. Literal wording only: a
 * notice that means the opposite in other words still passes.
 */
function noticeSaysEnough(kind: NoticeKind, text: string): boolean {
	if (CLAIMS_RESEARCH_SUCCEEDED.test(text)) {
		return false;
	}
	if (kind === "incomplete") {
		return NAMES_A_GAP.test(text) || STATES_REQUEST_COVERED.test(text);
	}
	if (kind === "not-authorized") {
		return STATES_NOT_DONE.test(text);
	}
	return true;
}

function mentionsAnyNoticeLabel(document: string): boolean {
	return Object.values(NOTICE_LABELS).some((label) =>
		document.includes(label),
	);
}

/** Sentences of the document, one claim each in these fixtures. */
function sentences(document: string): string[] {
	return document
		.split("\n")
		.flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z])/))
		.map((sentence) => sentence.trim())
		.filter(Boolean);
}

/**
 * Every sentence holding `figure`: `stated` is the sentence without its URLs
 * (a year or a word inside a link target is not part of what it states), `raw`
 * keeps them for the citation check.
 */
function sentencesWith(
	document: string,
	figure: string,
): Array<{ stated: string; raw: string }> {
	return sentences(document)
		.map((raw) => ({ raw, stated: raw.replace(URL_IN_TEXT, "") }))
		.filter(({ stated }) => stated.includes(figure));
}

function everySentenceWith(
	document: string,
	figure: string,
	holds: (sentence: { stated: string; raw: string }) => boolean,
): boolean {
	const found = sentencesWith(document, figure);
	return found.length > 0 && found.every(holds);
}

/** Per-property verdict for a generated document. */
function checkDocument(
	document: string,
	properties: DocumentProperties,
): Record<PropertyName, boolean> {
	const notice = openingNotice(document);
	const allowed = normalizedUrls(properties.allowedUrls);

	return {
		notice:
			properties.notice === "none"
				? notice.kind === "none" && !mentionsAnyNoticeLabel(document)
				: notice.kind === properties.notice &&
					noticeSaysEnough(notice.kind, notice.text),
		// A link the normalizer rejects (a signed or tokenized URL) fails too.
		urls: linkedUrls(document).every((url) => {
			const normalized = normalizeResearchSourceUrl(url);
			return normalized !== null && allowed.has(normalized);
		}),
		citations: (properties.citations ?? []).every(({ figure, url }) => {
			const expected = normalizeResearchSourceUrl(url);
			return everySentenceWith(
				document,
				figure,
				({ raw }) => expected !== null && citedUrls(raw).has(expected),
			);
		}),
		forbiddenText: (properties.forbiddenText ?? []).every(
			(text) => !document.includes(text),
		),
		qualifiers: (properties.qualifiedClaims ?? []).every(
			({ figure, qualifiers }) =>
				everySentenceWith(document, figure, ({ stated }) =>
					qualifiers.every((qualifier) => stated.includes(qualifier)),
				),
		),
		vendorAttribution: (properties.vendorClaims ?? []).every(
			({ figure, vendor }) =>
				everySentenceWith(
					document,
					figure,
					({ stated }) =>
						stated
							.toLowerCase()
							.includes(`according to ${vendor.toLowerCase()}`) ||
						stated.includes(`${vendor} reports`),
				),
		),
	};
}

function outcome(overrides: Partial<WebResearchOutcome>): WebResearchOutcome {
	return {
		authorized: true,
		searches: 0,
		searchFailures: 0,
		reads: 0,
		readFailures: 0,
		limitReached: false,
		sources: [],
		...overrides,
	};
}

/** A fixture document: Markdown blocks separated by blank lines. */
function doc(...blocks: string[]): string {
	return blocks.join("\n\n");
}

function notice(label: string, text: string): string {
	return `> **${label}.** ${text}`;
}

const SURVEY_URL = "https://research.example.com/warehouse-survey-2024";
const UNATTRIBUTED_URL = "https://stats.example.org/benchmarks";
const RETAIL_URL = "https://retail.example.org/adoption-2023";
const VENDOR_URL = "https://vendor.example.com/customers/northwind";
const UNREAD_URL = "https://blog.example.net/picking-tips";
const SIGNED_URL =
	"https://files.example.com/benchmark.pdf?X-Amz-Signature=example-signature";
const PILOT_REPORT_URL = "https://wiki.example.com/pilot-report";

const PICKING_CASE = "# Warehouse Picking Business Case";
const SCANNER_CASE = "# Scanner Rollout Business Case";
const MARKET_EVIDENCE = "## Market Evidence";

const SURVEY_CLAIM = `According to the Example Research Institute, 38% of surveyed distributors reported picking errors above 2% in 2024 ([2024 survey](${SURVEY_URL})).`;

const RETAIL_CLAIM = `According to the Example Retail Association, 27% of mid-sized retailers in Germany used handheld scanners in 2023 ([adoption report](${RETAIL_URL})).`;

const VENDOR_CLAIM = `According to Example Vendor, one of its distribution customers cut picking errors by 30% after a scanner rollout ([case study](${VENDOR_URL})).`;

const INTERNAL_SECTION = `## Current State

The team reported 14 picking errors per week during the pilot.`;

const NOT_AUTHORIZED_NOTICE = notice(
	RESEARCH_NOT_AUTHORIZED_LABEL,
	"External research was not authorized for this generation, so the requested research was not done. This draft uses internal project context only.",
);

const cases: EvidenceCase[] = [
	{
		name: "one sufficient source",
		instructions:
			"Business case: support the error-reduction argument with a published benchmark.",
		allowWebResearch: true,
		outcome: outcome({
			searches: 1,
			reads: 1,
			sources: [
				{ url: SURVEY_URL, publisher: "Example Research Institute" },
			],
		}),
		expectedRules: [
			{ in: "evidence", pattern: /one such source is enough/i },
			{ in: "evidence", pattern: /link[^.]*right next to the claim/i },
			{ in: "facts", pattern: SURVEY_URL },
			{
				in: "notice",
				pattern:
					/links already present in the provided project context/i,
			},
		],
		properties: {
			notice: "none",
			allowedUrls: [SURVEY_URL, PILOT_REPORT_URL],
			citations: [{ figure: "38%", url: SURVEY_URL }],
		},
		compliant: doc(
			PICKING_CASE,
			MARKET_EVIDENCE,
			SURVEY_CLAIM,
			INTERNAL_SECTION,
			`Details are in the [pilot report](${PILOT_REPORT_URL}).`,
		),
		violations: [
			{
				property: "urls",
				document: doc(
					PICKING_CASE,
					MARKET_EVIDENCE,
					`${SURVEY_CLAIM} Further tips are collected in [a blog post](${UNREAD_URL}).`,
					INTERNAL_SECTION,
				),
			},
			{
				property: "citations",
				document: doc(
					PICKING_CASE,
					MARKET_EVIDENCE,
					"According to the Example Research Institute, 38% of surveyed distributors reported picking errors above 2% in 2024.",
					INTERNAL_SECTION,
				),
			},
			{
				// The link is present, but in another sentence than the claim.
				property: "citations",
				document: doc(
					PICKING_CASE,
					MARKET_EVIDENCE,
					"According to the Example Research Institute, 38% of surveyed distributors reported picking errors above 2% in 2024.",
					INTERNAL_SECTION,
					`Sources: [2024 survey](${SURVEY_URL}).`,
				),
			},
		],
	},
	{
		name: "no publisher or authority: the finding is excluded",
		instructions:
			"Business case: include industry benchmarks for picking accuracy.",
		allowWebResearch: true,
		outcome: outcome({
			searches: 1,
			reads: 2,
			sources: [
				{ url: UNATTRIBUTED_URL },
				{ url: SURVEY_URL, publisher: "Example Research Institute" },
			],
		}),
		expectedRules: [
			{ in: "evidence", pattern: /could not attribute/i },
			{
				in: "facts",
				pattern: `${UNATTRIBUTED_URL} (publisher not identified)`,
			},
			{ in: "facts", pattern: /or do not use that source/i },
		],
		properties: {
			notice: "none",
			allowedUrls: [SURVEY_URL],
			forbiddenText: ["61%"],
		},
		compliant: doc(
			PICKING_CASE,
			MARKET_EVIDENCE,
			SURVEY_CLAIM,
			INTERNAL_SECTION,
		),
		violations: [
			{
				property: "forbiddenText",
				document: doc(
					PICKING_CASE,
					MARKET_EVIDENCE,
					"Industry data shows 61% of warehouses still pick from paper lists.",
					INTERNAL_SECTION,
				),
			},
			{
				property: "urls",
				document: doc(
					PICKING_CASE,
					MARKET_EVIDENCE,
					`Most warehouses still pick from paper lists ([benchmarks](${UNATTRIBUTED_URL})).`,
					INTERNAL_SECTION,
				),
			},
		],
	},
	{
		name: "the only page read has no publisher: a limited draft",
		instructions:
			"Business case: include industry benchmarks for picking accuracy.",
		allowWebResearch: true,
		outcome: outcome({
			searches: 1,
			reads: 1,
			sources: [{ url: UNATTRIBUTED_URL }],
		}),
		expectedRules: [
			{
				in: "facts",
				pattern: `${UNATTRIBUTED_URL} (publisher not identified)`,
			},
			{
				in: "notice",
				pattern:
					/no external claim in the document rests on a page that meets the evidence standard/i,
			},
		],
		properties: {
			notice: "incomplete",
			allowedUrls: [],
			forbiddenText: ["61%"],
		},
		compliant: doc(
			PICKING_CASE,
			notice(
				RESEARCH_INCOMPLETE_LABEL,
				"The only benchmark page read did not name its publisher, so it could not be used. Evidence gaps: no verified benchmark for picking accuracy.",
			),
			INTERNAL_SECTION,
		),
		violations: [
			{
				property: "notice",
				document: doc(PICKING_CASE, INTERNAL_SECTION),
			},
			{
				property: "forbiddenText",
				document: doc(
					PICKING_CASE,
					notice(
						RESEARCH_INCOMPLETE_LABEL,
						"The only benchmark page read did not name its publisher. Evidence gaps: picking accuracy.",
					),
					"Industry data shows 61% of warehouses still pick from paper lists.",
					INTERNAL_SECTION,
				),
			},
		],
	},
	{
		name: "a date- and population-bound claim keeps its limits",
		instructions:
			"Business case: cite adoption data for handheld scanners in retail.",
		allowWebResearch: true,
		outcome: outcome({
			searches: 1,
			reads: 1,
			sources: [
				{ url: RETAIL_URL, publisher: "Example Retail Association" },
			],
		}),
		expectedRules: [
			{ in: "evidence", pattern: /never widen/i },
			{ in: "evidence", pattern: /population/i },
		],
		properties: {
			notice: "none",
			allowedUrls: [RETAIL_URL],
			qualifiedClaims: [
				{
					figure: "27%",
					qualifiers: ["2023", "mid-sized retailers", "Germany"],
				},
			],
		},
		compliant: doc(
			SCANNER_CASE,
			MARKET_EVIDENCE,
			RETAIL_CLAIM,
			INTERNAL_SECTION,
		),
		violations: [
			{
				property: "qualifiers",
				document: doc(
					SCANNER_CASE,
					MARKET_EVIDENCE,
					`According to the Example Retail Association, 27% of retailers use handheld scanners ([adoption report](${RETAIL_URL})).`,
					INTERNAL_SECTION,
				),
			},
			{
				// The year survives only inside the link target.
				property: "qualifiers",
				document: doc(
					SCANNER_CASE,
					MARKET_EVIDENCE,
					`According to the Example Retail Association, 27% of mid-sized retailers in Germany use handheld scanners ([adoption report](${RETAIL_URL})).`,
					INTERNAL_SECTION,
				),
			},
			{
				// Stated correctly once, then widened in a later restatement.
				property: "qualifiers",
				document: doc(
					SCANNER_CASE,
					MARKET_EVIDENCE,
					RETAIL_CLAIM,
					"## Recommendation",
					"With 27% of retailers already scanning, the rollout is low risk.",
					INTERNAL_SECTION,
				),
			},
		],
	},
	{
		name: "partial success: only verified findings are used",
		instructions:
			"Business case: back the savings estimate with two published benchmarks.",
		allowWebResearch: true,
		outcome: outcome({
			searches: 2,
			reads: 2,
			readFailures: 1,
			sources: [
				{ url: SURVEY_URL, publisher: "Example Research Institute" },
			],
		}),
		expectedRules: [
			{ in: "facts", pattern: "Incomplete: 1 page read failed." },
			{ in: "notice", pattern: /search or a page read failed/i },
			{ in: "notice", pattern: /keep only verified external claims/i },
		],
		properties: {
			notice: "incomplete",
			allowedUrls: [SURVEY_URL],
			citations: [{ figure: "38%", url: SURVEY_URL }],
			forbiddenText: ["54%"],
		},
		compliant: doc(
			PICKING_CASE,
			notice(
				RESEARCH_INCOMPLETE_LABEL,
				"One of the two benchmark pages could not be read. Evidence gaps: no verified benchmark for the labor savings of scanner-based picking.",
			),
			MARKET_EVIDENCE,
			SURVEY_CLAIM,
			INTERNAL_SECTION,
		),
		violations: [
			{
				property: "notice",
				document: doc(
					PICKING_CASE,
					MARKET_EVIDENCE,
					SURVEY_CLAIM,
					INTERNAL_SECTION,
				),
			},
			{
				property: "forbiddenText",
				document: doc(
					PICKING_CASE,
					notice(
						RESEARCH_INCOMPLETE_LABEL,
						"One of the two benchmark pages could not be read. Evidence gaps: labor savings.",
					),
					MARKET_EVIDENCE,
					`${SURVEY_CLAIM} Scanner picking saves 54% of labor time.`,
					INTERNAL_SECTION,
				),
			},
		],
	},
	{
		name: "a side lead failed but the request is covered: no invented gap",
		instructions:
			"Business case: support the error-reduction argument with a published benchmark.",
		allowWebResearch: true,
		outcome: outcome({
			searches: 1,
			reads: 2,
			readFailures: 1,
			sources: [
				{ url: SURVEY_URL, publisher: "Example Research Institute" },
			],
		}),
		expectedRules: [
			{ in: "facts", pattern: "Incomplete: 1 page read failed." },
			{ in: "notice", pattern: /never invent a gap/i },
		],
		properties: {
			notice: "incomplete",
			allowedUrls: [SURVEY_URL],
			citations: [{ figure: "38%", url: SURVEY_URL }],
		},
		compliant: doc(
			PICKING_CASE,
			notice(
				RESEARCH_INCOMPLETE_LABEL,
				"One of the two pages could not be read. The verified survey still covers everything the instructions asked for.",
			),
			MARKET_EVIDENCE,
			SURVEY_CLAIM,
			INTERNAL_SECTION,
		),
		violations: [
			{
				property: "notice",
				document: doc(
					PICKING_CASE,
					MARKET_EVIDENCE,
					SURVEY_CLAIM,
					INTERNAL_SECTION,
				),
			},
			{
				// Neither a real gap nor a statement that the request is covered.
				property: "notice",
				document: doc(
					PICKING_CASE,
					notice(
						RESEARCH_INCOMPLETE_LABEL,
						"One of the two pages could not be read. Evidence gaps: none.",
					),
					MARKET_EVIDENCE,
					SURVEY_CLAIM,
					INTERNAL_SECTION,
				),
			},
		],
	},
	{
		name: "every search and read failed: a limited draft",
		instructions:
			"Business case: support the ROI argument with external market data.",
		allowWebResearch: true,
		outcome: outcome({
			searches: 2,
			searchFailures: 1,
			reads: 2,
			readFailures: 2,
		}),
		expectedRules: [
			{
				in: "facts",
				pattern: "Incomplete: 1 search failed; 2 page reads failed.",
			},
			{ in: "facts", pattern: "Pages read successfully: none so far." },
			{
				in: "notice",
				pattern:
					/no external claim in the document rests on a page that meets the evidence standard/i,
			},
			{
				in: "notice",
				pattern:
					/never state or imply that the research requirement was met/i,
			},
		],
		properties: {
			notice: "incomplete",
			allowedUrls: [],
			forbiddenText: ["45%"],
		},
		compliant: doc(
			PICKING_CASE,
			notice(
				RESEARCH_INCOMPLETE_LABEL,
				"External research did not succeed: one search and both page reads failed. Evidence gaps: no verified market data supports the ROI estimate.",
			),
			INTERNAL_SECTION,
		),
		violations: [
			{
				property: "notice",
				document: doc(PICKING_CASE, INTERNAL_SECTION),
			},
			{
				property: "forbiddenText",
				document: doc(
					PICKING_CASE,
					notice(
						RESEARCH_INCOMPLETE_LABEL,
						"External research did not succeed. Evidence gaps: market data.",
					),
					"Industry reports suggest 45% of distributors plan scanner rollouts.",
					INTERNAL_SECTION,
				),
			},
			{
				property: "urls",
				document: doc(
					PICKING_CASE,
					notice(
						RESEARCH_INCOMPLETE_LABEL,
						"External research did not succeed. Evidence gaps: market data.",
					),
					`See ${UNREAD_URL}.`,
					INTERNAL_SECTION,
				),
			},
			{
				// The label is there, but the notice claims nothing is missing.
				property: "notice",
				document: doc(
					PICKING_CASE,
					notice(
						RESEARCH_INCOMPLETE_LABEL,
						"External research did not succeed. Evidence gaps: none.",
					),
					INTERNAL_SECTION,
				),
			},
			{
				// The label is there, but the notice claims the opposite outcome.
				property: "notice",
				document: doc(
					PICKING_CASE,
					notice(
						RESEARCH_INCOMPLETE_LABEL,
						"Everything was verified. Evidence gaps: complete.",
					),
					INTERNAL_SECTION,
				),
			},
			{
				// A real gap is named, yet the notice claims the research succeeded.
				property: "notice",
				document: doc(
					PICKING_CASE,
					notice(
						RESEARCH_INCOMPLETE_LABEL,
						"The research was completed. Evidence gaps: market data.",
					),
					INTERNAL_SECTION,
				),
			},
		],
	},
	{
		name: "the only page read sits behind a signed URL: withheld",
		instructions:
			"Business case: support the error-reduction argument with a published benchmark.",
		allowWebResearch: true,
		outcome: outcome({
			searches: 1,
			reads: 1,
			sources: [
				{ url: SIGNED_URL, publisher: "Example Research Institute" },
			],
		}),
		expectedRules: [
			{ in: "facts", pattern: "Pages read successfully: none so far." },
			{
				in: "facts",
				pattern: "Withheld from citation: 1 page read successfully",
			},
		],
		properties: {
			notice: "incomplete",
			allowedUrls: [],
		},
		compliant: doc(
			PICKING_CASE,
			notice(
				RESEARCH_INCOMPLETE_LABEL,
				"The benchmark page that was read cannot be cited from a public link. Evidence gaps: no citable benchmark for picking errors.",
			),
			INTERNAL_SECTION,
		),
		violations: [
			{
				property: "urls",
				document: doc(
					PICKING_CASE,
					notice(
						RESEARCH_INCOMPLETE_LABEL,
						"The benchmark could not be verified. Evidence gaps: picking-error benchmark.",
					),
					`A benchmark is available as a [report](${SIGNED_URL}).`,
					INTERNAL_SECTION,
				),
			},
		],
	},
	{
		name: "research required but not authorized",
		instructions:
			"Business case: research and cite external benchmarks for the ROI argument.",
		allowWebResearch: false,
		expectedRules: [
			{ in: "notice", pattern: `**${RESEARCH_NOT_AUTHORIZED_LABEL}.**` },
			{ in: "notice", pattern: /requirement was not fulfilled/i },
			{ in: "notice", pattern: /do not imply that research happened/i },
		],
		properties: {
			notice: "not-authorized",
			allowedUrls: [],
		},
		compliant: doc(PICKING_CASE, NOT_AUTHORIZED_NOTICE, INTERNAL_SECTION),
		violations: [
			{
				property: "notice",
				document: doc(PICKING_CASE, INTERNAL_SECTION),
			},
			{
				property: "urls",
				document: doc(
					PICKING_CASE,
					NOT_AUTHORIZED_NOTICE,
					`Benchmarks are summarized in [this survey](${SURVEY_URL}).`,
					INTERNAL_SECTION,
				),
			},
			{
				// The label is there, but the notice claims research happened.
				property: "notice",
				document: doc(
					PICKING_CASE,
					notice(
						RESEARCH_NOT_AUTHORIZED_LABEL,
						"We completed the requested research; this draft also uses internal project context only.",
					),
					INTERNAL_SECTION,
				),
			},
			{
				// The label alone, without saying the research was not done.
				property: "notice",
				document: doc(
					PICKING_CASE,
					notice(
						RESEARCH_NOT_AUTHORIZED_LABEL,
						"See the sections below.",
					),
					INTERNAL_SECTION,
				),
			},
		],
	},
	{
		name: "research asked only in the user's message, not authorized",
		instructions:
			"Project brief with no research in its template; the user's message asks to add published benchmarks.",
		allowWebResearch: false,
		expectedRules: [
			{
				in: "notice",
				pattern: /or the user's message ask for external research/i,
			},
			{ in: "notice", pattern: /if there is a research request/i },
		],
		properties: {
			notice: "not-authorized",
			allowedUrls: [],
		},
		compliant: doc(
			"# Pilot Summary",
			NOT_AUTHORIZED_NOTICE,
			INTERNAL_SECTION,
		),
		violations: [
			{
				property: "notice",
				document: doc("# Pilot Summary", INTERNAL_SECTION),
			},
		],
	},
	{
		name: "a third-party vendor case study stays the vendor's claim",
		instructions:
			"Proposal: include comparable customer results for scanner rollouts.",
		allowWebResearch: true,
		outcome: outcome({
			searches: 1,
			reads: 1,
			sources: [{ url: VENDOR_URL, publisher: "Example Vendor" }],
		}),
		expectedRules: [
			{ in: "evidence", pattern: '"according to <vendor>"' },
			{ in: "evidence", pattern: /never as a fact about this project/i },
		],
		properties: {
			notice: "none",
			allowedUrls: [VENDOR_URL],
			vendorClaims: [{ figure: "30%", vendor: "Example Vendor" }],
		},
		compliant: doc(
			"# Scanner Rollout Proposal",
			"## Comparable Results",
			VENDOR_CLAIM,
			INTERNAL_SECTION,
		),
		violations: [
			{
				property: "vendorAttribution",
				document: doc(
					"# Scanner Rollout Proposal",
					"## Comparable Results",
					`This rollout will cut picking errors by 30% ([case study](${VENDOR_URL})).`,
					INTERNAL_SECTION,
				),
			},
			{
				// Attributed once, then restated as a fact about this project.
				property: "vendorAttribution",
				document: doc(
					"# Scanner Rollout Proposal",
					"## Comparable Results",
					VENDOR_CLAIM,
					"## Expected Outcome",
					"The rollout will cut picking errors by 30%.",
					INTERNAL_SECTION,
				),
			},
		],
	},
	{
		name: "instructions do not ask for research: no notice",
		instructions:
			"Project brief: summarize the pilot for the steering group.",
		allowWebResearch: false,
		expectedRules: [
			{
				in: "notice",
				pattern:
					/do not ask for external research, add no notice and do not mention research/i,
			},
		],
		properties: {
			notice: "none",
			allowedUrls: [],
		},
		compliant: doc("# Pilot Summary", INTERNAL_SECTION),
		violations: [
			{
				property: "notice",
				document: doc(
					"# Pilot Summary",
					NOT_AUTHORIZED_NOTICE,
					INTERNAL_SECTION,
				),
			},
		],
	},
];

function promptTextFor(evidenceCase: EvidenceCase): Record<PromptPart, string> {
	const authorized = evidenceCase.allowWebResearch;
	return {
		evidence: authorized ? buildWebResearchEvidenceGuidance() : "",
		notice: buildResearchNoticeGuidance({ allowWebResearch: authorized }),
		facts: authorized ? formatWebResearchOutcome(evidenceCase.outcome) : "",
	};
}

/** The verdict expected when only `property` (or nothing) fails. */
function verdictFailing(
	property?: PropertyName,
): Record<PropertyName, boolean> {
	return Object.fromEntries(
		PROPERTY_NAMES.map((name) => [name, name !== property]),
	) as Record<PropertyName, boolean>;
}

describe.each(cases)("evidence case: $name", (evidenceCase) => {
	it("the module emits the rules the case depends on", () => {
		const text = promptTextFor(evidenceCase);
		for (const rule of evidenceCase.expectedRules) {
			if (typeof rule.pattern === "string") {
				expect(text[rule.in]).toContain(rule.pattern);
			} else {
				expect(text[rule.in]).toMatch(rule.pattern);
			}
		}
	});

	it("the compliant document passes every property", () => {
		expect(
			checkDocument(evidenceCase.compliant, evidenceCase.properties),
		).toEqual(verdictFailing());
	});

	it.each(evidenceCase.violations)(
		"a document violating $property fails exactly that property",
		({ property, document }) => {
			expect(checkDocument(document, evidenceCase.properties)).toEqual(
				verdictFailing(property),
			);
		},
	);
});

describe("evidence checker", () => {
	it("finds the notice after leading blank lines", () => {
		expect(
			checkDocument(`\n\n${doc(PICKING_CASE, NOT_AUTHORIZED_NOTICE)}`, {
				notice: "not-authorized",
				allowedUrls: [],
			}).notice,
		).toBe(true);
	});

	it("reads a bare URL without its sentence-ending punctuation", () => {
		const verdict = checkDocument(
			doc(
				PICKING_CASE,
				`Of surveyed distributors, 38% reported errors, see ${SURVEY_URL}.`,
			),
			{
				notice: "none",
				allowedUrls: [SURVEY_URL],
				citations: [{ figure: "38%", url: SURVEY_URL }],
			},
		);
		expect(verdict.urls).toBe(true);
		expect(verdict.citations).toBe(true);
	});
});

describe("evidence case coverage", () => {
	it("covers every notice kind and every property", () => {
		const notices = new Set(cases.map((c) => c.properties.notice));
		expect([...notices].sort()).toEqual([
			"incomplete",
			"none",
			"not-authorized",
		]);
		const violated = new Set(
			cases.flatMap((c) => c.violations.map((v) => v.property)),
		);
		expect([...violated].sort()).toEqual([...PROPERTY_NAMES].sort());
	});

	it("uses only synthetic hosts", () => {
		const hosts = cases.flatMap((c) =>
			[c.compliant, ...c.violations.map((v) => v.document)].flatMap(
				(document) =>
					(document.match(URL_IN_TEXT) ?? []).map(
						(url) =>
							new URL(url.replace(TRAILING_PUNCTUATION, ""))
								.hostname,
					),
			),
		);
		for (const host of hosts) {
			expect(host).toMatch(/(^|\.)example\.(com|org|net)$/);
		}
	});
});
