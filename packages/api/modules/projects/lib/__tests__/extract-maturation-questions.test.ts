import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Question-extraction bridge (§5.2) — now a DETERMINISTIC parse of the spec's
 * question-headed sections (no model call). The parser tests assert it yields
 * EXACTLY the stated, unresolved questions for each real stage-prompt format and
 * invents nothing; the mint tests assert the dedupe/mint loop over the parsed set.
 */

const mocks = vi.hoisted(() => ({
	findDecisionByQuestionId: vi.fn(),
	createDecisionLogEntry: vi.fn(),
	markQuestionsPossiblyResolved: vi.fn(),
	setQuestionStatus: vi.fn(),
	classifyQuestionTopics: vi.fn(),
	proposeQuestionAnswers: vi.fn(),
	isAiAnswerRecommendationsEnabled: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	findDecisionByQuestionId: mocks.findDecisionByQuestionId,
	createDecisionLogEntry: mocks.createDecisionLogEntry,
	markQuestionsPossiblyResolved: mocks.markQuestionsPossiblyResolved,
	setQuestionStatus: mocks.setQuestionStatus,
	isAiAnswerRecommendationsEnabled: mocks.isAiAnswerRecommendationsEnabled,
}));

// Topic classification is a best-effort labelling pass over the new questions;
// mock it so the mint tests stay deterministic and make no model call.
vi.mock("../classify-question-topics", () => ({
	classifyQuestionTopics: mocks.classifyQuestionTopics,
}));

// The answer-recommendation pass (#7) makes a model + RAG call; mock it so the
// mint tests stay deterministic and don't pull the real @repo/ai chain at import.
vi.mock("../propose-question-answers", () => ({
	proposeQuestionAnswers: mocks.proposeQuestionAnswers,
}));

const { extractMaturationQuestions, parseSpecQuestions, questionStableKey } =
	await import("../extract-maturation-questions");

const tenantFilter = { organizationId: "org-1", userId: "user-1" } as const;

function feature(description: string, autoProposeAnswers = true) {
	return {
		id: "story-1",
		projectId: "project-1",
		title: "Login",
		description,
		acceptanceCriteria: null,
		summaryDigest: null,
		workingNotesContent: null,
		lastQuestionScanHash: null,
		maturationV2OptedIn: true,
		autoProposeAnswers,
		cleanSpecApprovalMode: null,
		decisionLogApprovalMode: null,
		summaryQuestionsApprovalMode: null,
	} as never;
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.findDecisionByQuestionId.mockResolvedValue(null);
	mocks.markQuestionsPossiblyResolved.mockResolvedValue(0);
	mocks.setQuestionStatus.mockResolvedValue(1);
	mocks.proposeQuestionAnswers.mockResolvedValue({ recommended: 0 });
	mocks.isAiAnswerRecommendationsEnabled.mockResolvedValue(true);
	mocks.classifyQuestionTopics.mockImplementation(async ({ questions }) =>
		questions.map(() => "Tooling & Tech"),
	);
	let n = 0;
	mocks.createDecisionLogEntry.mockImplementation(async (arg) => {
		n += 1;
		return {
			id: `dec-${n}`,
			impactedSection: arg.impactedSection ?? null,
			topic: arg.topic ?? null,
		};
	});
});

describe("parseSpecQuestions — faithful to the spec, invents nothing", () => {
	it("skips the 'Initial Questions' draft section entirely", () => {
		const spec = [
			"# Feature Stub",
			"## Overview",
			"Some prose with a question mark? but not under a heading.",
			"## Initial Questions",
			"- Q: Which TOTP apps are supported beyond Google Authenticator?",
			"- Q: What is the admin reset flow for a lost device?",
			"## Keywords",
			"- MFA, TOTP",
		].join("\n");

		// "Initial Questions" is the placeholder's draft section, superseded by the
		// refined "Open Questions (Discovery)" emitted in the same run — never minted.
		expect(parseSpecQuestions(spec)).toEqual([]);
	});

	it("placeholder dual-section: reads only 'Open Questions (Discovery)', not 'Initial Questions'", () => {
		// The placeholder stage emits BOTH sections in one pass, often double-asking
		// the same concern (toolkit) in different words. Reading only the refined
		// section keeps the duplicate out.
		const spec = [
			"# Feature Stub",
			"## Initial Questions",
			"- Q: Has a decision been made on which editing toolkit to use — Tip Tap or Extend UI?",
			"- Q: What is the definition of done for v2?",
			"## Open Questions (Discovery)",
			"- Which toolkit (Tip Tap, Extend UI, custom) will be selected, and has cost been evaluated?",
			"- Is there a UX wireframe for the inline AI experience yet?",
		].join("\n");

		const qs = parseSpecQuestions(spec).map((q) => q.question);
		expect(qs).toEqual([
			"Which toolkit (Tip Tap, Extend UI, custom) will be selected, and has cost been evaluated?",
			"Is there a UX wireframe for the inline AI experience yet?",
		]);
	});

	it("'Open Questions (Discovery)' flat bullets, ignoring other sections", () => {
		const spec = [
			"## Must Haves",
			"- Users can enroll a TOTP authenticator",
			"## Open Questions (Discovery)",
			"- Is the Tip Tap toolkit cost acceptable?",
			"- Has Alice completed the Extend UI investigation?",
			"## Technical Observations (Informational Only)",
			"- Some observation that ends with a question? but is not a question section",
		].join("\n");

		const qs = parseSpecQuestions(spec).map((q) => q.question);
		expect(qs).toEqual([
			"Is the Tip Tap toolkit cost acceptable?",
			"Has Alice completed the Extend UI investigation?",
		]);
	});

	it("'Questions (Prioritized)' — takes the question lines, drops nested sub-labels", () => {
		const spec = [
			"## Questions (Prioritized)",
			"1. Should MFA enforcement be configurable per organization?",
			"   - Why it matters: governance",
			"   - Options: org-level vs global",
			"   - Recommendation (PM-facing only): per-org",
			"2. What is the acceptable number of failed TOTP attempts?",
			"   - Why it matters: lockout policy",
			"## Suggested Next Inputs",
			"- Needed input: security policy doc",
		].join("\n");

		const qs = parseSpecQuestions(spec).map((q) => q.question);
		expect(qs).toEqual([
			"Should MFA enforcement be configurable per organization?",
			"What is the acceptable number of failed TOTP attempts?",
		]);
	});

	it("returns nothing when there is no question-headed section (never invents)", () => {
		const spec = [
			"# Feature",
			"## Overview",
			"This feature does a thing. Is it good? Probably.",
			"## Must Haves",
			"- Do the thing",
		].join("\n");
		expect(parseSpecQuestions(spec)).toEqual([]);
	});

	it("skips the 'Initial Questions' draft section even when the heading is decorated", () => {
		// `SKIP_QUESTION_HEADING_RE` is `^…$`-anchored, so it cannot see through a
		// heading the PO highlighted or bolded in the editor. Untreated, the skip
		// silently stops applying and the DRAFT questions leak into the minted set
		// beside their refined duplicates — the exact double-count the rule exists
		// to prevent. `cleanQuestionText` already strips emphasis from ITEM text;
		// the heading now gets the same treatment.
		const decorated = [
			'## <mark data-color="#fef08a">Initial Questions</mark>',
			"## **Initial Questions**",
			"## `Initial Questions`",
			"## _Initial Questions_",
		];
		for (const heading of decorated) {
			const spec = [
				"# Feature Stub",
				heading,
				"- Q: Which TOTP apps are supported beyond Google Authenticator?",
				"- Q: What is the admin reset flow for a lost device?",
			].join("\n");
			expect(parseSpecQuestions(spec)).toEqual([]);
		}
	});

	it("still reads a decorated 'Open Questions (Discovery)' section", () => {
		const spec = [
			"# Feature Stub",
			"## **Initial Questions**",
			"- Q: Has a decision been made on which editing toolkit to use?",
			'## <mark data-color="#fef08a">Open Questions (Discovery)</mark>',
			"- Which toolkit (Tip Tap, Extend UI, custom) will be selected?",
			"- Is there a UX wireframe for the inline AI experience yet?",
		].join("\n");

		const parsed = parseSpecQuestions(spec);
		expect(parsed.map((q) => q.question)).toEqual([
			"Which toolkit (Tip Tap, Extend UI, custom) will be selected?",
			"Is there a UX wireframe for the inline AI experience yet?",
		]);
		// The normalized heading is used for MATCHING only — what gets stored as
		// `impactedSection` is still the original, decoration and all, because the
		// normalizer's output is lossy and must never be persisted.
		expect(parsed[0].impactedSection).toBe(
			'<mark data-color="#fef08a">Open Questions (Discovery)</mark>',
		);
	});

	it("de-duplicates identical question text within the spec", () => {
		const spec = [
			"## Open Questions",
			"- Should MFA be mandatory for all users?",
			"- Should MFA be mandatory for all users?",
		].join("\n");
		expect(parseSpecQuestions(spec).map((q) => q.question)).toEqual([
			"Should MFA be mandatory for all users?",
		]);
	});
});

describe("extractMaturationQuestions — mint/dedupe over the parsed set", () => {
	it("mints each parsed question as an OPEN AGENT root with a stable key", async () => {
		const out = await extractMaturationQuestions({
			feature: feature(
				"## Open Questions\n- Should MFA be mandatory?\n- Which apps are supported here?",
			),
			tenantFilter,
		});
		expect(out).toMatchObject({ extracted: 2, minted: 2, skipped: 0 });
		const first = mocks.createDecisionLogEntry.mock.calls[0][0];
		expect(first).toMatchObject({
			authorType: "AGENT",
			status: "OPEN",
			content: "Should MFA be mandatory?",
			questionId: questionStableKey("Should MFA be mandatory?"),
			impactedSection: "Open Questions",
			// topic flows from the classifier through to the minted root
			topic: "Tooling & Tech",
		});
		expect(out.questions[0]).toMatchObject({ topic: "Tooling & Tech" });
	});

	it("runs the answer-recommendation pass on freshly minted questions (#7)", async () => {
		await extractMaturationQuestions({
			feature: feature("## Open Questions\n- Should MFA be mandatory?"),
			tenantFilter,
		});
		expect(mocks.proposeQuestionAnswers).toHaveBeenCalledTimes(1);
		const arg = mocks.proposeQuestionAnswers.mock.calls[0][0];
		expect(arg.questions).toHaveLength(1);
		expect(arg.questions[0]).toMatchObject({
			question: "Should MFA be mandatory?",
		});
	});

	it("skips the recommendation pass when autoProposeAnswers is off (#7)", async () => {
		await extractMaturationQuestions({
			feature: feature(
				"## Open Questions\n- Should MFA be mandatory?",
				false,
			),
			tenantFilter,
		});
		expect(mocks.proposeQuestionAnswers).not.toHaveBeenCalled();
	});

	it("skips the recommendation pass when the org flag is off (#7, FR-15)", async () => {
		mocks.isAiAnswerRecommendationsEnabled.mockResolvedValue(false);
		await extractMaturationQuestions({
			feature: feature("## Open Questions\n- Should MFA be mandatory?"),
			tenantFilter,
		});
		expect(mocks.proposeQuestionAnswers).not.toHaveBeenCalled();
	});

	it("skips a parsed question already present (open or answered)", async () => {
		mocks.findDecisionByQuestionId.mockResolvedValue({ id: "existing" });
		const out = await extractMaturationQuestions({
			feature: feature(
				"## Open Questions\n- Already asked and tracked here?",
			),
			tenantFilter,
		});
		expect(out).toMatchObject({ extracted: 1, minted: 0, skipped: 1 });
		expect(mocks.createDecisionLogEntry).not.toHaveBeenCalled();
	});

	it("is a no-op when the spec is empty", async () => {
		const out = await extractMaturationQuestions({
			feature: feature(""),
			tenantFilter,
		});
		expect(out).toEqual({
			extracted: 0,
			minted: 0,
			skipped: 0,
			softClosed: 0,
			reactivated: 0,
			questions: [],
		});
		expect(mocks.markQuestionsPossiblyResolved).not.toHaveBeenCalled();
	});

	it("soft-closes orphaned OPEN questions the refreshed spec no longer lists (#5)", async () => {
		// The refreshed spec lists exactly one question; reconciliation is asked to
		// keep that one OPEN and soft-close anything else (here: 1 orphan).
		mocks.markQuestionsPossiblyResolved.mockResolvedValue(1);
		const out = await extractMaturationQuestions({
			feature: feature(
				"## Open Questions\n- Is the new toolkit decided here?",
			),
			tenantFilter,
		});

		expect(out.softClosed).toBe(1);
		const call = mocks.markQuestionsPossiblyResolved.mock.calls[0][0];
		expect(call.userStoryId).toBe("story-1");
		expect(call.presentQuestionIds).toEqual([
			questionStableKey("Is the new toolkit decided here?"),
		]);
	});

	it("reactivates a POSSIBLY_RESOLVED question the refresh re-emits (#5)", async () => {
		mocks.findDecisionByQuestionId.mockResolvedValue({
			id: "dec-prev",
			status: "POSSIBLY_RESOLVED",
		});
		const out = await extractMaturationQuestions({
			feature: feature(
				"## Open Questions\n- Should this still be answered here?",
			),
			tenantFilter,
		});

		expect(out).toMatchObject({ minted: 0, skipped: 1, reactivated: 1 });
		expect(mocks.setQuestionStatus).toHaveBeenCalledWith({
			tenantFilter,
			rootId: "dec-prev",
			status: "OPEN",
		});
		// Reactivated key is "present", so reconciliation never soft-closes it.
		const call = mocks.markQuestionsPossiblyResolved.mock.calls[0][0];
		expect(call.presentQuestionIds).toEqual([
			questionStableKey("Should this still be answered here?"),
		]);
	});

	it("stable key: same question → same key, different → different", () => {
		expect(questionStableKey("Is MFA required?")).toBe(
			questionStableKey("  is mfa required??  "),
		);
		expect(questionStableKey("Is MFA required?")).not.toBe(
			questionStableKey("Which apps are supported?"),
		);
	});
});
