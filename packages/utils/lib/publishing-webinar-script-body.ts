/**
 * The Webinar / Demo Script output schema and its two composers (Fizzy #1988,
 * Phase 2D slice 1).
 *
 * A module in the shared leaf package, for the same measured reason its Case
 * Study and Stakeholder Email siblings are: `@repo/temporal` seeds a draft when
 * a generation succeeds and `@repo/api` re-composes the same text when a stored
 * version is adopted, and one shared function makes those two copies drifting
 * apart impossible rather than merely catchable by a parity test after the
 * fact. This module additionally OWNS the schema itself, because — unlike
 * those two siblings, whose output schema lives beside the Temporal prompt
 * builder that is its only reader — the composed-maximum guard below has to
 * traverse the schema's own bounds, and `@repo/temporal`'s activities are not
 * a dependency `@repo/utils` can take.
 *
 * ## Transform, never refine
 *
 * `generateObject` validates the model's output against this exact schema. A
 * `.refine()` that failed would throw inside that call as
 * `AI_NoObjectGeneratedError` — an error that matches nothing in the
 * generation workflow's non-retryable-error list, so it is retried three times
 * at the COMPLEX model tier before reaching the operator as a neutral fallback
 * string, with no indication that a schema-level rule (rather than the
 * model's own judgment) is what actually failed. A `.transform()` cannot fail
 * this way: it runs after validation succeeds, so it has no failure path back
 * into the retry loop.
 *
 * `isScaffold` is exactly such a rule wearing a boolean's clothes: the PO
 * prompt (`publishing-webinar-script-prompt.ts`) already states as fact that a
 * scaffold is "the demo flow is not supported by available context" —
 * `demoFlow.length === 0` — so asking the model to also assert that fact as an
 * independent field would let the two disagree. Deriving it here instead makes
 * disagreement structurally impossible.
 */

import { z } from "zod";
import type { PublishingClampRecord } from "./publishing-asset-clamp";

// =============================================================================
// Output schema
// =============================================================================

/**
 * Bound on the composed working-draft body once a Webinar / Demo Script is
 * persisted, spec §3's `BODY_MAX`.
 *
 * A DIFFERENT constant from `CURRENT_DRAFT_CHAR_CAP`, even though both equal
 * 40,000 today. `CURRENT_DRAFT_CHAR_CAP` bounds the draft a REFINEMENT run
 * reads back in, and is shared across every shipped content type — all six
 * prompt builders call `buildRefinementSection`, this one included; this
 * constant bounds what THIS content type persists. The composed-maximum guard below
 * asserts against both names rather than one, so the day they diverge a test
 * notices instead of two equal literals quietly meaning two different things.
 */
export const WEBINAR_SCRIPT_BODY_MAX = 40_000;

/**
 * The un-transformed shape, exported so a bound-reading walker has something
 * with a `.shape` to traverse.
 *
 * `.transform()` returns a `ZodPipe` in this repo's zod (4.4.3), and a
 * `ZodPipe` has no `.shape` — a walker handed `PublishingWebinarScriptSchema`
 * has nothing to iterate. This base is also what `generateObject` itself
 * builds the model's JSON schema from (`io: "input"`), so it is not merely a
 * test convenience: it is the shape the model actually sees, before
 * `isScaffold` and the derived `inputsNeeded` exist.
 */
export const BaseWebinarScriptSchema = z.object({
	// `.trim()` BEFORE `.min(1)`, so a whitespace-only title is rejected rather
	// than stored — the same reasoning the Case Study schema documents: every
	// reader downstream already treats a blank title as "no document", so a
	// schema that accepts one produces a run that succeeds, seeds a working
	// draft with an empty heading, and then breaks every safety surface that
	// reads the stored document.
	title: z.string().trim().min(1).max(200),
	sessionPurpose: z.string().trim().min(1).max(2000),
	recommendedAudience: z.string().trim().min(1).max(500),
	// Required, not optional: the prompt's own Shape-of-the-script section
	// instructs the model to write "[length TBD]" and record the gap under
	// inputs needed rather than leave this blank, so an empty field here would
	// mean the instruction was not followed, not that the answer is unknown.
	suggestedLength: z.string().trim().min(1).max(120),
	// Nullable, unlike every field above: the prompt says to omit presenter
	// notes rather than pad them when nothing is worth noting, so `null` is
	// the documented "nothing to say" answer, not a gap the model failed to
	// fill.
	presenterNotes: z.string().trim().max(1500).nullable().default(null),
	openingTalkTrack: z.string().trim().min(1).max(3000),
	agenda: z.array(z.string().trim().min(1).max(200)).max(10).default([]),
	keyMessage: z.string().trim().min(1).max(600),
	// Default `[]`, not required: an empty demo flow is a legitimate outcome
	// (the scaffold case) the prompt asks for explicitly rather than an
	// invented walkthrough, and `isScaffold` below is what turns "empty" into
	// a signal instead of a silently missing field.
	demoFlow: z
		.array(
			z.object({
				name: z.string().trim().min(1).max(120),
				whatToShow: z.string().trim().min(1).max(800),
				talkTrack: z.string().trim().min(1).max(1000),
				audienceTakeaway: z.string().trim().min(1).max(400),
			}),
		)
		.max(8)
		.default([]),
	// Every member optional and the object itself defaulted to `{}`: the
	// prompt asks for only the members the source context actually supports,
	// so an org that deletes this whole section from an edited template must
	// not be able to make a valid response impossible to produce.
	supportingDetails: z
		.object({
			problem: z.string().trim().max(800).optional(),
			solution: z.string().trim().max(800).optional(),
			whatMakesItInteresting: z.string().trim().max(800).optional(),
			evidence: z.string().trim().max(800).optional(),
			caveats: z.string().trim().max(800).optional(),
		})
		.default({}),
	suggestedAssets: z
		.object({
			confirmed: z
				.array(z.string().trim().min(1).max(200))
				.max(8)
				.default([]),
			needsConfirmation: z
				.array(z.string().trim().min(1).max(300))
				.max(8)
				.default([]),
		})
		.default({ confirmed: [], needsConfirmation: [] }),
	closingTalkTrack: z.string().trim().min(1).max(2000),
	suggestedCta: z.string().trim().min(1).max(400),
	releaseStatus: z
		.enum([
			"SHIPPED",
			"IN_PROGRESS",
			"PLANNED",
			"PREVIEW",
			"CONCEPT",
			"UNCONFIRMED",
		])
		.default("UNCONFIRMED"),
	inputsNeeded: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
	safetyNote: z.string().trim().max(1000).nullable().default(null),
});

/**
 * The sentence seeded into `inputsNeeded` when the demo flow is empty and the
 * model recorded no input gap of its own.
 *
 * Narrowed to exactly what the derivation below tests — an empty `demoFlow` —
 * and nothing wider. An earlier draft of this rule also asserted that
 * supporting details were unavailable, which is a claim about a field
 * `isScaffold` never inspects: a document can have a full `supportingDetails`
 * section and no demo, and seeding a sentence about supporting details in that
 * case would carry a false statement into both the export and the review
 * panel, since spec §5.5 renders `inputsNeeded` in both places.
 */
const SCAFFOLD_WITHOUT_INPUTS =
	"A demo flow was not available from the topic context.";

/**
 * The schema `generateObject` validates against, wrapping {@link
 * BaseWebinarScriptSchema} in the two derivations spec §5.1 requires.
 *
 * `isScaffold` is derived, never asked of the model — see the module-level
 * comment on transforms. Its value is exactly `demoFlow.length === 0`,
 * matching the PO prompt's own stated definition of a scaffold word for word.
 *
 * `inputsNeeded` is seeded with {@link SCAFFOLD_WITHOUT_INPUTS} only when the
 * derived flag is true AND the model recorded no input gap of its own — a
 * model that already wrote "no demo environment was available to confirm a
 * walkthrough" under inputs needed is not missing a fact this transform needs
 * to add, and appending a second, more generic sentence on top of an accurate
 * specific one would make the field worse, not more complete.
 */
export const PublishingWebinarScriptSchema = BaseWebinarScriptSchema.transform(
	(doc) => {
		const isScaffold = doc.demoFlow.length === 0;
		return {
			...doc,
			isScaffold,
			inputsNeeded:
				isScaffold && doc.inputsNeeded.length === 0
					? [SCAFFOLD_WITHOUT_INPUTS]
					: doc.inputsNeeded,
		};
	},
);

/**
 * The parsed Webinar / Demo Script document, after both derivations have run.
 *
 * Derived from the schema rather than hand-written, so a bound or a field
 * added to {@link BaseWebinarScriptSchema} changes this type automatically
 * instead of silently going stale beside it.
 */
export type WebinarScriptDocument = z.output<
	typeof PublishingWebinarScriptSchema
>;

// =============================================================================
// Composers
// =============================================================================

/**
 * Render a Markdown bullet list, or a plain "none" line when the list is
 * empty — never a bare heading with nothing under it.
 */
function renderList(items: readonly string[], emptyText: string): string {
	if (items.length === 0) {
		return `_${emptyText}_`;
	}
	return items.map((item) => `- ${item}`).join("\n");
}

/**
 * Compose the Markdown a reader actually edits from a parsed Webinar / Demo
 * Script document.
 *
 * Follows spec §5.5's field table: `title` through `suggestedCta`, in the
 * schema's own declared order, EXCLUDING `suggestedAssets`. Also excluded,
 * for the same reason the Case Study and Stakeholder Email working drafts
 * exclude their own advice fields: `isScaffold`, `releaseStatus`,
 * `inputsNeeded` and `safetyNote` are advice ABOUT the draft, not part of it,
 * and a draft that carries them is a draft whose author deletes four
 * sections before every regeneration and before ever presenting it live.
 *
 * A section whose content is absent (`presenterNotes` null, `agenda` empty,
 * `demoFlow` empty, every `supportingDetails` member absent) is OMITTED
 * rather than rendered as a bare heading — the same "omit an empty section
 * rather than render a bare heading" invariant the Case Study and Stakeholder
 * Email prompts already carry, applied here to the composed output instead of
 * the prompt input.
 *
 * `demoFlow` being empty is the scaffold case and is expected, not an error:
 * the working draft simply has no "Demo flow" section, and the reader learns
 * that the script needs one from `inputsNeeded`, which the export (not this
 * composer) renders.
 */
export function composeWebinarScriptWorkingDraftBody(
	doc: WebinarScriptDocument,
): string {
	return webinarScriptDraftSections(doc).join("\n\n");
}

/**
 * The ordered Markdown sections {@link composeWebinarScriptWorkingDraftBody}
 * joins with `"\n\n"`, kept as an array rather than a joined string so
 * {@link composeWebinarScriptExport} can insert its own lines after the
 * heading by indexing into this array instead of re-parsing the joined
 * string back apart. That re-parsing is exactly the bug this split fixes:
 * `title` has no single-line constraint, so a title containing a blank line
 * is indistinguishable, once joined, from an actual section boundary.
 * Sharing this builder makes that class of bug structurally impossible
 * rather than merely avoided by convention.
 */
function webinarScriptDraftSections(doc: WebinarScriptDocument): string[] {
	const sections: string[] = [`# ${doc.title.trim()}`];

	sections.push(doc.sessionPurpose.trim());

	sections.push(
		`**Recommended audience:** ${doc.recommendedAudience.trim()}\n**Suggested length:** ${doc.suggestedLength.trim()}`,
	);

	const presenterNotes = doc.presenterNotes?.trim();
	if (presenterNotes) {
		sections.push(`**Presenter notes:** ${presenterNotes}`);
	}

	sections.push(`## Opening talk track\n\n${doc.openingTalkTrack.trim()}`);

	if (doc.agenda.length > 0) {
		sections.push(
			`## Agenda\n\n${doc.agenda.map((item) => `- ${item.trim()}`).join("\n")}`,
		);
	}

	sections.push(`## Key message\n\n${doc.keyMessage.trim()}`);

	if (doc.demoFlow.length > 0) {
		const steps = doc.demoFlow.map((step, index) => {
			return [
				`### ${index + 1}. ${step.name.trim()}`,
				`**What to show:** ${step.whatToShow.trim()}`,
				`**Talk track:** ${step.talkTrack.trim()}`,
				`**Audience takeaway:** ${step.audienceTakeaway.trim()}`,
			].join("\n\n");
		});
		sections.push(`## Demo flow\n\n${steps.join("\n\n")}`);
	}

	const supporting = doc.supportingDetails;
	const supportingLines: string[] = [];
	if (supporting.problem?.trim()) {
		supportingLines.push(`**Problem:** ${supporting.problem.trim()}`);
	}
	if (supporting.solution?.trim()) {
		supportingLines.push(`**Solution:** ${supporting.solution.trim()}`);
	}
	if (supporting.whatMakesItInteresting?.trim()) {
		supportingLines.push(
			`**What makes it interesting:** ${supporting.whatMakesItInteresting.trim()}`,
		);
	}
	if (supporting.evidence?.trim()) {
		supportingLines.push(`**Evidence:** ${supporting.evidence.trim()}`);
	}
	if (supporting.caveats?.trim()) {
		supportingLines.push(`**Caveats:** ${supporting.caveats.trim()}`);
	}
	if (supportingLines.length > 0) {
		sections.push(
			`## Supporting details\n\n${supportingLines.join("\n\n")}`,
		);
	}

	sections.push(`## Closing talk track\n\n${doc.closingTalkTrack.trim()}`);
	sections.push(`## Suggested CTA\n\n${doc.suggestedCta.trim()}`);

	return sections;
}

/**
 * One phrasing per `releaseStatus` value, exported so `WebinarScriptPanel.tsx`
 * and this module's own export composer read the SAME map rather than two
 * hand-maintained lists that can drift apart the moment one of them is edited.
 *
 * `Record<..., string>` rather than a `switch`, and deliberately with no
 * `default` case: a seventh enum value added to {@link BaseWebinarScriptSchema}
 * later without a matching entry here is a compile error, not a silent blank.
 *
 * Every phrasing says "the draft says" rather than stating the fact directly,
 * mirroring `StakeholderEmailPanel.tsx`'s `RELEASE_STATUS_LABELS` for this
 * exact field name and its documented reasoning: "Shipped." reads as Fabric's
 * own finding, where "The draft says the work is delivered" reads as what it
 * is — a claim made from the source material, which the reader is the one who
 * can confirm. That distinction matters just as much on screen as it does in
 * the export this map originated for: this module's own doc comment names the
 * export as the one surface meant to leave Fabric and be read standalone,
 * without a panel's caveats beside it, and the panel is where a reader decides
 * whether to trust the claim before it ever gets that far.
 */
export const RELEASE_STATUS_LABELS: Record<
	WebinarScriptDocument["releaseStatus"],
	string
> = {
	SHIPPED: "The draft says the work is delivered and in use.",
	IN_PROGRESS: "The draft says the work is underway, not finished.",
	PLANNED: "The draft says the work is agreed but not started.",
	PREVIEW:
		"The draft says the work is out in limited preview, ahead of a general release.",
	CONCEPT: "The draft says this is a concept, with nothing built yet.",
	UNCONFIRMED:
		"The source material didn't say whether this has shipped, so the draft asserts no release state.",
};

/**
 * Said of an asset the clamp moved out of `confirmed`, never of one the model
 * itself put into `needsConfirmation` on its own — mirrors `CaseStudyPanel`'s
 * identical `ASSET_CLAMP_NOTE` and the reasoning behind its separate wording:
 * "the draft was unsure" and "Fabric overruled the draft" are different facts
 * about the same line, and a reader who cannot tell them apart cannot tell a
 * clamp from ordinary caution.
 */
const ASSET_CLAMP_NOTE =
	"Moved out of the confirmed list by Fabric, from an open approval thread naming them:";

/**
 * Compose the export a presenter takes out of Fabric — everything the
 * working draft carries, plus the advice that draft deliberately omits.
 *
 * Follows spec §5.5's field table: the working draft's own content, plus
 * `isScaffold` FIRST, `releaseStatus`, both `suggestedAssets` lists plus the
 * clamp attribution, `inputsNeeded` and `safetyNote`.
 *
 * `isScaffold` is rendered first, immediately under the title, and always —
 * never only when true — because the export is the one surface meant to
 * leave Fabric and be read standalone, without the panel's own scaffold
 * banner beside it. A presenter who opens this file needs to learn in the
 * first two lines whether the demo flow is real before reading three
 * thousand characters of talk track that assumes it is.
 *
 * `clamped` is REQUIRED, not optional. An optional parameter lets a future
 * caller forget it and silently ship an export whose asset lists cannot be
 * told apart from ones the model itself was merely cautious about — a caller
 * with nothing to attribute must say so explicitly by passing `{}`, the same
 * way `CaseStudyPanel` reads `generation.clamped` as a sibling database
 * column alongside `content` rather than as part of the content JSON, which
 * this document's own `suggestedAssets` shape cannot carry.
 *
 * Deliberately uncapped: this string is never persisted or re-parsed, so
 * none of the length bounds that protect a stored working draft apply to it.
 */
export function composeWebinarScriptExport(
	doc: WebinarScriptDocument,
	clamped: PublishingClampRecord,
): string {
	const [heading, ...rest] = webinarScriptDraftSections(doc);
	const scaffoldLine = doc.isScaffold
		? "**Scaffold:** Yes — the demo flow was not available from the topic context."
		: "**Scaffold:** No.";

	const sections: string[] = [
		heading,
		scaffoldLine,
		`**Release status:** ${RELEASE_STATUS_LABELS[doc.releaseStatus]}`,
		...rest,
	];

	const clampedAssets = clamped.assets ?? [];
	const assetSection: string[] = [
		"## Suggested assets",
		"**Confirmed:**",
		renderList(doc.suggestedAssets.confirmed, "None confirmed"),
		"**Needs confirmation:**",
		renderList(doc.suggestedAssets.needsConfirmation, "None"),
	];
	if (clampedAssets.length > 0) {
		assetSection.push(`${ASSET_CLAMP_NOTE} ${clampedAssets.join(", ")}.`);
	}
	sections.push(assetSection.join("\n\n"));

	sections.push(
		[
			"## Inputs needed",
			renderList(doc.inputsNeeded, "Nothing outstanding"),
		].join("\n\n"),
	);

	const safetyNote = doc.safetyNote?.trim();
	sections.push(`## Safety note\n\n${safetyNote ? safetyNote : "_None._"}`);

	return sections.join("\n\n");
}
