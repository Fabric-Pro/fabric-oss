import { logger } from "@repo/logs";
import {
	type AnalysisData,
	effectivePlanningAnalysis,
	renderAnalysisProse,
} from "@repo/utils/publishing-analysis-prose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildShortPostLockedClauses,
	buildShortPostVariables,
	composeShortPostPrompt,
	flattenPlanningAnalysis,
	PLANNING_ANALYSIS_CHAR_CAP,
	PLANNING_ANALYSIS_DATA_RESERVE,
	PublishingShortPostSchema,
	SHORT_POST_OPTION_COUNT,
} from "../build-short-post-prompt";

// Mocked so the budget's own degradation is ASSERTABLE, not merely printed.
// The composition's whole premise is that a silent truncation is the defect;
// a suite that cannot see the warn cannot tell a logged truncation from an
// unlogged one.
vi.mock("@repo/logs", () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

const warn = vi.mocked(logger.warn);

beforeEach(() => {
	vi.clearAllMocks();
});

/**
 * The pure half of Short Post generation (Fizzy #1853, Phase 2B-2).
 *
 * No model, no database, no Temporal context — every case here drives the
 * schema, the variables or the composition directly, which is why they live in
 * separate modules from the activity that uses them.
 */

const TOPIC = {
	id: "topic-1",
	title: "Faster incremental builds",
	pitch: "Builds now reuse a warm cache.",
	angle: null,
	subject: null,
	relevantFunctionTags: [],
	postTypeRecommendations: null,
	contributors: [],
};

const EMPTY_CONTEXT = {
	stories: [],
	documents: [],
	transcripts: [],
	repoPrs: [],
};

function option(over: Record<string, unknown> = {}) {
	return {
		label: "Direct",
		text: "Builds are faster now.",
		estimatedCharacters: 24,
		...over,
	};
}

describe("PublishingShortPostSchema", () => {
	it("accepts exactly three options", () => {
		const parsed = PublishingShortPostSchema.safeParse({
			options: [
				option({ label: "Direct" }),
				option({ label: "Question-led" }),
				option({ label: "Story-led" }),
			],
		});
		expect(parsed.success).toBe(true);
	});

	it("REJECTS two options", () => {
		// FR16 says exactly three. A lower bound would let a short run persist as
		// READY and the panel would render it as a finished answer, with nothing
		// downstream ever noticing the contract had been broken.
		const parsed = PublishingShortPostSchema.safeParse({
			options: [option({ label: "A" }), option({ label: "B" })],
		});
		expect(parsed.success).toBe(false);
	});

	it("REJECTS four options", () => {
		const parsed = PublishingShortPostSchema.safeParse({
			options: [
				option({ label: "A" }),
				option({ label: "B" }),
				option({ label: "C" }),
				option({ label: "D" }),
			],
		});
		expect(parsed.success).toBe(false);
	});

	it("REJECTS two options sharing a label", () => {
		// The label is the selection key: the client sends a label and the server
		// reads that option's text back out of the draft. Two options under one
		// label make the key ambiguous, so picking the second silently adopts the
		// first one's text — the reader chooses one post and a different post is
		// what gets published.
		const parsed = PublishingShortPostSchema.safeParse({
			options: [
				option({ label: "Direct", text: "First." }),
				option({
					label: "Direct",
					text: "Second, entirely different.",
				}),
				option({ label: "Story-led" }),
			],
		});
		expect(parsed.success).toBe(false);
	});

	it("REJECTS labels that differ only by case or surrounding space", () => {
		// These resolve fine as strings, so selection would work. They are
		// rejected because the label's job is to let a person tell the options
		// apart, and "Direct" next to "direct " is not a choice.
		const parsed = PublishingShortPostSchema.safeParse({
			options: [
				option({ label: "Direct" }),
				option({ label: " direct " }),
				option({ label: "Story-led" }),
			],
		});
		expect(parsed.success).toBe(false);
	});

	it("rejects an option with empty text", () => {
		const parsed = PublishingShortPostSchema.safeParse({
			options: [
				option({ text: "" }),
				option({ label: "B" }),
				option({ label: "C" }),
			],
		});
		expect(parsed.success).toBe(false);
	});

	it("defaults the optional sections rather than requiring them", () => {
		// The PO's prompt marks hashtags and inputs-needed "only include if
		// useful". Requiring them would fail a perfectly good run for omitting a
		// section it was told it could omit.
		const parsed = PublishingShortPostSchema.parse({
			options: [
				option({ label: "A" }),
				option({ label: "B" }),
				option({ label: "C" }),
			],
		});
		expect(parsed.hashtags).toEqual([]);
		expect(parsed.inputsNeeded).toEqual([]);
		expect(parsed.safetyNote).toBeNull();
	});

	it("keeps the model's own character estimate", () => {
		// Deliberately not recomputed from `text`: replacing the model's number
		// with ours would make the prompt's "report an estimated character count"
		// instruction unfalsifiable — a model that stopped reporting one would
		// look identical to one that still did.
		const parsed = PublishingShortPostSchema.parse({
			options: [
				option({ label: "A", text: "abc", estimatedCharacters: 999 }),
				option({ label: "B" }),
				option({ label: "C" }),
			],
		});
		expect(parsed.options[0].estimatedCharacters).toBe(999);
	});
});

describe("flattenPlanningAnalysis", () => {
	it("walks whatever the document holds rather than a known field list", () => {
		// The point of walking: 2A owns that schema and keeps evolving it. A
		// field list duplicated here would stop passing on whichever section
		// 2A added last; walking means a field assigned to `DATA_FIELDS`
		// reaches the writer the day 2A ships it, with no edit here.
		//
		// The drop is no longer silent, though. Since Fizzy #1851 this
		// function is handed only the data half, so a new schema section
		// reaches nothing at all until it is assigned to `PROSE_FIELDS` or
		// `DATA_FIELDS` — and
		// `publishing-planning/__tests__/analysis-field-partition.test.ts`
		// reddens until it is. That guard owns the assignment; this test owns
		// what the walk does with what it is handed.
		const out = flattenPlanningAnalysis({
			keyDetailsToUse: ["Cache reuse", "No config change"],
			aSectionInventedLater: { nested: "still reaches the writer" },
		});
		expect(out).toContain("Key details to use");
		expect(out).toContain("Cache reuse");
		expect(out).toContain("A section invented later");
		expect(out).toContain("still reaches the writer");
	});

	it("returns empty for a missing or non-object analysis", () => {
		expect(flattenPlanningAnalysis(null)).toBe("");
		expect(flattenPlanningAnalysis(undefined)).toBe("");
		expect(flattenPlanningAnalysis("not an object")).toBe("");
	});

	it("drops sections whose values are all empty", () => {
		// An empty section rendered as a bare heading invites the model to fill
		// it — the one thing the grounding rules forbid.
		const out = flattenPlanningAnalysis({ risks: [], notes: "   " });
		expect(out).toBe("");
	});

	it("caps a very long analysis", () => {
		const out = flattenPlanningAnalysis({
			notes: "x".repeat(20_000),
		});
		// Left uncapped, a long worksheet plus the source context it was derived
		// FROM can push one request past the provider's input window, which fails
		// the whole run rather than degrading it.
		expect(out.length).toBeLessThan(9000);
	});
});

describe("buildShortPostVariables", () => {
	it("omits each section when it has nothing", () => {
		const vars = buildShortPostVariables({
			analysisProse: "",
			analysisData: {},
			decisions: [],
			guidance: null,
		});
		expect(vars.has_planning_analysis).toBe(false);
		expect(vars.has_decisions).toBe(false);
		expect(vars.has_guidance).toBe(false);
	});

	it("drops a decision with no answer text", () => {
		// An unanswered decision is not a settled instruction. Rendering one
		// would present an open question to the model as though it were decided.
		const vars = buildShortPostVariables({
			analysisProse: "",
			analysisData: {},
			decisions: [
				{
					subject: "Customer name",
					decisionKind: "CUSTOMER_NAME",
					answer: "  ",
				},
			],
			guidance: null,
		});
		expect(vars.has_decisions).toBe(false);
	});

	it("names a decision by its kind when it carries no subject", () => {
		const vars = buildShortPostVariables({
			analysisProse: "",
			analysisData: {},
			decisions: [
				{
					subject: null,
					decisionKind: "METRICS_APPROVAL",
					answer: "Approved",
				},
			],
			guidance: null,
		});
		expect(vars.decisions).toContain("Metrics approval");
		expect(vars.decisions).toContain("Approved");
	});

	it("caps the guidance", () => {
		const vars = buildShortPostVariables({
			analysisProse: "",
			analysisData: {},
			decisions: [],
			guidance: "y".repeat(9000),
		});
		expect(vars.guidance.length).toBeLessThan(2100);
	});

	it("treats whitespace-only guidance as none", () => {
		const vars = buildShortPostVariables({
			analysisProse: "",
			analysisData: {},
			decisions: [],
			guidance: "   \n  ",
		});
		expect(vars.has_guidance).toBe(false);
	});
});

describe("buildShortPostVariables — the prose/data split (Fizzy #1851)", () => {
	// The AI's analysis, with a field from each half so the composition is
	// visible: `topicAngle` and `risks` are prose, `contentTypes` is data.
	const AI = {
		topicAngle: "Angle",
		risks: ["r1"],
		contentTypes: { recommended: [{ type: "Tweet" }] },
	};

	const analysisBlockFor = (input: { prose: string; data: AnalysisData }) =>
		buildShortPostVariables({
			analysisProse: input.prose,
			analysisData: input.data,
			decisions: [],
			guidance: null,
		}).planning_analysis;

	/**
	 * A structured half large enough that the reserve's SHARE is observable —
	 * not merely large enough to exceed it.
	 *
	 * The `{ contentTypes: { recommended: [{ type: "Tweet" }] } }` fixture every
	 * other case here uses flattens to 54 characters, so
	 * `Math.min(dataLength, PLANNING_ANALYSIS_DATA_RESERVE)` resolved to 54 and
	 * the reserve never bound. Growing it past the reserve is not enough on its
	 * own either, and that is the trap: the composed TOTAL is
	 * `(budget − R) + 2 + (R + 1)` for EVERY reserve R, because the prose half
	 * gives up exactly what the structured half takes. R cancels, so no
	 * length assertion can ever constrain it. What pins R is WHICH headings land
	 * inside the emitted share — which needs the four real sections, in the
	 * order `flattenPlanningAnalysis` walks them, rather than one padded string.
	 *
	 * Measured heading offsets inside `flattenPlanningAnalysis(LARGE_DATA)`,
	 * which is 4,166 characters long:
	 *
	 *        0  ### Content types
	 *     1365  ### Supporting assets
	 *     2200  ### Source signals
	 *     2808  ### Recommended questions
	 *
	 * At the shipped 2,000 reserve the first two are inside the emitted share
	 * and the last two are not, and the ceiling test asserts both sides of that
	 * cut. Editing these strings moves the offsets: re-measure before adjusting
	 * an assertion to match.
	 */
	const LARGE_DATA: AnalysisData = {
		contentTypes: {
			recommended: [
				{
					type: "Launch blog post",
					rationale:
						"The change is large enough to carry a narrative, and the release notes already contain the before-and-after numbers.",
				},
				{
					type: "Short post",
					rationale:
						"The headline result fits in one sentence, which is the shape this channel rewards.",
				},
				{
					type: "Stakeholder email",
					rationale:
						"Two teams asked for the rollout date in the last planning round and neither reads the blog.",
				},
				{
					type: "Engineering changelog entry",
					rationale:
						"The people who hit the new cache path first read the changelog and nothing else, and they need the flag name.",
				},
				{
					type: "Internal demo recording",
					rationale:
						"A recording is the cheapest way to show a cold build and a warm one side by side without asking anyone to reproduce it.",
				},
			],
			needsConfirmation: [
				{
					type: "Customer case study",
					rationale:
						"The strongest evidence comes from one deployment, so publishing it needs that account's sign-off first.",
				},
				{
					type: "Comparison against the previous release",
					rationale:
						"The comparison is fair only if both runs used the same hardware, and that has not been confirmed for the older one.",
				},
			],
			deferred: [
				{
					type: "Conference talk",
					rationale:
						"Worth revisiting once the second phase ships; on its own this is thin for a session.",
				},
			],
		},
		supportingAssets: {
			recommended: [
				{
					type: "Architecture diagram",
					rationale:
						"The cache layer is the part readers consistently misread, and one diagram removes the ambiguity.",
				},
				{
					type: "Benchmark chart",
					rationale:
						"The improvement is a distribution rather than a single number, which prose flattens.",
				},
				{
					type: "Annotated build timeline",
					rationale:
						"Shows where the saved minutes actually come from, which is the question every reviewer asked first.",
				},
			],
			requiresApproval: [
				{
					type: "Internal dashboard capture",
					rationale:
						"Shows live project names and per-team figures, so it cannot ship without a redaction pass.",
				},
				{
					type: "Support ticket excerpt",
					rationale:
						"The clearest statement of the old pain came from a ticket, and quoting it needs the reporter's agreement.",
				},
			],
		},
		sourceSignals: [
			"Release notes for the last two versions name the cache as the headline change.",
			"Three merged pull requests describe the incremental path in their own descriptions.",
			"A planning transcript records the decision to keep the old path behind a flag.",
			"The rollout checklist lists the two teams that asked to be told before it lands.",
			"An earlier draft of the design document explains why the first approach was abandoned.",
			"A benchmark run recorded in the delivery channel shows the warm-cache figure twice.",
			"The escalation thread that started this work names the two slowest build steps.",
		],
		recommendedQuestions: [
			{
				decisionKind: "CUSTOMER_NAME",
				subject: "Naming the pilot deployment",
				question:
					"May the pilot deployment be named in public writing?",
				recommendedResponse:
					"Describe it by size and sector until written approval arrives.",
				whyItMatters:
					"Every draft that names it has to be rewritten if the answer is no.",
			},
			{
				decisionKind: "METRICS_APPROVAL",
				subject: "Publishing the build-time figures",
				question: "Can the measured build times be published verbatim?",
				recommendedResponse:
					"Publish the ratio rather than the absolute seconds.",
				whyItMatters:
					"The absolute figures imply a fleet size that is not public.",
			},
			{
				decisionKind: "AUTHORSHIP",
				subject: "Byline for the launch post",
				question: "Who signs the launch post?",
				recommendedResponse:
					"The engineer who wrote the design document, with the team as a co-byline.",
				whyItMatters:
					"The byline decides the voice, and the voice cannot be chosen after the draft.",
			},
			{
				decisionKind: "SCREENSHOT_APPROVAL",
				subject: "Reusing the internal build dashboard",
				question:
					"Can the build dashboard be shown as it looks internally?",
				recommendedResponse:
					"Redraw it with placeholder project names rather than redacting the capture.",
				whyItMatters:
					"A redacted capture still leaks the number of teams and the naming convention.",
			},
		],
	};

	it("produces the same prompt whether or not the prose was edited, when the text is identical", () => {
		// THE invariant of this whole feature, driven through the REAL resolver
		// rather than two hand-built inputs — a hand-built pair would agree by
		// construction and could not observe the resolver disagreeing.
		//
		// A revision whose body is exactly what the AI would have rendered must
		// produce a byte-identical prompt to having no revision at all.
		// Otherwise a reader's draft silently depends on whether anyone ever
		// opened the editor.
		const notEdited = effectivePlanningAnalysis({ ai: AI, revision: null });
		const edited = effectivePlanningAnalysis({
			ai: AI,
			revision: {
				body: renderAnalysisProse(AI),
				sourceAnalysisVersion: 1,
			},
		});
		if (!notEdited || !edited) {
			throw new Error(
				"the resolver returned null for a present analysis",
			);
		}

		// The two resolutions genuinely differ — one is an override and one is
		// not. Without this the assertion below could pass on two identical
		// objects and prove nothing.
		expect(notEdited.overridden).toBe(false);
		expect(edited.overridden).toBe(true);

		expect(analysisBlockFor(edited)).toBe(analysisBlockFor(notEdited));
	});

	it("passes the user's prose through verbatim", () => {
		// Not re-rendered, not re-flattened, not reformatted. What the author
		// wrote is what the model reads.
		const vars = buildShortPostVariables({
			analysisProse: "### My own heading\n\nmy words",
			analysisData: {},
			decisions: [],
			guidance: null,
		});

		expect(vars.planning_analysis).toContain("### My own heading");
		expect(vars.planning_analysis).toContain("my words");
	});

	it("drops the AI's prose entirely when a revision replaced it", () => {
		// The other half of the point: an edit is not additive. If the AI's
		// original angle survived alongside the author's rewrite, the model
		// would read both and the edit would be advisory rather than binding.
		const edited = effectivePlanningAnalysis({
			ai: AI,
			revision: { body: "USER PROSE", sourceAnalysisVersion: 1 },
		});
		if (!edited) {
			throw new Error(
				"the resolver returned null for a present analysis",
			);
		}

		const block = analysisBlockFor(edited);
		expect(block).toContain("USER PROSE");
		expect(block).not.toContain("Angle");
		// The structured half is NOT the author's to delete, and survives.
		expect(block).toContain("Content types");
	});

	it("still renders the structured sections after the prose", () => {
		const vars = buildShortPostVariables({
			analysisProse: "PROSE",
			analysisData: {
				contentTypes: { recommended: [{ type: "Tweet" }] },
			},
			decisions: [],
			guidance: null,
		});

		expect(vars.planning_analysis.indexOf("PROSE")).toBeLessThan(
			vars.planning_analysis.indexOf("Content types"),
		);
	});

	it("omits the section when BOTH halves are empty", () => {
		const vars = buildShortPostVariables({
			analysisProse: "   ",
			analysisData: {},
			decisions: [],
			guidance: null,
		});

		expect(vars.has_planning_analysis).toBe(false);
		expect(vars.planning_analysis).toBe("");
	});

	it("renders the prose alone when the analysis carries no structured half", () => {
		const vars = buildShortPostVariables({
			analysisProse: "Just prose.",
			analysisData: {},
			decisions: [],
			guidance: null,
		});

		expect(vars.has_planning_analysis).toBe(true);
		expect(vars.planning_analysis).toBe("Just prose.");
	});

	it("CAPS the composed block, not just the structured half", () => {
		// The regression this guards: `flattenPlanningAnalysis` clamps its own
		// output, so after the #1851 split that clamp covered only
		// `analysisData` — leaving `analysisProse`, arbitrary user-authored
		// Markdown, unbounded into a model input.
		//
		// Since slice 2 the composition also reserves a floor for the
		// structured half (`PLANNING_ANALYSIS_DATA_RESERVE`), so the old
		// `endsWith("…")` assertion no longer describes the contract: the
		// composed string ends with whichever half was clamped last. The
		// ceiling is what this test owns; `keeps the structured half` owns the
		// reserve.
		//
		// The PRECONDITIONS, asserted rather than assumed.
		//
		// A structured half smaller than the reserve makes
		// `Math.min(dataLength, RESERVE)` resolve to the data length, and every
		// branch below then holds for a reason that has nothing to do with the
		// reserve. And the SHARE assertions further down say something about R
		// only while these two headings STRADDLE it: a fixture edit that moved
		// either one to the other side would leave them passing for a reason
		// that is not the reserve. `### Supporting assets` must also sit well
		// clear of the first hundred characters, or a token reserve would still
		// deliver it.
		const flattened = flattenPlanningAnalysis(LARGE_DATA);
		const assetsAt = flattened.indexOf("### Supporting assets");
		expect(flattened.length).toBeGreaterThan(
			PLANNING_ANALYSIS_DATA_RESERVE,
		);
		expect(assetsAt).toBeGreaterThan(100);
		expect(assetsAt + "### Supporting assets".length).toBeLessThan(
			PLANNING_ANALYSIS_DATA_RESERVE,
		);
		expect(flattened.indexOf("### Source signals")).toBeGreaterThan(
			PLANNING_ANALYSIS_DATA_RESERVE,
		);

		const vars = buildShortPostVariables({
			analysisProse: "z".repeat(20_000),
			analysisData: LARGE_DATA,
			decisions: [],
			guidance: null,
		});

		// `clamp` appends ONE ellipsis per clamped half, and the composition
		// clamps at most both halves plus a two-character separator.
		expect(vars.planning_analysis.length).toBeLessThanOrEqual(
			PLANNING_ANALYSIS_CHAR_CAP + 1,
		);
		// AT the ceiling, not far below it. A budget that under-fills wastes
		// the input window as surely as one that overflows it, and the two
		// mutations that pass a bare `<=` — a reserve so large that prose is
		// squeezed to nothing, a composition that simply returns less than it
		// may — both land here. Measured decomposition at the current
		// constants: prose 5998 + separator 2 + data 2001.
		expect(vars.planning_analysis.length).toBe(
			PLANNING_ANALYSIS_CHAR_CAP + 1,
		);
		// A version that simply returned a short string cannot pass this.
		expect(vars.planning_analysis).toContain("### Content types");
		expect(vars.planning_analysis.startsWith("z")).toBe(true);

		// THE RESERVE'S SHARE — the one thing the ceiling above cannot hold.
		// That total is `(budget − R) + 2 + (R + 1)` for EVERY reserve R,
		// because the prose half gives up exactly what the structured half
		// takes, so R cancels and `toBe(CAP + 1)` is structurally blind to it.
		// These are not blind to it: at R = 2,000 the emitted structured share
		// reaches 2,001 characters into the flattened block, so
		// `### Supporting assets` (offset 1,365) is inside it and
		// `### Source signals` (2,200) is not. Cutting R to 20 deletes the
		// first; raising R, or replacing the reserve with a fixed half-and-half
		// split, admits the second.
		//
		// The pair is also the ORDERED loss the composition's docblock claims:
		// leading collections survive a cut, later ones do not.
		expect(vars.planning_analysis).toContain("### Supporting assets");
		expect(vars.planning_analysis).not.toContain("### Source signals");
		expect(vars.planning_analysis).not.toContain(
			"### Recommended questions",
		);

		// THE INVARIANT on the reserve branch: the two `*Emitted` counters plus
		// the separator must add back up to the composed block's actual length,
		// the same identity the pass-through path owes below.
		expect(warn).toHaveBeenCalledTimes(1);
		const logged = warn.mock.calls[0]?.[1] as {
			proseEmitted: number;
			dataEmitted: number;
		};
		const separatorLength = 2; // composeAnalysisBlock's `separator` is "\n\n".
		expect(logged.proseEmitted + separatorLength + logged.dataEmitted).toBe(
			vars.planning_analysis.length,
		);
	});

	it("keeps the whole prose AND a data block when prose is long but under the budget", () => {
		// The band this composition's threshold protects, and nothing else
		// covered it. Between roughly 6,000 and 8,000 characters of prose the
		// reserve would have bought a fuller data block with the END of the
		// author's prose — and `renderAnalysisProse` emits `risks` and
		// `preDraftGuidance` LAST while `clamp` truncates from the end, so the
		// two sections every writer template instructs the model to act on are
		// exactly what that trade would delete.
		//
		// The sentinel sits at the END of the prose on purpose: a length
		// assertion passes just as happily on a prose half that lost its tail.
		const prose = `${"z".repeat(6980)}END-OF-PROSE-SENTINEL`;
		const vars = buildShortPostVariables({
			analysisProse: prose,
			analysisData: LARGE_DATA,
			decisions: [],
			guidance: null,
		});

		expect(vars.planning_analysis).toContain("END-OF-PROSE-SENTINEL");
		expect(vars.planning_analysis).toContain("### Content types");
	});

	// The exact boundary of `composeAnalysisBlock`'s threshold
	// (`analysisProse.trim().length < budget`), pinned by nothing above: the
	// tests around it sit at ~7,000 (comfortably below) and 9,000 / 20,000
	// (comfortably above), so a mutant widening `<` to `<=` — engaging the
	// reserve one character early — or one computing the threshold from
	// `budget - 1` instead of `budget` — leaving it one character too low —
	// left the whole suite green.
	//
	// 7,998 is `PLANNING_ANALYSIS_CHAR_CAP` (8,000) minus the two-character
	// separator: the exact prose length at which the OLD, pre-reserve
	// composition let prose plus the separator consume the entire cap, leaving
	// the structured half nothing but `clamp`'s own ellipsis — the
	// all-or-nothing deletion the reserve exists to prevent, occurring at its
	// own boundary. 7,997 is the last prose length that still takes the
	// pass-through branch; 7,998 is the first that engages the reserve.
	function proseTrimmedTo(length: number, sentinel: string): string {
		const padding = "z".repeat(length - sentinel.length);
		// Leading AND trailing whitespace: the threshold compares
		// `analysisProse.trim().length`, and the composition trims each half
		// before joining or clamping it — this proves the two agree about
		// where whitespace ends and content begins. A previous round found
		// them disagreeing.
		return `  \t ${padding}${sentinel}  \n `;
	}

	it("PASS-THROUGH at 7,997 trimmed prose characters: prose survives whole, the structured half gets only the remainder", () => {
		const sentinel = "PROSE-END-BELOW-THRESHOLD";
		const prose = proseTrimmedTo(7997, sentinel);
		expect(prose.trim().length).toBe(7997); // precondition, not assumed

		const vars = buildShortPostVariables({
			analysisProse: prose,
			analysisData: LARGE_DATA,
			decisions: [],
			guidance: null,
		});

		expect(vars.planning_analysis.length).toBeLessThanOrEqual(
			PLANNING_ANALYSIS_CHAR_CAP + 1,
		);
		// The sentinel sits at the END of the prose on purpose: a length
		// assertion alone passes just as happily on a prose half that lost its
		// tail.
		expect(vars.planning_analysis).toContain(sentinel);
		// The structured half is present only as whatever budget the prose (plus
		// the separator) left behind — nowhere near a whole heading at this
		// prose length.
		expect(vars.planning_analysis).not.toContain("### Content types");

		expect(warn).toHaveBeenCalledTimes(1);
		const logged = warn.mock.calls[0]?.[1] as {
			proseEmitted: number;
			dataEmitted: number;
		};
		// Prose delivered WHOLE — none of its own characters were spent...
		expect(logged.proseEmitted).toBe(7997);
		// ...so the data half's contribution is only the remainder, not itself.
		expect(logged.dataEmitted).toBeLessThan(10);
	});

	it("RESERVE at 7,998 trimmed prose characters: the reserve engages and the structured half gets its floor", () => {
		const sentinel = "PROSE-END-AT-THRESHOLD";
		const prose = proseTrimmedTo(7998, sentinel);
		expect(prose.trim().length).toBe(7998); // precondition, not assumed

		const vars = buildShortPostVariables({
			analysisProse: prose,
			analysisData: LARGE_DATA,
			decisions: [],
			guidance: null,
		});

		expect(vars.planning_analysis.length).toBeLessThanOrEqual(
			PLANNING_ANALYSIS_CHAR_CAP + 1,
		);
		// The prose tail is GONE: the reserve claws its floor back from the END
		// of the prose, and the sentinel sat there.
		expect(vars.planning_analysis).not.toContain(sentinel);
		// A structured heading that needs roughly the full 2,000-character
		// reserve to reach it is present — proof the reserve actually delivered
		// content, not merely a shorter prose half.
		expect(vars.planning_analysis).toContain("### Supporting assets");
		expect(vars.planning_analysis).not.toContain("### Source signals");
	});

	it("LOGS reconcilable counters when the pass-through path truncates the data half", () => {
		// The same below-threshold path as the test above, but pushed past the
		// cap so the data half is cut — the shape an adversarial review found
		// disagreeing with its sibling paths: this path used to report the data
		// half's contribution BEFORE `clamp`'s ellipsis, so the two counters plus
		// the separator undercounted the composed block by exactly one character.
		//
		// Prose (7,000) stays comfortably under `budget` (7,998), so this is the
		// pass-through branch, not the reserve.
		const prose = "p".repeat(7000);
		// Flattens to 2,021 characters — enough that prose (7,000) + separator
		// (2) + data (2,021) = 9,023 overruns the 8,000 cap.
		const data: AnalysisData = {
			contentTypes: {
				recommended: [
					{ type: "x".repeat(1900), rationale: "y".repeat(50) },
				],
			},
		};

		const vars = buildShortPostVariables({
			analysisProse: prose,
			analysisData: data,
			decisions: [],
			guidance: null,
		});

		// Precondition: this run actually truncated the data half, or the
		// invariant below would hold vacuously.
		expect(vars.planning_analysis.length).toBe(
			PLANNING_ANALYSIS_CHAR_CAP + 1,
		);

		expect(warn).toHaveBeenCalledTimes(1);
		const logged = warn.mock.calls[0]?.[1] as {
			proseEmitted: number;
			dataEmitted: number;
		};

		// THE INVARIANT every `warnAnalysisTruncated` caller must satisfy: the two
		// `*Emitted` counters plus the separator between them must add back up to
		// the composed block's actual length — the ellipsis `clamp` appends to
		// the truncated half included. A reader who cannot reconcile the halves
		// against the emitted total has a log that looks authoritative and is
		// not, which is worse than no log.
		const separatorLength = 2; // composeAnalysisBlock's `separator` is "\n\n".
		expect(logged.proseEmitted + separatorLength + logged.dataEmitted).toBe(
			vars.planning_analysis.length,
		);
	});

	it("keeps the structured half when the prose alone exceeds the budget", () => {
		// Fizzy #1851 slice 2's precondition. Before this, the composed block
		// was clamped with prose FIRST and truncated from the end, so a prose
		// body past the cap deleted every structured section from the model
		// input — silently, for all four generators. An AI assistant that can
		// emit 8,000 characters in one accepted click makes that reachable.
		const vars = buildShortPostVariables({
			analysisProse: "z".repeat(9000),
			analysisData: {
				contentTypes: { recommended: [{ type: "Tweet" }] },
			},
			decisions: [],
			guidance: null,
		});

		// `humanizeKey("contentTypes")` is "Content types", and
		// `flattenPlanningAnalysis` emits it as a level-3 heading. There is no
		// `contentTypes` VARIABLE to assert — the block lives inside the
		// `planning_analysis` string.
		expect(vars.planning_analysis).toContain("### Content types");
	});

	it("does not let whitespace INSIDE the prose delete the structured half", () => {
		// The threshold measures `analysisProse.trim().length`, so 200
		// characters of prose followed by 9,000 spaces takes the
		// below-threshold branch — 200 is nowhere near the budget. While that
		// branch joined the two halves UNTRIMMED, `clamp` (which trims only the
		// OUTER ends of the string it is handed) then spent the entire budget
		// on interior whitespace and deleted the structured half outright: the
		// exact defect this composition exists to prevent, reached through the
		// one path the reserve never sees. The warn made that worse rather than
		// visible: it reported a 200-character prose half against a cap of
		// 8,000 and zero structured characters emitted — numbers no reader can
		// reconcile, because the 9,000 characters actually spent appear in
		// neither.
		const vars = buildShortPostVariables({
			analysisProse: `${"z".repeat(200)}${" ".repeat(9000)}`,
			analysisData: LARGE_DATA,
			decisions: [],
			guidance: null,
		});

		expect(vars.planning_analysis).toContain("### Content types");
		expect(vars.planning_analysis.length).toBeLessThanOrEqual(
			PLANNING_ANALYSIS_CHAR_CAP + 1,
		);
		// 200 + 2 + 4,166 is comfortably inside the budget, so nothing was
		// truncated and nothing should be reported. Before the trim this warned.
		expect(warn).not.toHaveBeenCalled();
	});

	it("LOGS the truncation when only one half is present", () => {
		// The likeliest production shape of the regime this whole composition
		// was written for — an AI-written prose half against a topic carrying
		// no structured analysis — and it took the one path that clamped
		// without saying so, which is what the changeset promises it does not.
		const vars = buildShortPostVariables({
			analysisProse: "z".repeat(20_000),
			analysisData: {},
			decisions: [],
			guidance: null,
		});

		expect(vars.planning_analysis.length).toBe(
			PLANNING_ANALYSIS_CHAR_CAP + 1,
		);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn.mock.calls[0]?.[1]).toEqual({
			proseChars: 20_000,
			proseEmitted: PLANNING_ANALYSIS_CHAR_CAP + 1,
			dataChars: 0,
			dataEmitted: 0,
			cap: PLANNING_ANALYSIS_CHAR_CAP,
		});
		// THE INVARIANT, algebraically: with no surviving half and no separator,
		// `proseEmitted` alone must equal the composed block's length.
		expect(warn.mock.calls[0]?.[1]?.proseEmitted).toBe(
			vars.planning_analysis.length,
		);
	});

	it("stays SILENT when the single half fits", () => {
		// The negative control for the case above. A warn that fires whenever
		// one half is present reports a budget event on the common path, and an
		// operator learns to ignore the line that matters.
		buildShortPostVariables({
			analysisProse: "Just prose.",
			analysisData: {},
			decisions: [],
			guidance: null,
		});

		expect(warn).not.toHaveBeenCalled();
	});
});

describe("buildShortPostLockedClauses", () => {
	it("states the option count the schema enforces", () => {
		const clauses = buildShortPostLockedClauses();
		expect(clauses).toContain(String(SHORT_POST_OPTION_COUNT));
	});

	it("asks for distinct labels, which the schema cannot ask for", () => {
		// `generateObject` converts the schema to JSON Schema, which has no way to
		// express uniqueness across array elements — so the model never sees the
		// refinement that will reject its output. Without this clause the rule
		// exists only as a rejection, and a run fails for a reason it was never
		// told about.
		const clauses = buildShortPostLockedClauses();
		expect(clauses).toMatch(/label must be DIFFERENT/i);
	});

	it("carries the approval rules FR28/FR29 turn on", () => {
		// These have no schema to catch them: a draft asserting an unapproved
		// customer name parses perfectly and persists as READY. Code-side is the
		// only place they hold.
		const clauses = buildShortPostLockedClauses();
		expect(clauses).toMatch(/customer name/i);
		expect(clauses).toMatch(/screenshot/i);
		expect(clauses).toMatch(/metric/i);
	});

	it("names the specific unresolved approvals when there are any", () => {
		const clauses = buildShortPostLockedClauses([
			"Acme Corp",
			"the latency chart",
		]);
		expect(clauses).toContain("Acme Corp");
		expect(clauses).toContain("the latency chart");
		expect(clauses).toMatch(/NOT approved/);
	});

	it("omits the restrictions block entirely when nothing is unresolved", () => {
		// A heading saying "the following are not approved" over an empty list
		// reads as a system that has lost track of its own state.
		const clauses = buildShortPostLockedClauses([]);
		expect(clauses).not.toMatch(/Unresolved approvals/);
	});

	it("ignores blank subjects rather than emitting an empty bullet", () => {
		const clauses = buildShortPostLockedClauses(["  ", ""]);
		expect(clauses).not.toMatch(/Unresolved approvals/);
	});
});

describe("composeShortPostPrompt", () => {
	const base = {
		topic: TOPIC,
		context: EMPTY_CONTEXT,
		analysisProse: "",
		analysisData: {},
		decisions: [],
		guidance: null,
		restrictedSubjects: [],
	};

	it("renders the bound body and appends the locked clauses", async () => {
		const composed = await composeShortPostPrompt({
			...base,
			templateBody: "Write about {{{topic_title}}}.",
			format: "HANDLEBARS",
		});
		expect(composed.prompt).toContain("Faster incremental builds");
		expect(composed.prompt).toMatch(/Rules that override anything above/);
		expect(composed.formatOverridden).toBe(false);
		expect(composed.bodyRecovered).toBe(false);
	});

	it("GUARD 1: renders a MARKDOWN-format body as Handlebars anyway", async () => {
		// MARKDOWN does no templating at all and returns the body verbatim with
		// NO error set. For a prompt whose entire context arrives as variables,
		// that silently ships zero topic data and the model writes about nothing
		// in particular while sounding fine doing it.
		const composed = await composeShortPostPrompt({
			...base,
			templateBody: "Write about {{{topic_title}}}.",
			format: "MARKDOWN",
		});
		expect(composed.formatOverridden).toBe(true);
		expect(composed.prompt).toContain("Faster incremental builds");
	});

	it("GUARD 2: recovers when the body did not render", async () => {
		// A parse error is swallowed into a raw-body return, so the tell is an
		// unrendered construct surviving into the output.
		const composed = await composeShortPostPrompt({
			...base,
			templateBody: "Write about {{#if unclosed}}{{{topic_title}}}",
			format: "HANDLEBARS",
		});
		expect(composed.bodyRecovered).toBe(true);
		expect(composed.prompt).toContain("Faster incremental builds");
	});

	it("GUARD 3: recovers when the body renders to nothing", async () => {
		// `{{#unknown}}x{{/unknown}}` is a falsy block, not a syntax error: it
		// parses, renders to "", and guard 2 cannot see it precisely because
		// nothing survived. Without this the model would get only the locked
		// clauses — no instructions and no topic — and still emit three plausible
		// posts that persist as READY.
		const composed = await composeShortPostPrompt({
			...base,
			templateBody: "{{#nope}}anything{{/nope}}",
			format: "HANDLEBARS",
		});
		expect(composed.bodyRecovered).toBe(true);
		expect(composed.prompt).toContain("Faster incremental builds");
	});

	it("passes the restricted subjects through to the locked clauses", async () => {
		const composed = await composeShortPostPrompt({
			...base,
			templateBody: "Write about {{{topic_title}}}.",
			format: "HANDLEBARS",
			restrictedSubjects: ["Acme Corp"],
		});
		// The tab tells the reader these will be generalized rather than
		// asserted. This is the half that makes that true.
		expect(composed.prompt).toContain("Acme Corp");
	});

	it("says plainly when there is no source context at all", async () => {
		const composed = await composeShortPostPrompt({
			...base,
			templateBody:
				"{{#unless has_any_source_context}}NOTHING{{/unless}}",
			format: "HANDLEBARS",
		});
		expect(composed.prompt).toContain("NOTHING");
	});
});
