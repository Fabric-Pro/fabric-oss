import { describe, expect, it } from "vitest";
import {
	buildFindingReviewPrompt,
	mapRawReviewToProposal,
	normalizeConfidence,
	normalizeVerdict,
	type RawReviewResult,
	type ReviewFindingInput,
	ReviewResultSchema,
} from "../review-schemas";

const baseFinding: ReviewFindingInput = {
	id: "finding-1",
	category: "SECURITY",
	severity: "HIGH",
	title: "Possible SQL injection in search",
	description: "User input flows into a query.",
	ruleSource: "OWASP Top 10 — A03:2021 Injection",
	location: "Feature F-12",
	sourceUrl: null,
	confidence: 0.6,
	evidence: null,
};

describe("normalizeVerdict — refute-by-default", () => {
	it("maps confirming synonyms to 'confirmed'", () => {
		expect(normalizeVerdict("confirmed")).toBe("confirmed");
		expect(normalizeVerdict("True Positive")).toBe("confirmed");
		expect(normalizeVerdict("exploitable")).toBe("confirmed");
		expect(normalizeVerdict("valid")).toBe("confirmed");
	});

	it("maps refuting synonyms to 'false_positive'", () => {
		expect(normalizeVerdict("false_positive")).toBe("false_positive");
		expect(normalizeVerdict("False Positive")).toBe("false_positive");
		expect(normalizeVerdict("not exploitable")).toBe("false_positive");
		expect(normalizeVerdict("unreachable")).toBe("false_positive");
		expect(normalizeVerdict("benign")).toBe("false_positive");
	});

	it("maps abstaining synonyms to 'uncertain'", () => {
		expect(normalizeVerdict("uncertain")).toBe("uncertain");
		expect(normalizeVerdict("needs more info")).toBe("uncertain");
		expect(normalizeVerdict("inconclusive")).toBe("uncertain");
	});

	it("defaults unknown/missing verdicts to 'uncertain', never 'confirmed'", () => {
		// The judge must AFFIRMATIVELY confirm — silence is an abstention.
		expect(normalizeVerdict("gibberish")).toBe("uncertain");
		expect(normalizeVerdict(undefined)).toBe("uncertain");
		expect(normalizeVerdict(null)).toBe("uncertain");
		expect(normalizeVerdict(42)).toBe("uncertain");
		expect(normalizeVerdict("")).toBe("uncertain");
	});
});

describe("normalizeConfidence", () => {
	it("maps categorical confidence + synonyms to the canonical bucket", () => {
		expect(normalizeConfidence("high")).toBe("high");
		expect(normalizeConfidence("Strong")).toBe("high");
		expect(normalizeConfidence("moderate")).toBe("medium");
		expect(normalizeConfidence("low")).toBe("low");
		expect(normalizeConfidence("weak")).toBe("low");
	});

	it("defaults unknown/missing confidence to 'medium'", () => {
		expect(normalizeConfidence("nonsense")).toBe("medium");
		expect(normalizeConfidence(undefined)).toBe("medium");
		expect(normalizeConfidence(null)).toBe("medium");
	});
});

describe("mapRawReviewToProposal — verdict → proposal mapping", () => {
	it("a confirmed verdict carries no suggestedStatus and keeps the finding", () => {
		const proposal = mapRawReviewToProposal(baseFinding.id, {
			verdict: "confirmed",
			reasoning: "The query concatenates raw user input.",
			confidence: "high",
		});
		expect(proposal.findingId).toBe("finding-1");
		expect(proposal.verdict).toBe("confirmed");
		expect(proposal.suggestedStatus).toBeUndefined();
		expect(proposal.confidence).toBe("high");
	});

	it("a false_positive verdict sets suggestedStatus=DISMISSED", () => {
		const proposal = mapRawReviewToProposal(baseFinding.id, {
			verdict: "false_positive",
			reasoning: "The query is parameterized; no injection is possible.",
			confidence: "high",
		});
		expect(proposal.verdict).toBe("false_positive");
		expect(proposal.suggestedStatus).toBe("DISMISSED");
	});

	it("an uncertain verdict carries no suggestedStatus", () => {
		const proposal = mapRawReviewToProposal(baseFinding.id, {
			verdict: "uncertain",
			reasoning: "Insufficient evidence to determine reachability.",
			confidence: "low",
		});
		expect(proposal.verdict).toBe("uncertain");
		expect(proposal.suggestedStatus).toBeUndefined();
	});

	it("normalizes a suggestedSeverity on a still-real finding", () => {
		const proposal = mapRawReviewToProposal(baseFinding.id, {
			verdict: "confirmed",
			// Model synonym for HIGH — normalized in code, not the schema.
			suggestedSeverity: "Serious",
			reasoning: "Real, but impact is narrower than CRITICAL.",
			confidence: "medium",
		});
		expect(proposal.suggestedSeverity).toBe("HIGH");
	});

	it("ignores a suggestedSeverity when the verdict is false_positive (severity is moot)", () => {
		const proposal = mapRawReviewToProposal(baseFinding.id, {
			verdict: "false_positive",
			suggestedSeverity: "CRITICAL",
			reasoning: "Not exploitable.",
			confidence: "high",
		});
		expect(proposal.suggestedSeverity).toBeUndefined();
		expect(proposal.suggestedStatus).toBe("DISMISSED");
	});

	it("omits suggestedSeverity when the judge left it blank/absent", () => {
		const proposal = mapRawReviewToProposal(baseFinding.id, {
			verdict: "confirmed",
			suggestedSeverity: "   ",
			reasoning: "Severity is correct.",
			confidence: "medium",
		});
		expect(proposal.suggestedSeverity).toBeUndefined();
	});

	it("defaults a missing verdict to uncertain (no status change)", () => {
		const proposal = mapRawReviewToProposal(baseFinding.id, {
			reasoning: "No verdict field returned.",
		} as RawReviewResult);
		expect(proposal.verdict).toBe("uncertain");
		expect(proposal.suggestedStatus).toBeUndefined();
		expect(proposal.confidence).toBe("medium");
	});

	it("clamps a very long evidence quote", () => {
		const proposal = mapRawReviewToProposal(baseFinding.id, {
			verdict: "confirmed",
			reasoning: "ok",
			confidence: "high",
			evidenceQuote: "x".repeat(400),
		});
		expect(proposal.evidenceQuote).toBeDefined();
		expect((proposal.evidenceQuote ?? "").length).toBeLessThanOrEqual(241);
	});
});

// Fake secrets are CONSTRUCTED at runtime (never written as string literals) so
// the repo's Semgrep CI secret-detection doesn't flag these test fixtures as
// real leaked credentials. The runtime values still match the redaction
// patterns, so the assertions are unchanged in intent.
const FAKE_GH = `ghp_${"A".repeat(36)}`;
const FAKE_ENTROPY = "a1".repeat(20); // 40 chars, mixed letters+digits

describe("mapRawReviewToProposal — never persist a found credential", () => {
	it("redacts secrets in reasoning", () => {
		const proposal = mapRawReviewToProposal(baseFinding.id, {
			verdict: "confirmed",
			reasoning: `The token ${FAKE_GH} is hardcoded in the config.`,
			confidence: "high",
		});
		expect(proposal.reasoning).not.toContain("ghp_");
		expect(proposal.reasoning).toContain("[REDACTED]");
	});

	it("redacts secrets in the evidence quote", () => {
		const proposal = mapRawReviewToProposal(baseFinding.id, {
			verdict: "confirmed",
			reasoning: "leaked key in source",
			confidence: "high",
			evidenceQuote: `apiKey = "${FAKE_ENTROPY}"`,
		});
		expect(proposal.evidenceQuote).not.toContain(FAKE_ENTROPY);
		expect(proposal.evidenceQuote).toContain("[REDACTED]");
	});

	it("leaves non-secret prose + rule refs intact", () => {
		const proposal = mapRawReviewToProposal(baseFinding.id, {
			verdict: "false_positive",
			reasoning:
				"Delegated to middleware per A01:2021 Broken Access Control.",
			confidence: "medium",
			evidenceQuote: "requireAuth() runs before the handler",
		});
		expect(proposal.reasoning).toContain("A01:2021");
		expect(proposal.evidenceQuote).toBe(
			"requireAuth() runs before the handler",
		);
	});
});

describe("ReviewResultSchema — lenient parse (no z.enum/z.preprocess)", () => {
	it("accepts the judge's varied output without throwing", () => {
		const parsed = ReviewResultSchema.parse({
			verdict: "False Positive",
			suggestedSeverity: "Moderate",
			reasoning: "Parameterized query.",
			confidence: "High",
			evidenceQuote: "db.query(sql, [id])",
		});
		const proposal = mapRawReviewToProposal("f1", parsed);
		expect(proposal.verdict).toBe("false_positive");
		expect(proposal.confidence).toBe("high");
		// false_positive → severity is moot, suggestedStatus is DISMISSED.
		expect(proposal.suggestedSeverity).toBeUndefined();
		expect(proposal.suggestedStatus).toBe("DISMISSED");
	});

	it("tolerates a fully empty object (all fields optional)", () => {
		const parsed = ReviewResultSchema.parse({});
		const proposal = mapRawReviewToProposal("f1", parsed);
		expect(proposal.verdict).toBe("uncertain");
		expect(proposal.reasoning).toBe("");
		expect(proposal.confidence).toBe("medium");
	});
});

describe("buildFindingReviewPrompt — adversarial, fresh-context", () => {
	const prompt = buildFindingReviewPrompt(
		baseFinding,
		"- HIGH: serious impact\n- LOW: minor",
		"function search(q) { db.raw('SELECT * WHERE x=' + q) }",
	);

	it("instructs refute-by-default and an exact-quote requirement", () => {
		expect(prompt).toMatch(/REFUTE BY DEFAULT/i);
		expect(prompt).toMatch(/assume the finding is a FALSE POSITIVE/i);
		expect(prompt).toMatch(/EXACT quote/i);
	});

	it("treats uncertain as first-class (abstain, do not guess)", () => {
		expect(prompt).toMatch(/uncertain/i);
		expect(prompt).toMatch(/do NOT guess/i);
	});

	it("embeds the finding, the evidence, and the severity rubric", () => {
		expect(prompt).toContain("Possible SQL injection in search");
		expect(prompt).toContain("db.raw('SELECT * WHERE x=' + q)");
		expect(prompt).toContain("HIGH: serious impact");
	});

	it("forbids echoing secret values", () => {
		expect(prompt).toMatch(/NEVER quote a real secret/i);
	});

	it("handles a missing evidence excerpt without confirming by default", () => {
		const noEvidence = buildFindingReviewPrompt(baseFinding, "");
		expect(noEvidence).toMatch(/No additional source excerpt/i);
		expect(noEvidence).toMatch(/never 'confirmed'/i);
	});
});
