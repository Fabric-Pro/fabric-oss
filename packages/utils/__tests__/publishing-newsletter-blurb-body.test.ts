import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
	AUDIENCE_LABELS,
	BaseNewsletterBlurbSchema,
	CTA_STATE_LABELS,
	composeNewsletterBlurbExport,
	composeNewsletterBlurbWorkingDraftBody,
	NEWSLETTER_BLURB_BODY_MAX,
	type NewsletterBlurbDocument,
	PublishingNewsletterBlurbSchema,
	RELEASE_STATUS_LABELS,
} from "../lib/publishing-newsletter-blurb-body";
// Relative import: this test lives in packages/utils/__tests__, and
// `@repo/utils` does not self-link inside its own package.
import { PUBLISHING_NEWSLETTER_BLURB_FALLBACK_BODY } from "../lib/publishing-newsletter-blurb-prompt";
import { CURRENT_DRAFT_CHAR_CAP } from "../lib/publishing-refinement";

/** The declared values of each enum, read from the schema rather than retyped. */
const releaseStatusValues =
	BaseNewsletterBlurbSchema.shape.releaseStatus.unwrap().options;
const audienceValues =
	BaseNewsletterBlurbSchema.shape.audience.unwrap().options;
const ctaStateValues =
	BaseNewsletterBlurbSchema.shape.ctaState.unwrap().options;

describe("PublishingNewsletterBlurbSchema", () => {
	it("accepts a document with every non-PO-sectioned field omitted", () => {
		// spec §6.1: an org that trims the authored releaseStatus / audience /
		// ctaState / safetyNote paragraphs out of its prompt must lose
		// information, never availability. If any of these were required, that
		// edit would brick the content type permanently with no retry path.
		const parsed = PublishingNewsletterBlurbSchema.safeParse({
			headline: "A quiet week for the ingest pipeline",
			blurb: "x".repeat(120),
		});
		expect(parsed.success).toBe(true);
		expect(parsed.data?.releaseStatus).toBe("UNCONFIRMED");
		expect(parsed.data?.audience).toBe("UNSPECIFIED");
		expect(parsed.data?.ctaState).toBe("UNKNOWN");
		expect(parsed.data?.suggestedCta).toBeNull();
		expect(parsed.data?.safetyNote).toBeNull();
		expect(parsed.data?.inputsNeeded).toEqual([]);
		expect(parsed.data?.suggestedAssets).toEqual({
			confirmed: [],
			needsConfirmation: [],
		});
	});

	it("rejects a whitespace-only headline rather than storing one", () => {
		// spec §5.3, measured in 2C: `min(1)` without `trim()` lets a blank title
		// through, the run SUCCEEDS, it seeds a working draft with an empty
		// heading, every downstream reader narrows the document to null, and
		// adopt then throws forever on a draft the server wrote.
		expect(
			PublishingNewsletterBlurbSchema.safeParse({
				headline: "   ",
				blurb: "x".repeat(120),
			}).success,
		).toBe(false);
	});

	// One local helper, so the length cases read as the single field they are
	// about rather than as a full document each time.
	const base = (overrides: Record<string, unknown>) =>
		PublishingNewsletterBlurbSchema.safeParse({
			headline: "Ingest retries",
			blurb: "x".repeat(120),
			...overrides,
		});

	it("rejects a blurb under the 40-character floor but accepts a one-sentence blurb", () => {
		// spec §5.2: the floor is 40, not 120. FR10-FR13 give the user a
		// 2,000-character guidance box wired into this prompt, and the prompt's
		// own Length Guidance opens "Use the user's requested length if
		// provided." A user asking for "one sentence, for the standup digest"
		// gets a ~70-character blurb exactly as instructed; a 120 floor rejects
		// it as a hard non-retryable failure blaming generation.
		expect(base({ blurb: "TBD" }).success).toBe(false);
		expect(base({ blurb: "[blurb TBD]" }).success).toBe(false);
		expect(
			base({
				blurb: "Ingest now retries a failed batch twice before paging.",
			}).success,
		).toBe(true);
	});

	it("rejects a blurb over its declared maximum", () => {
		// The other end of the same bound. Without this the max is unpinned and
		// a later widening of `blurb` — the exact edit the composed-maximum
		// guard below exists to catch — would leave no test naming the value.
		expect(base({ blurb: "x".repeat(4001) }).success).toBe(false);
		expect(base({ blurb: "x".repeat(4000) }).success).toBe(true);
	});

	it("carries the seven release values and six audience values of its own prompt", () => {
		// NOT the family's five, and NOT Webinar's six: PILOT and UPCOMING
		// exist because this type's PO prompt hands the model "in pilot" and
		// "coming soon", and CONCEPT does not because this prompt never offers
		// it. A phrasing the prompt suggests with no home in the enum is the
		// model being invited into a value the schema will reject.
		expect(
			BaseNewsletterBlurbSchema.shape.releaseStatus.unwrap().options,
		).toEqual([
			"SHIPPED",
			"IN_PROGRESS",
			"PLANNED",
			"PREVIEW",
			"PILOT",
			"UPCOMING",
			"UNCONFIRMED",
		]);
		expect(
			BaseNewsletterBlurbSchema.shape.audience.unwrap().options,
		).toEqual([
			"INTERNAL",
			"CUSTOMER",
			"PARTNER",
			"COMMUNITY",
			"EXTERNAL",
			"UNSPECIFIED",
		]);
	});
});

describe("ctaState reconciliation", () => {
	// Reconciled by transform, never rejected (spec §5.2). `ctaState` has no
	// PO-prompt section, so its value comes only from text we author, while the
	// PO skeleton actively asks the model for a CTA string. The likeliest
	// output is therefore a CTA with `ctaState` absent — which defaults to
	// UNKNOWN, the one combination a `PRESENT ⇒ non-null` refinement would
	// reject, at three COMPLEX-tier model calls a time.
	//
	// The transform is TOTAL, so all six inputs are pinned here rather than the
	// spec's three clauses, and as a table so a later reader sees the totality
	// rather than three examples.
	it.each([
		// [ctaState in, suggestedCta in, ctaState out]
		["PRESENT", "Read the changelog", "PRESENT"],
		["PRESENT", null, "UNKNOWN"],
		["UNKNOWN", "Read the changelog", "PRESENT"],
		["UNKNOWN", null, "UNKNOWN"],
		["OMITTED", null, "OMITTED"],
		// A stated OMITTED that still carries a CTA is contradicted by its own
		// payload; the value is the harder evidence, so the state follows it.
		["OMITTED", "Read the changelog", "PRESENT"],
	])("reconciles ctaState %s with cta %s to %s", (state, cta, expected) => {
		const parsed = PublishingNewsletterBlurbSchema.parse({
			headline: "Ingest retries",
			blurb: "x".repeat(120),
			ctaState: state,
			suggestedCta: cta,
		});
		expect(parsed.ctaState).toBe(expected);
	});

	it("treats a whitespace-only CTA as no CTA at all", () => {
		// `.trim()` runs before the transform, so "   " arrives as "". An
		// emptiness test that only checked for null would call that a PRESENT
		// CTA and the working draft would emit a bare "Suggested call to
		// action" heading with nothing under it.
		const parsed = PublishingNewsletterBlurbSchema.parse({
			headline: "Ingest retries",
			blurb: "x".repeat(120),
			ctaState: "PRESENT",
			suggestedCta: "   ",
		});
		expect(parsed.ctaState).toBe("UNKNOWN");
		// The state alone is not enough: the transform must also normalize the
		// value itself, or the document keeps a whitespace-derived "" alongside
		// the reconciled state — two representations of "no call to action"
		// that a `!== null` reader downstream cannot tell apart.
		expect(parsed.suggestedCta).toBeNull();
	});

	it("treats a whitespace-only safety note as no safety note at all", () => {
		// Same trim boundary as suggestedCta above, on the sibling nullable
		// field. A "" surviving here reads as a real note to a `!== null`
		// consumer even though the export's own truthiness check renders it
		// identically to a real null.
		const parsed = PublishingNewsletterBlurbSchema.parse({
			headline: "Ingest retries",
			blurb: "x".repeat(120),
			safetyNote: "   ",
		});
		expect(parsed.safetyNote).toBeNull();
	});
});

const SAMPLE = {
	headline: "Ingest retries a failed batch before paging",
	blurb: "Ingest now retries a failed batch twice before it pages anyone, so a single flaky upstream call no longer wakes the on-call engineer.",
};

const parseSample = (overrides: Record<string, unknown> = {}) =>
	PublishingNewsletterBlurbSchema.parse({ ...SAMPLE, ...overrides });

describe("composeNewsletterBlurbWorkingDraftBody", () => {
	it("carries the headline, the blurb and a PRESENT call to action", () => {
		const draft = composeNewsletterBlurbWorkingDraftBody(
			parseSample({
				ctaState: "PRESENT",
				suggestedCta: "Read the changelog entry.",
			}),
		);
		expect(draft).toContain(
			"# Ingest retries a failed batch before paging",
		);
		expect(draft).toContain("no longer wakes the on-call engineer");
		expect(draft).toContain("Read the changelog entry.");
	});

	it("omits the call to action entirely when it is UNKNOWN or OMITTED", () => {
		// An UNKNOWN CTA has no text to carry and an OMITTED one is a decision,
		// not a gap — either one rendered is a heading the author deletes before
		// every send, or a bare heading with nothing under it.
		for (const state of ["UNKNOWN", "OMITTED"] as const) {
			const draft = composeNewsletterBlurbWorkingDraftBody(
				parseSample({ ctaState: state, suggestedCta: null }),
			);
			expect(draft).not.toContain("Suggested call to action");
		}

		// A hand-built document, bypassing the schema's reconciler, so a
		// stated OMITTED that still carries CTA text reaches the composer
		// itself rather than being normalized away before this guard ever
		// runs. The exported `NewsletterBlurbDocument` type permits this
		// shape and Tasks 6 / 9 could construct it without re-parsing.
		const contradictory = {
			...parseSample(),
			ctaState: "OMITTED",
			suggestedCta: "Read the changelog.",
		} as NewsletterBlurbDocument;
		expect(
			composeNewsletterBlurbWorkingDraftBody(contradictory),
		).not.toContain("Suggested call to action");
	});

	it("keeps every advice field out of the draft", () => {
		// spec §5.5: releaseStatus, audience, ctaState, suggestedAssets,
		// inputsNeeded and safetyNote are advice ABOUT the draft; the export
		// below is what adds them back.
		const draft = composeNewsletterBlurbWorkingDraftBody(
			parseSample({
				releaseStatus: "PILOT",
				audience: "CUSTOMER",
				suggestedAssets: {
					confirmed: ["Dashboard screenshot"],
					needsConfirmation: ["Partner logo"],
				},
				inputsNeeded: ["A link to the changelog entry"],
				safetyNote: "Generalized the reader's industry.",
			}),
		);
		expect(draft).not.toContain("Release status");
		expect(draft).not.toContain("Audience");
		expect(draft).not.toContain("Dashboard screenshot");
		expect(draft).not.toContain("Partner logo");
		expect(draft).not.toContain("A link to the changelog entry");
		expect(draft).not.toContain("Generalized the reader's industry.");
	});
});

describe("composeNewsletterBlurbExport", () => {
	it("states the release, audience and call-to-action caveats humanized, never as bare enum literals", () => {
		// The export is the one surface meant to leave Fabric and be read
		// standalone, without the panel's caveats beside it — so a bare
		// "UNCONFIRMED" would read as Fabric's own finding rather than as a
		// claim the reader is the one who can confirm.
		const exported = composeNewsletterBlurbExport(parseSample(), {});
		expect(exported).not.toContain("**Release status:** UNCONFIRMED");
		expect(exported).not.toContain("**Audience:** UNSPECIFIED");
		expect(exported).not.toContain("**Call to action:** UNKNOWN");
		expect(exported).toContain(RELEASE_STATUS_LABELS.UNCONFIRMED);
		expect(exported).toContain(AUDIENCE_LABELS.UNSPECIFIED);
		expect(exported).toContain(CTA_STATE_LABELS.UNKNOWN);
	});

	it("renders every value of all three label maps from the same maps the panel reads", () => {
		// Every value exercised, not a sample: a value that renders one way on
		// screen and another in a downloaded file is a document that disagrees
		// with the product it came from, and a reader holding only the file
		// cannot tell which one is Fabric's actual finding.
		for (const status of releaseStatusValues) {
			expect(
				composeNewsletterBlurbExport(
					parseSample({ releaseStatus: status }),
					{},
				),
			).toContain(RELEASE_STATUS_LABELS[status]);
		}
		for (const audience of audienceValues) {
			expect(
				composeNewsletterBlurbExport(parseSample({ audience }), {}),
			).toContain(AUDIENCE_LABELS[audience]);
		}
		// PRESENT needs a value attached: the reconciler derives the state from
		// the payload rather than trusting the claim, so a PRESENT with no CTA
		// would arrive here as UNKNOWN and the assertion would pin the wrong
		// label.
		expect(
			composeNewsletterBlurbExport(
				parseSample({
					ctaState: "PRESENT",
					suggestedCta: "Read the changelog.",
				}),
				{},
			),
		).toContain(CTA_STATE_LABELS.PRESENT);
		expect(
			composeNewsletterBlurbExport(
				parseSample({ ctaState: "UNKNOWN" }),
				{},
			),
		).toContain(CTA_STATE_LABELS.UNKNOWN);
		expect(
			composeNewsletterBlurbExport(
				parseSample({ ctaState: "OMITTED" }),
				{},
			),
		).toContain(CTA_STATE_LABELS.OMITTED);
	});

	it("carries the advice fields the working draft omits", () => {
		const doc = parseSample({
			suggestedAssets: {
				confirmed: ["Dashboard screenshot"],
				needsConfirmation: ["Partner logo"],
			},
			inputsNeeded: ["A link to the changelog entry"],
			safetyNote: "Generalized the reader's industry.",
		});
		const draft = composeNewsletterBlurbWorkingDraftBody(doc);
		const exported = composeNewsletterBlurbExport(doc, {});

		expect(exported).toContain("Dashboard screenshot");
		expect(exported).toContain("Partner logo");
		expect(exported).toContain("A link to the changelog entry");
		expect(exported).toContain("Generalized the reader's industry.");

		// The working draft's own content still has to survive intact inside the
		// export — this is an addition, not a rewrite.
		expect(exported).toContain(doc.blurb);
		expect(exported).toContain(draft.split("\n\n")[0] as string);
	});

	it("carries every working-draft section into the export, including a PRESENT call to action", () => {
		// The fixture above (and the label-map test before it) never exercises a
		// PRESENT call to action here: SAMPLE alone reconciles to UNKNOWN, so the
		// working draft it feeds into the export is just [heading, blurb] — no
		// test pins the export against a draft that actually has a third
		// section. Replacing the composer's `...rest` with `doc.blurb` passes
		// every other case in this file while dropping the CTA section from
		// every PRESENT export.
		const doc = parseSample({
			ctaState: "PRESENT",
			suggestedCta: "Read the changelog entry.",
		});
		const draft = composeNewsletterBlurbWorkingDraftBody(doc);
		const exported = composeNewsletterBlurbExport(doc, {});

		const sections = draft.split("\n\n");
		// The loop's precondition, asserted separately: a draft that collapsed to
		// one block would make every iteration below vacuous rather than failing.
		expect(sections.length).toBeGreaterThanOrEqual(4);
		for (const section of sections) {
			expect(exported).toContain(section);
		}
		expect(exported).toContain("## Suggested call to action");
		expect(exported).toContain("Read the changelog entry.");
	});

	it("attributes an asset move to Fabric, distinct from the model's own caution", () => {
		const exported = composeNewsletterBlurbExport(
			parseSample({
				suggestedAssets: {
					confirmed: ["Dashboard screenshot"],
					needsConfirmation: [
						"Recorded walkthrough",
						"Latency chart",
					],
				},
			}),
			{
				assets: ["Recorded walkthrough", "Latency chart"],
				assetKinds: {
					"Recorded walkthrough": "ASSET_APPROVAL",
					"Latency chart": "ASSET_APPROVAL",
				},
			},
		);
		// Both assertions above are substrings of the ONE constant that renders
		// this line, so together they only prove the constant was emitted — not
		// that the asset names it is supposed to attribute actually appear on
		// it. Find the attribution line itself and assert the names on it.
		const attribution = exported
			.split("\n")
			.find((line) => line.includes("naming them:"));
		expect(attribution).toBeDefined();
		expect(attribution).toContain("Recorded walkthrough");
		expect(attribution).toContain("Latency chart");
	});

	it("renders every list's empty-state fallback rather than a bare heading", () => {
		const exported = composeNewsletterBlurbExport(parseSample(), {});
		expect(exported).not.toContain("Moved out of");
		expect(exported).toContain("_None confirmed_");
		expect(exported).toContain("_None_");
		expect(exported).toContain("_Nothing outstanding_");
		expect(exported).toContain("_None._");
	});

	it("builds the heading from the headline directly, even when it spans multiple lines", () => {
		// `headline` has no single-line constraint, so an export that recovered
		// its heading by splitting the composed draft on "\n\n" would splice the
		// remainder in among the caveat lines instead of failing loudly.
		const multiLineHeadline = "Ingest retries\n\nA deeper look";
		const exported = composeNewsletterBlurbExport(
			parseSample({ headline: multiLineHeadline }),
			{},
		);
		expect(
			exported.startsWith(
				`# ${multiLineHeadline}\n\n**Release status:**`,
			),
		).toBe(true);
	});
});

// =============================================================================
// The prompt body's vocabulary, pinned against the enums
// =============================================================================
//
// Spec §6.1 prescribes this, and it is the only thing that keeps the two in
// step. The source prompt for this content type is a card attachment that does
// not exist in this repository — §6.1 says so outright — so the release,
// audience and call-to-action vocabularies have no citable grounding. Its
// remedy: the fallback body lands first, and the vocabulary claim becomes a
// TEST rather than a citation.

/**
 * The heading each authored vocabulary paragraph opens with, and the heading
 * that follows it, used as the extractor's delimiters.
 *
 * Anchored on the prompt's OWN heading text rather than on a regex over the
 * whole body: a reverse check whose extractor silently finds nothing passes
 * vacuously, and a bare `/^- ([A-Z_]+)/gm` sweep over the entire prompt would
 * also catch bullets from Writing rules and Style that are not vocabulary at
 * all.
 */
const VOCABULARY_SECTIONS = {
	releaseStatus: { open: "## Release status", close: "## Audience" },
	audience: { open: "## Audience", close: "## Call to action" },
	ctaState: { open: "## Call to action", close: "## Style" },
} as const;

/**
 * The enum words one authored paragraph of the prompt body OFFERS the model.
 *
 * THROWS rather than returning `[]` when either anchor is gone or the paragraph
 * carries no bullets at all — the same rule
 * `publishing-post-types.test.ts:118-122` applies to the suggestion prompt's
 * whitelist, and for the same reason: an extractor that silently finds nothing
 * makes the reverse assertion below trivially true, which is the failure mode
 * this plan has already hit twice.
 */
function enumWordsOfferedBy(
	body: string,
	section: keyof typeof VOCABULARY_SECTIONS,
): string[] {
	const { open, close } = VOCABULARY_SECTIONS[section];
	const start = body.indexOf(open);
	const end = body.indexOf(close, start + open.length);
	if (start === -1 || end === -1) {
		throw new Error(
			`The Newsletter Blurb prompt's "${section}" paragraph is no longer delimited by "${open}" … "${close}" as this test expects — re-read the paragraph before changing these anchors`,
		);
	}
	const words = [
		...body
			.slice(start + open.length, end)
			.matchAll(/^- ([A-Z][A-Z_]*) —/gm),
	].map((m) => m[1] as string);
	if (words.length === 0) {
		throw new Error(
			`The Newsletter Blurb prompt's "${section}" paragraph offers no "- VALUE —" bullets — the extractor found its anchors but nothing to check, which would pass this test vacuously`,
		);
	}
	return words;
}

describe("the prompt body and the schema name the same vocabulary", () => {
	it("names every schema value's phrasing in the prompt body", () => {
		// Forward: a value the schema accepts that the prompt never mentions is
		// a value the model is never invited to produce. Subsumed by the set
		// equality assertions below for duplication/omission/renames; kept as
		// a cheap whole-file canary.
		for (const value of releaseStatusValues) {
			expect(PUBLISHING_NEWSLETTER_BLURB_FALLBACK_BODY).toContain(value);
		}
		for (const value of audienceValues) {
			expect(PUBLISHING_NEWSLETTER_BLURB_FALLBACK_BODY).toContain(value);
		}
		for (const value of ctaStateValues) {
			expect(PUBLISHING_NEWSLETTER_BLURB_FALLBACK_BODY).toContain(value);
		}
	});

	it("offers no release phrasing the enum lacks", () => {
		// Reverse, and it is the half that matters: a phrasing the prompt
		// suggests with no home in the enum is the model being invited into a
		// value the schema will reject — a hard, non-retryable parse failure
		// blaming generation for following its instructions.
		const offered = enumWordsOfferedBy(
			PUBLISHING_NEWSLETTER_BLURB_FALLBACK_BODY,
			"releaseStatus",
		);
		// Set equality against the enum's own values, not count-plus-membership:
		// a bullet swapped for a duplicate of another keeps the length and every
		// extracted word inside the label map, so only comparing the two arrays
		// as sorted sets closes duplication, omission, extras and renames in one
		// assertion.
		expect([...offered].sort()).toEqual([...releaseStatusValues].sort());
		// Checks a DIFFERENT module (the label map) and is not subsumed by the
		// set-equality assertion above.
		for (const word of offered) {
			expect(RELEASE_STATUS_LABELS).toHaveProperty(word);
		}
	});

	it("offers no audience or call-to-action phrasing the enums lack", () => {
		// Same direction, over the other two authored paragraphs. Both are as
		// ungrounded as the release one — none of the three has a PO-prompt
		// section behind it.
		const audienceOffered = enumWordsOfferedBy(
			PUBLISHING_NEWSLETTER_BLURB_FALLBACK_BODY,
			"audience",
		);
		expect([...audienceOffered].sort()).toEqual([...audienceValues].sort());
		for (const word of audienceOffered) {
			expect(AUDIENCE_LABELS).toHaveProperty(word);
		}

		const ctaOffered = enumWordsOfferedBy(
			PUBLISHING_NEWSLETTER_BLURB_FALLBACK_BODY,
			"ctaState",
		);
		expect([...ctaOffered].sort()).toEqual([...ctaStateValues].sort());
		for (const word of ctaOffered) {
			expect(CTA_STATE_LABELS).toHaveProperty(word);
		}
	});

	it("throws rather than passing vacuously when an anchor is gone", () => {
		// The extractor's own negative control. Without this, "the anchors moved
		// and the extractor returned nothing" is indistinguishable from "the
		// prompt offers nothing outside the enum", and the two reverse checks
		// above would go green on a prompt nobody had actually read.
		expect(() =>
			enumWordsOfferedBy(
				"a prompt with no headings at all",
				"releaseStatus",
			),
		).toThrow(/no longer delimited/);
		expect(() =>
			enumWordsOfferedBy(
				"## Release status\n\nNo bullets here.\n\n## Audience\n",
				"releaseStatus",
			),
		).toThrow(/vacuously/);
	});
});

// =============================================================================
// The composed-maximum guard's bound-reading walker
// =============================================================================
//
// Reads zod 4.4.3's own internal check representation directly, rather than the
// v3-shaped `_def.checks[].kind` accessor: that accessor exists on a zod 4 node
// too, but resolves to empty objects and does not throw — a walker written
// against it silently finds no `max` anywhere, fills every string field with
// `""`, produces a zero-length document, and passes every assertion below green.
// THROWING on a node this walker cannot read is the guard against exactly that
// failure mode; returning `{}` or a default would recreate it.

/** A zod 4 internal node, read structurally rather than through the public API. */
type InternalNode = {
	_zod?: {
		def?: {
			type?: string;
			innerType?: InternalNode;
			element?: InternalNode;
			checks?: unknown[];
			entries?: Record<string, string>;
			shape?: Record<string, InternalNode>;
		};
	};
	shape?: Record<string, InternalNode>;
};

/** Unwrap ZodDefault / ZodNullable / ZodOptional down to the node they wrap. */
function unwrap(node: InternalNode): InternalNode {
	let current = node;
	while (current?._zod?.def?.innerType) {
		current = current._zod.def.innerType;
	}
	return current;
}

/** The node's zod-internal type tag ("string", "array", "object", "enum", …). */
function nodeType(node: InternalNode, path: string): string {
	const type = node?._zod?.def?.type;
	if (!type) {
		throw new Error(`walker: cannot read node type at "${path}"`);
	}
	return type;
}

/** The node's shape, for an object — checked via the public accessor first. */
function nodeShape(
	node: InternalNode,
	path: string,
): Record<string, InternalNode> {
	const shape = node.shape ?? node._zod?.def?.shape;
	if (!shape) {
		throw new Error(`walker: no shape readable on object at "${path}"`);
	}
	return shape;
}

/**
 * The `max_length` bound on a string or array node — the LENGTH cap for a
 * string, the ITEM-COUNT cap for an array. Throws rather than returning
 * `undefined` when no such check is present: a silent miss here is
 * indistinguishable from "this field has no maximum" and would make every
 * assertion below trivially true.
 */
function maxLength(node: InternalNode, path: string): number {
	const checks = node._zod?.def?.checks ?? [];
	for (const raw of checks) {
		const check = raw as {
			_zod?: { def?: { check?: string; maximum?: number } };
			def?: { check?: string; maximum?: number };
		};
		const def = check._zod?.def ?? check.def;
		if (def?.check === "max_length" && typeof def.maximum === "number") {
			return def.maximum;
		}
	}
	throw new Error(`walker: no max_length check found at "${path}"`);
}

/** Walk `schema` along `path`, descending through arrays via their element. */
function walkToNode(
	schema: z.ZodTypeAny,
	path: readonly string[],
): InternalNode {
	let node: InternalNode = schema as unknown as InternalNode;
	for (let i = 0; i < path.length; i++) {
		const key = path[i] as string;
		const shape = nodeShape(node, path.slice(0, i).join(".") || "$");
		if (!(key in shape)) {
			throw new Error(
				`walker: no field "${key}" at "${path.slice(0, i).join(".")}"`,
			);
		}
		node = unwrap(shape[key] as InternalNode);
		const isLast = i === path.length - 1;
		if (!isLast) {
			const type = nodeType(node, path.slice(0, i + 1).join("."));
			if (type === "array") {
				const element = node._zod?.def?.element;
				if (!element) {
					throw new Error(
						`walker: array at "${path.slice(0, i + 1).join(".")}" has no element schema`,
					);
				}
				node = unwrap(element);
			}
		}
	}
	return node;
}

/** The declared `max()` bound at `path` — a string length or an array item count. */
function declaredMaxAt(schema: z.ZodTypeAny, path: readonly string[]): number {
	const node = walkToNode(schema, path);
	const type = nodeType(node, path.join("."));
	if (type !== "string" && type !== "array") {
		throw new Error(
			`walker: node at "${path.join(".")}" is a "${type}", not a string or array`,
		);
	}
	return maxLength(node, path.join("."));
}

/** The declared enum values at `path`. */
function declaredEnumAt(
	schema: z.ZodTypeAny,
	path: readonly string[],
): string[] {
	const node = walkToNode(schema, path);
	const type = nodeType(node, path.join("."));
	if (type !== "enum") {
		throw new Error(
			`walker: node at "${path.join(".")}" is a "${type}", not an enum`,
		);
	}
	const entries = node._zod?.def?.entries;
	if (!entries) {
		throw new Error(`walker: enum at "${path.join(".")}" has no entries`);
	}
	return Object.values(entries);
}

/**
 * Read the value the maximal-document builder placed at `path`. Descends
 * through an array by reading its first element — every element the builder
 * produces is identically maximal, so any index tells the same story.
 */
function valueAt(doc: unknown, path: readonly string[]): unknown {
	let node = doc;
	for (const key of path) {
		if (node === null || node === undefined) {
			throw new Error(`valueAt: nothing to read "${key}" from`);
		}
		if (Array.isArray(node)) {
			if (node.length === 0) {
				throw new Error(
					`valueAt: array is empty, cannot read "${key}"`,
				);
			}
			node = (node[0] as Record<string, unknown>)[key];
		} else {
			node = (node as Record<string, unknown>)[key];
		}
	}
	return node;
}

/** Build a single maximally-sized value for one schema node. */
function buildMaximalValue(rawNode: InternalNode, path: string): unknown {
	const node = unwrap(rawNode);
	const type = nodeType(node, path);
	switch (type) {
		case "string":
			return "x".repeat(maxLength(node, path));
		case "enum": {
			const entries = node._zod?.def?.entries;
			if (!entries) {
				throw new Error(`walker: enum at "${path}" has no entries`);
			}
			const values = Object.values(entries);
			if (values.length === 0) {
				throw new Error(`walker: enum at "${path}" has no values`);
			}
			return values[0];
		}
		case "array": {
			const element = node._zod?.def?.element;
			if (!element) {
				throw new Error(
					`walker: array at "${path}" has no element schema`,
				);
			}
			const count = maxLength(node, path);
			return Array.from({ length: count }, (_, i) =>
				buildMaximalValue(element, `${path}[${i}]`),
			);
		}
		case "object": {
			const shape = nodeShape(node, path);
			const result: Record<string, unknown> = {};
			for (const key of Object.keys(shape)) {
				result[key] = buildMaximalValue(
					shape[key] as InternalNode,
					`${path}.${key}`,
				);
			}
			return result;
		}
		default:
			throw new Error(
				`walker: unhandled node type "${type}" at "${path}"`,
			);
	}
}

/** Build a document with every leaf filled to its declared maximum. */
function buildMaximalDocumentFromSchema(
	schema: z.ZodTypeAny,
): Record<string, unknown> {
	return buildMaximalValue(schema as unknown as InternalNode, "$") as Record<
		string,
		unknown
	>;
}

/** Every scalar string leaf the walker must visit, schema field order. */
const EXPECTED_STRING_LEAVES: readonly (readonly string[])[] = [
	["headline"],
	["blurb"],
	["suggestedCta"],
	["safetyNote"],
];

/** Every enum leaf the walker must visit. */
const EXPECTED_ENUM_LEAVES: readonly (readonly string[])[] = [
	["ctaState"],
	["audience"],
	["releaseStatus"],
];

/** Every array leaf the walker must visit, as [path, declared maxItems]. */
const EXPECTED_ARRAY_LEAVES: readonly (readonly [readonly string[], number])[] =
	[
		[["suggestedAssets", "confirmed"], 8],
		[["suggestedAssets", "needsConfirmation"], 8],
		[["inputsNeeded"], 8],
	];

describe("the composed working draft fits the caps it will meet", () => {
	// Derived from the schema, never hand-written: a fixture does not grow when
	// someone later raises `blurb` from 4000, so a hand-written one would stay
	// green while the real maximum moved past the cap — which is exactly what
	// this guard exists to prevent.
	//
	// Walk the BASE object, not the exported schema. `.transform()` in zod 4
	// returns a ZodPipe, which has no `.shape`, so handing the walker
	// `PublishingNewsletterBlurbSchema` gives it nothing to traverse. The base
	// is also what the model actually sees: generateObject builds its JSON
	// schema with `io: "input"`, so the transform is invisible there too.
	const maximal = buildMaximalDocumentFromSchema(BaseNewsletterBlurbSchema);

	it("reads a bound it can be checked against", () => {
		// Self-test the reader before trusting it anywhere else. A declaredMaxAt
		// that always returned 0 would make every assertion below trivially
		// true.
		expect(declaredMaxAt(BaseNewsletterBlurbSchema, ["headline"])).toBe(
			200,
		);
		expect(declaredMaxAt(BaseNewsletterBlurbSchema, ["blurb"])).toBe(4000);
		expect(
			declaredMaxAt(BaseNewsletterBlurbSchema, [
				"suggestedAssets",
				"needsConfirmation",
			]),
		).toBe(8);
	});

	it("visits every leaf the walker should have visited", () => {
		// Asserted over the SCHEMA's key set, not the generated object: a walker
		// that stops seeing `blurb` emits no string for it, so iterating the
		// GENERATED object would find nothing to check and pass green while the
		// composed total silently dropped 4,000 characters.
		for (const path of EXPECTED_STRING_LEAVES) {
			expect(valueAt(maximal, path)).toHaveLength(
				declaredMaxAt(BaseNewsletterBlurbSchema, path),
			);
		}
		for (const path of EXPECTED_ENUM_LEAVES) {
			expect(declaredEnumAt(BaseNewsletterBlurbSchema, path)).toContain(
				valueAt(maximal, path),
			);
		}
		for (const [path, maxItems] of EXPECTED_ARRAY_LEAVES) {
			// Arrays get their own assertion: `String(inputsNeeded)` is a
			// comma-joined 2,407-character value matching neither the element
			// bound (300) nor the array bound (8).
			expect(valueAt(maximal, path)).toHaveLength(maxItems);
		}
	});

	it("is a genuinely maximal document, not a shrunken one", () => {
		// Spec §11.5's total-length floor, and the ONLY assertion that binds in
		// the "schema grew, constant did not" direction. Without it, a walker
		// that returned {} would yield an empty leaf set, a zero-length body,
		// and green cases either side of it.
		expect(JSON.stringify(maximal).length).toBeGreaterThan(11_000);
	});

	it("stays under both caps with real headroom", () => {
		// Two bounds, deliberately, because they can diverge:
		// CURRENT_DRAFT_CHAR_CAP is 40,000 and shared across every shipped
		// content type, while NEWSLETTER_BLURB_BODY_MAX is this type's own
		// 24,000. Today the second binds and the first cannot fail.
		//
		// Say plainly what this guard is worth here: Newsletter's maximal
		// working draft is roughly 4,600 characters against 24,000, so unlike
		// the Webinar Script's — where the same assertion caught a
		// 69,940-character composition — this one cannot fail today. Its value
		// is entirely prospective: it goes red the moment someone raises
		// `blurb`'s max toward the cap. A headroom failure here is fixed by
		// LOWERING `blurb`'s max, never by lowering the 2,000 floor and never by
		// raising a shared cap.
		const body = composeNewsletterBlurbWorkingDraftBody(
			maximal as unknown as NewsletterBlurbDocument,
		);
		expect(body.length).toBeLessThan(CURRENT_DRAFT_CHAR_CAP - 2_000);
		// The named constant, not a literal 24000 — the two are equal today, and
		// a hardcoded copy could not notice if they ever diverged.
		expect(body.length).toBeLessThan(NEWSLETTER_BLURB_BODY_MAX - 2_000);
	});

	it("pins the body cap the spec fixes at 24,000", () => {
		// Not a restatement of the headroom assertions above: those are relative
		// to this constant and stay green if it moves. This one is the constant
		// itself. A blurb is shorter than a stakeholder email; 40,000 is the
		// webinar script's number and adopting it here would be the regression.
		expect(NEWSLETTER_BLURB_BODY_MAX).toBe(24_000);
	});
});
