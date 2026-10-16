import { describe, expect, it } from "vitest";
import {
	type DerivedResponse,
	deriveFindingStates,
	type FindingResponseInput,
	NEEDS_REVIEW_REASONS,
	type ShownRunInput,
} from "../lib/proposal-artifact/finding-state";
import {
	buildSectionMap,
	DOCUMENT_SECTION_KEY,
	findSection,
	type SectionMap,
} from "../lib/proposal-artifact/section-hash";

const lines = (...parts: string[]) => parts.join("\n");

const BODY = lines(
	"# Proposal for Example Org",
	"",
	"## Scope",
	"",
	"One reporting platform.",
	"",
	"### Out of Scope",
	"",
	"Hardware procurement.",
	"",
	"## Timeline",
	"",
	"Twelve weeks.",
	"",
);

const MAP = buildSectionMap(BODY);

const ANSWERED_AT = "2026-10-01T10:00:00.000Z";
const EARLIER = "2026-09-30T10:00:00.000Z";
const LATER = "2026-10-02T10:00:00.000Z";

/** An answer to `stableKey`, given against `sectionKey` of `map`. */
function answer(
	stableKey: string,
	sectionKey: string | null,
	overrides: Partial<FindingResponseInput> = {},
	map: SectionMap = MAP,
): FindingResponseInput {
	const sectionHash =
		sectionKey === null || sectionKey === DOCUMENT_SECTION_KEY
			? map.documentProseHash
			: (findSection(map, sectionKey)?.proseHash ?? "p1:missing");
	return {
		stableKey,
		kind: "CONFIRMED",
		sectionKey,
		sectionHash,
		answeredRunId: "run-1",
		updatedAt: ANSWERED_AT,
		...overrides,
	};
}

const run = (
	findingKeys: string[],
	overrides: Partial<ShownRunInput> = {},
): ShownRunInput => ({
	id: "run-2",
	createdAt: LATER,
	findingKeys,
	...overrides,
});

/**
 * One answer's derived state, through the public derivation: the only answer
 * in the input, so it is the one `responses` holds.
 */
function deriveOne(
	response: FindingResponseInput,
	sectionMap: SectionMap,
	shownRun: ShownRunInput | null,
): DerivedResponse {
	const [derived] = deriveFindingStates({
		responses: [response],
		sectionMap,
		shownRun,
	}).responses;
	if (!derived) {
		throw new Error("expected the answer to be derived");
	}
	return derived;
}

const summary = (derived: DerivedResponse) => ({
	state: derived.state,
	reason: derived.reason,
	versionUnknown: derived.versionUnknown,
});

describe("one answer's state", () => {
	it("keeps the answered kind while the section is unchanged and not raised again", () => {
		const confirmed = answer("risk:scope#0:budget", "p1:scope#0");
		const responded = answer("gap:timeline#0:dates", "p1:timeline#0", {
			kind: "RESPONDED",
		});

		expect(summary(deriveOne(confirmed, MAP, null))).toEqual({
			state: "CONFIRMED",
			reason: null,
			versionUnknown: false,
		});
		expect(summary(deriveOne(responded, MAP, run([])))).toEqual({
			state: "RESPONDED",
			reason: null,
			versionUnknown: false,
		});
	});

	it("needs review when the section's prose changed", () => {
		const changed = buildSectionMap(
			BODY.replace("Twelve weeks", "Ten weeks"),
		);

		expect(
			summary(deriveOne(answer("k", "p1:timeline#0"), changed, null)),
		).toEqual({
			state: "NEEDS_REVIEW",
			reason: "SECTION_CHANGED",
			versionUnknown: false,
		});
		// A sibling section's answer still stands.
		expect(deriveOne(answer("k", "p1:scope#0"), changed, null).state).toBe(
			"CONFIRMED",
		);
	});

	it("does not flip on a formatting-only or title change", () => {
		const reformatted = buildSectionMap(
			BODY.replace("# Proposal for Example Org", "# Draft Proposal")
				.replace("One reporting platform.", "One *reporting* platform.")
				.replace("## Timeline", "## 2. Timeline"),
		);

		for (const key of [
			"p1:scope#0",
			"p1:scope/out of scope#0",
			"p1:timeline#0",
		]) {
			expect(deriveOne(answer("k", key), reformatted, null).state).toBe(
				"CONFIRMED",
			);
		}
	});

	it("needs review with section not found when the heading is renamed, promoted, demoted, or its parent renamed", () => {
		const variants = {
			renamed: BODY.replace("## Timeline", "## Schedule"),
			promoted: BODY.replace("### Out of Scope", "## Out of Scope"),
			demoted: BODY.replace("## Timeline", "### Timeline"),
			parentRenamed: BODY.replace("## Scope", "## Boundaries"),
		};
		const answers = {
			renamed: answer("k", "p1:timeline#0"),
			promoted: answer("k", "p1:scope/out of scope#0"),
			demoted: answer("k", "p1:timeline#0"),
			parentRenamed: answer("k", "p1:scope/out of scope#0"),
		};

		for (const name of Object.keys(variants) as Array<
			keyof typeof variants
		>) {
			expect(
				summary(
					deriveOne(
						answers[name],
						buildSectionMap(variants[name]),
						null,
					),
				),
				name,
			).toEqual({
				state: "NEEDS_REVIEW",
				reason: "SECTION_NOT_FOUND",
				versionUnknown: false,
			});
		}
	});

	it("needs review, never re-attaches silently, when a same-path heading is inserted before the answered section", () => {
		const twoRisks = lines("## Risks", "", "Vendor delays.", "");
		const before = buildSectionMap(twoRisks);
		const answered = answer(
			"risk:risks#0:vendor",
			"p1:risks#0",
			{},
			before,
		);
		const inserted = buildSectionMap(
			lines("## Risks", "", "Scope growth.", "", twoRisks),
		);

		expect(findSection(inserted, "p1:risks#1")?.proseHash).toBe(
			answered.sectionHash,
		);
		expect(summary(deriveOne(answered, inserted, null))).toEqual({
			state: "NEEDS_REVIEW",
			reason: "SECTION_CHANGED",
			versionUnknown: false,
		});
	});

	it("compares a document-level answer with the document prose hash", () => {
		for (const sectionKey of [null, DOCUMENT_SECTION_KEY]) {
			const documentAnswer = answer("tone:doc:formal", sectionKey);

			expect(deriveOne(documentAnswer, MAP, null).state).toBe(
				"CONFIRMED",
			);
			expect(
				summary(
					deriveOne(
						documentAnswer,
						buildSectionMap(BODY.replace("Hardware", "Office")),
						null,
					),
				),
			).toEqual({
				state: "NEEDS_REVIEW",
				reason: "SECTION_CHANGED",
				versionUnknown: false,
			});
		}
	});

	describe("raised again", () => {
		const key = "risk:scope#0:budget";

		it("needs review when a newer, different run raises the key, even with unchanged text", () => {
			expect(
				summary(deriveOne(answer(key, "p1:scope#0"), MAP, run([key]))),
			).toEqual({
				state: "NEEDS_REVIEW",
				reason: "RAISED_AGAIN",
				versionUnknown: false,
			});
		});

		it("is not raised again on the run the answer was given on or mapped to", () => {
			expect(
				deriveOne(
					answer(key, "p1:scope#0", { answeredRunId: "run-2" }),
					MAP,
					run([key]),
				).state,
			).toBe("CONFIRMED");
		});

		it("is not raised again by an older run shown after a Reject", () => {
			expect(
				deriveOne(
					answer(key, "p1:scope#0"),
					MAP,
					run([key], { id: "run-0", createdAt: EARLIER }),
				).state,
			).toBe("CONFIRMED");
		});

		it("is not raised again by a run created at the moment of the answer", () => {
			expect(
				deriveOne(
					answer(key, "p1:scope#0"),
					MAP,
					run([key], { createdAt: ANSWERED_AT }),
				).state,
			).toBe("CONFIRMED");
		});

		it("accepts Date values as well as strings", () => {
			const derived = deriveOne(
				answer(key, "p1:scope#0", { updatedAt: new Date(ANSWERED_AT) }),
				MAP,
				run([key], { createdAt: new Date(LATER) }),
			);

			expect(derived.reason).toBe("RAISED_AGAIN");
		});

		it("asks for review when a time cannot be read", () => {
			expect(
				deriveOne(
					answer(key, "p1:scope#0", { updatedAt: "not a date" }),
					MAP,
					run([key]),
				).reason,
			).toBe("RAISED_AGAIN");
		});
	});

	it("reports section not found before section changed before raised again", () => {
		const key = "risk:timeline#0:dates";
		const raised = run([key]);
		const changedText = buildSectionMap(
			BODY.replace("Twelve weeks", "Ten weeks"),
		);
		const renamed = buildSectionMap(
			BODY.replace("## Timeline", "## Schedule"),
		);

		expect(
			deriveOne(answer(key, "p1:timeline#0"), renamed, raised).reason,
		).toBe("SECTION_NOT_FOUND");
		expect(
			deriveOne(answer(key, "p1:timeline#0"), changedText, raised).reason,
		).toBe("SECTION_CHANGED");
		expect(
			deriveOne(answer(key, "p1:timeline#0"), MAP, raised).reason,
		).toBe("RAISED_AGAIN");
	});

	it("lists the reasons the read schema accepts in that order of precedence", () => {
		expect(NEEDS_REVIEW_REASONS).toEqual([
			"SECTION_NOT_FOUND",
			"SECTION_CHANGED",
			"RAISED_AGAIN",
		]);
	});

	describe("another projection version", () => {
		it("reads an unknown key as unknown, not changed or missing", () => {
			const stale = answer("k", "p1:timeline#0", {
				sectionKey: "p0:timeline#0",
				sectionHash: "p0:0123456789abcdef",
			});

			expect(summary(deriveOne(stale, MAP, null))).toEqual({
				state: "CONFIRMED",
				reason: null,
				versionUnknown: true,
			});
		});

		it("reads an unknown hash under a current key as unknown, but still reports a missing section", () => {
			const stale = answer("k", "p1:timeline#0", {
				sectionHash: "p0:0123456789abcdef",
			});

			expect(summary(deriveOne(stale, MAP, null))).toEqual({
				state: "CONFIRMED",
				reason: null,
				versionUnknown: true,
			});
			expect(
				summary(
					deriveOne(
						stale,
						buildSectionMap(
							BODY.replace("## Timeline", "## Schedule"),
						),
						null,
					),
				),
			).toEqual({
				state: "NEEDS_REVIEW",
				reason: "SECTION_NOT_FOUND",
				versionUnknown: true,
			});
		});

		it("reads an unknown document hash as unknown", () => {
			const stale = answer("k", null, {
				sectionHash: "0123456789abcdef",
			});

			expect(summary(deriveOne(stale, MAP, null))).toEqual({
				state: "CONFIRMED",
				reason: null,
				versionUnknown: true,
			});
		});

		it("still applies raised again, which does not depend on the projection", () => {
			const stale = answer("k", "p0:timeline#0", {
				sectionHash: "p0:00",
			});

			expect(summary(deriveOne(stale, MAP, run(["k"])))).toEqual({
				state: "NEEDS_REVIEW",
				reason: "RAISED_AGAIN",
				versionUnknown: true,
			});
		});
	});
});

describe("deriveFindingStates", () => {
	it("derives each shown finding, the answers no longer raised, and every answer", () => {
		const changed = buildSectionMap(
			BODY.replace("Twelve weeks", "Ten weeks"),
		);
		const onShownRun = answer("a:scope#0:budget", "p1:scope#0", {
			answeredRunId: "run-2",
		});
		const raisedAgain = answer("b:scope#0:owner", "p1:scope#0");
		const goneButStanding = answer(
			"c:scope/out of scope#0:hw",
			"p1:scope/out of scope#0",
			{
				kind: "RESPONDED",
			},
		);
		const goneAndChanged = answer("d:timeline#0:dates", "p1:timeline#0");

		const result = deriveFindingStates({
			responses: [
				onShownRun,
				raisedAgain,
				goneButStanding,
				goneAndChanged,
			],
			sectionMap: changed,
			shownRun: run([
				"a:scope#0:budget",
				"b:scope#0:owner",
				"e:timeline#0:new",
			]),
		});

		expect(
			result.findings.map(({ stableKey, state, reason, response }) => ({
				stableKey,
				state,
				reason,
				answered: response?.response.stableKey ?? null,
			})),
		).toEqual([
			{
				stableKey: "a:scope#0:budget",
				state: "CONFIRMED",
				reason: null,
				answered: "a:scope#0:budget",
			},
			{
				stableKey: "b:scope#0:owner",
				state: "NEEDS_REVIEW",
				reason: "RAISED_AGAIN",
				answered: "b:scope#0:owner",
			},
			{
				stableKey: "e:timeline#0:new",
				state: "UNADDRESSED",
				reason: null,
				answered: null,
			},
		]);
		expect(
			result.noLongerRaised.map((derived) => [
				derived.response.stableKey,
				derived.state,
				derived.reason,
			]),
		).toEqual([
			["c:scope/out of scope#0:hw", "RESPONDED", null],
			["d:timeline#0:dates", "NEEDS_REVIEW", "SECTION_CHANGED"],
		]);
		expect(
			result.responses.map((derived) => derived.response.stableKey),
		).toEqual([
			"a:scope#0:budget",
			"b:scope#0:owner",
			"c:scope/out of scope#0:hw",
			"d:timeline#0:dates",
		]);
	});

	it("lists every answer as no longer raised when no run is shown", () => {
		const result = deriveFindingStates({
			responses: [answer("a", "p1:scope#0")],
			sectionMap: MAP,
			shownRun: null,
		});

		expect(result.findings).toEqual([]);
		expect(result.noLongerRaised.map((derived) => derived.state)).toEqual([
			"CONFIRMED",
		]);
	});

	it("keeps one answer per key, the one updated last, and shows a key raised twice once", () => {
		const older = answer("a", "p1:scope#0", {
			kind: "CONFIRMED",
			updatedAt: EARLIER,
		});
		const newer = answer("a", "p1:scope#0", {
			kind: "RESPONDED",
			updatedAt: ANSWERED_AT,
		});

		const result = deriveFindingStates({
			responses: [older, newer],
			sectionMap: MAP,
			shownRun: run(["a", "a"], { id: "run-1" }),
		});

		expect(result.responses).toHaveLength(1);
		expect(result.responses[0].response).toBe(newer);
		expect(result.findings).toHaveLength(1);
		expect(result.findings[0].state).toBe("RESPONDED");
	});

	it("passes the caller's own response fields through", () => {
		const withId = {
			...answer("a", "p1:scope#0"),
			id: "response-1",
			title: "Budget",
		};

		const result = deriveFindingStates({
			responses: [withId],
			sectionMap: MAP,
			shownRun: null,
		});

		expect(result.responses[0].response.id).toBe("response-1");
	});
});
