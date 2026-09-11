/**
 * The Newsletter Blurb output schema and its two composers (Fizzy #1988,
 * Phase 2D slice 2).
 *
 * A module in the shared leaf package, for the same measured reason its Case
 * Study, Stakeholder Email and Webinar Script siblings are: `@repo/temporal`
 * seeds a draft when a generation succeeds and `@repo/api` re-composes the same
 * text when a stored version is adopted, and one shared function makes those two
 * copies drifting apart impossible rather than merely catchable by a parity test
 * after the fact. This module additionally OWNS the schema itself, for the same
 * reason `publishing-webinar-script-body.ts` does: the composed-maximum guard
 * beside it has to traverse the schema's own bounds, and `@repo/temporal`'s
 * activities are not a dependency `@repo/utils` can take.
 *
 * ## Transform, never refine
 *
 * `generateObject` validates the model's output against this exact schema. A
 * `.refine()` that failed would throw inside that call as
 * `AI_NoObjectGeneratedError` — an error that matches nothing in the generation
 * workflow's non-retryable-error list, so it is retried three times at the
 * COMPLEX model tier before reaching the operator as a neutral fallback string,
 * with no indication that a schema-level rule (rather than the model's own
 * judgment) is what actually failed. A `.transform()` cannot fail this way: it
 * runs after validation succeeds, so it has no failure path back into the retry
 * loop.
 *
 * `ctaState` is exactly such a rule wearing an enum's clothes. The obvious
 * spelling of the spec's rule — "PRESENT implies a non-null `suggestedCta`" — is
 * a refinement, and it would fire on the single MOST LIKELY output this content
 * type produces: `ctaState` has no section in the PO prompt, so the only text
 * asking for it is text this repository authored, while the PO skeleton actively
 * asks the model for a call-to-action string. A model that writes the CTA and
 * omits the state produces `UNKNOWN` + a real CTA, which a
 * `PRESENT ⇒ non-null` refinement does not catch but its mirror image does, and
 * every neighbouring miswrite lands somewhere in the same six-cell table.
 * {@link reconcileCtaState} decides all six cells instead, so no combination can
 * fail validation.
 *
 * ## No `isScaffold`
 *
 * Unlike the Webinar Script, this type has none, and the accessibility line in
 * its panel must not name one. There is no field here whose emptiness means the
 * draft is a skeleton: a blurb is one paragraph and either exists or does not,
 * and the gap this type actually reports is a missing CTA, which `ctaState`
 * already names precisely.
 */

import { z } from "zod";
import type { PublishingClampRecord } from "./publishing-asset-clamp";

// =============================================================================
// Output schema
// =============================================================================

/**
 * Bound on the composed working-draft body once a Newsletter Blurb is
 * persisted, spec §3's `BODY_MAX`.
 *
 * 24,000, following the Stakeholder Email
 * (`publishing-suite/stakeholder-email.ts:65`) rather than the Webinar Script's
 * 40,000: a blurb is the SHORTEST thing this suite writes — one headline and one
 * or two short paragraphs — so the Webinar Script's cap would be five times the
 * largest document this schema can even express.
 *
 * A DIFFERENT constant from `CURRENT_DRAFT_CHAR_CAP`, which is 40,000 and bounds
 * the draft a REFINEMENT run reads back in, shared across every shipped content
 * type; this constant bounds what THIS content type persists. The
 * composed-maximum guard asserts against both names rather than one, so the two
 * cannot quietly come to mean the same thing.
 */
export const NEWSLETTER_BLURB_BODY_MAX = 24_000;

/**
 * The un-transformed shape, exported for the same two reasons the Webinar
 * module exports its base: `.transform()` returns a `ZodPipe` in this repo's
 * zod (4.4.3) and a `ZodPipe` has no `.shape`, so a bound-reading walker has
 * nothing to traverse; and this base is what `generateObject` builds the
 * model's JSON schema from (`io: "input"`), so it is the shape the model
 * actually sees.
 *
 * EVERY omissible field carries a `default`, and that is a correctness
 * requirement rather than tidiness (spec §5.1): in zod, `nullable()` without
 * `default()` is still a REQUIRED key — the key must be present, merely allowed
 * to hold `null`. `suggestedAssets` is an object whose members all have
 * defaults, which is still a required key without its own `.default({…})`.
 * Four of these fields correspond to no section of the PO prompt and are
 * described only by text this repository authored into the org-editable prompt
 * body; an org that trims one of those paragraphs must lose information, never
 * availability, and a missing default would instead brick the content type
 * permanently with no retry path.
 */
export const BaseNewsletterBlurbSchema = z.object({
	// `.trim()` BEFORE `.min(1)`, so a whitespace-only headline is rejected
	// rather than stored — measured in 2C: the weak form makes the run SUCCEED,
	// seed a working draft with an empty heading, and then every downstream
	// reader narrows the stored document to null and adopt throws forever on a
	// draft the server itself wrote.
	headline: z.string().trim().min(1).max(200),
	// The floor is 40, not 120. FR10-FR13 give the requester a 2,000-character
	// guidance box wired into this prompt, and the prompt's own Length section
	// opens by telling the model to use the requested length "even where it is
	// much shorter". A reader asking for "one sentence, for the standup digest"
	// gets a ~70-character blurb exactly as instructed, and a higher floor would
	// reject that as a hard non-retryable failure blaming generation for
	// following the instruction it was given. 40 is still above every stock
	// placeholder the prompt itself suggests ("[metric TBD]", "TBD").
	blurb: z.string().trim().min(40).max(4000),
	ctaState: z.enum(["PRESENT", "UNKNOWN", "OMITTED"]).default("UNKNOWN"),
	suggestedCta: z.string().trim().max(400).nullable().default(null),
	audience: z
		.enum([
			"INTERNAL",
			"CUSTOMER",
			"PARTNER",
			"COMMUNITY",
			"EXTERNAL",
			"UNSPECIFIED",
		])
		.default("UNSPECIFIED"),
	// SEVEN values, not the family's five and not Webinar's six. `PILOT` and
	// `UPCOMING` exist because this type's PO prompt hands the model "in pilot"
	// and "coming soon", and a phrasing the prompt suggests with no home in the
	// enum is the model being invited into a value the schema will not accept.
	// `CONCEPT` is absent for the mirror-image reason: this prompt never offers
	// it. `publishing-newsletter-blurb-body.test.ts` pins both directions
	// against the prompt body itself.
	releaseStatus: z
		.enum([
			"SHIPPED",
			"IN_PROGRESS",
			"PLANNED",
			"PREVIEW",
			"PILOT",
			"UPCOMING",
			"UNCONFIRMED",
		])
		.default("UNCONFIRMED"),
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
	inputsNeeded: z.array(z.string().trim().min(1).max(300)).max(8).default([]),
	safetyNote: z.string().trim().max(1000).nullable().default(null),
});

/**
 * Decide the call-to-action state from the state the model reported and the
 * call-to-action value it actually wrote.
 *
 * TOTAL over all six inputs, deliberately, and none of them rejects — see the
 * module comment on transforms. The value is treated as the harder evidence
 * than the state throughout: a `PRESENT` with nothing to present is a claim
 * with no payload, and an `OMITTED` that still carries a line is contradicted
 * by its own content. Only `OMITTED` with nothing attached is a decision the
 * document can keep, because there the state and the payload agree.
 *
 * Emptiness is tested on the TRIMMED string rather than on `null` alone:
 * `suggestedCta` is `.trim()`ed by the schema before this runs, so a
 * whitespace-only CTA arrives here as `""`, and a null-only test would call
 * that a real call to action and emit a bare heading with nothing under it.
 */
function reconcileCtaState(
	state: "PRESENT" | "UNKNOWN" | "OMITTED",
	suggestedCta: string | null,
): "PRESENT" | "UNKNOWN" | "OMITTED" {
	const hasCta = (suggestedCta ?? "").trim().length > 0;
	if (hasCta) {
		return "PRESENT";
	}
	return state === "OMITTED" ? "OMITTED" : "UNKNOWN";
}

/**
 * The schema `generateObject` validates against, wrapping
 * {@link BaseNewsletterBlurbSchema} in the one reconciliation spec §5.2
 * requires.
 */
export const PublishingNewsletterBlurbSchema =
	BaseNewsletterBlurbSchema.transform((doc) => {
		const suggestedCta = (doc.suggestedCta ?? "").trim() || null;
		const safetyNote = (doc.safetyNote ?? "").trim() || null;
		return {
			...doc,
			suggestedCta,
			safetyNote,
			ctaState: reconcileCtaState(doc.ctaState, suggestedCta),
		};
	});

/**
 * The parsed Newsletter Blurb document, after reconciliation has run.
 *
 * Derived from the schema rather than hand-written, so a bound or a field added
 * to {@link BaseNewsletterBlurbSchema} changes this type automatically instead
 * of silently going stale beside it.
 */
export type NewsletterBlurbDocument = z.output<
	typeof PublishingNewsletterBlurbSchema
>;

// =============================================================================
// Label maps
// =============================================================================
//
// `Record<NewsletterBlurbDocument[…], string>` rather than a `switch`, and
// deliberately with no `default` case: a value added to an enum above without a
// matching entry here is a compile error, not a silent blank (spec §9.1).
//
// BOTH the on-screen label and the export caveat read these SAME maps. A value
// that renders one way in the panel and another in a downloaded file is a
// document that disagrees with the product it came from, and a reader holding
// only the file has no way to tell which one is Fabric's actual finding.

/**
 * One phrasing per `releaseStatus` value.
 *
 * Every phrasing says what the DRAFT claims rather than stating the fact
 * directly, mirroring the identical map in `publishing-webinar-script-body.ts`
 * and its documented reasoning: "Shipped." reads as Fabric's own finding, where
 * "The draft says the work is delivered" reads as what it is — a claim made
 * from the source material, which the reader is the one who can confirm.
 *
 * NOT the sibling module's map, which is exported under this same bare name and
 * which an editor auto-import will offer. That one lacks `PILOT` and `UPCOMING`
 * and carries a `CONCEPT` this type does not have; indexing it with a Newsletter
 * status is a `tsc` error, and the fix for that error is this map, never a cast.
 */
export const RELEASE_STATUS_LABELS: Record<
	NewsletterBlurbDocument["releaseStatus"],
	string
> = {
	SHIPPED: "The draft says the work is delivered and in use.",
	IN_PROGRESS: "The draft says the work is underway, not finished.",
	PLANNED: "The draft says the work is agreed but not started.",
	PREVIEW:
		"The draft says the work is out in limited preview, ahead of a general release.",
	PILOT: "The draft says the work is in a pilot, running with a limited set of accounts or readers.",
	UPCOMING:
		"The draft says a release is coming and near, without naming a stage it has reached.",
	UNCONFIRMED:
		"The source material didn't say whether this has shipped, so the draft asserts no release state.",
};

/**
 * One phrasing per `audience` value.
 *
 * A newsletter travels further than the person who asked for one expects, and
 * the framing decides what may safely be said — so this is the map a reader
 * checks before sending, not decoration. `UNSPECIFIED` names the consequence
 * rather than only the absence, because the draft was narrowed on the reader's
 * behalf and a reader who does not know that will widen it back without
 * re-reading.
 */
export const AUDIENCE_LABELS: Record<
	NewsletterBlurbDocument["audience"],
	string
> = {
	INTERNAL: "The draft is written for readers inside the organization.",
	CUSTOMER: "The draft is written for people who already use the product.",
	PARTNER:
		"The draft is written for a partner, reseller or supplier readership.",
	COMMUNITY:
		"The draft is written for an open community of users and contributors.",
	EXTERNAL:
		"The draft is written for a public readership, not a customer, partner or community one.",
	UNSPECIFIED:
		"The source material didn't say who will read this, so the draft is framed for the narrowest readership it supports.",
};

/**
 * One phrasing per `ctaState` value.
 *
 * `UNKNOWN` says what the reader has to DO, not merely that something is
 * missing: this is the one gap this content type reports structurally rather
 * than as a bracketed placeholder inside the prose, so the panel and the export
 * are the only two places it is ever stated.
 */
export const CTA_STATE_LABELS: Record<
	NewsletterBlurbDocument["ctaState"],
	string
> = {
	PRESENT: "The draft carries a call to action the source material supports.",
	UNKNOWN:
		"The draft says a call to action belongs here but the source material didn't name one — supply it before sending.",
	OMITTED: "The draft says no call to action is useful for this item.",
};

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
 * The ordered Markdown sections {@link composeNewsletterBlurbWorkingDraftBody}
 * joins with `"\n\n"`, kept as an array rather than a joined string so
 * {@link composeNewsletterBlurbExport} can insert its own lines after the
 * heading by indexing into this array instead of re-parsing the joined string
 * back apart. That re-parsing is a measured bug in the sibling module's history:
 * `headline` has no single-line constraint, so a headline containing a blank
 * line is indistinguishable, once joined, from an actual section boundary.
 */
function newsletterBlurbDraftSections(doc: NewsletterBlurbDocument): string[] {
	const sections: string[] = [`# ${doc.headline.trim()}`];

	sections.push(doc.blurb.trim());

	// ONLY when PRESENT. An `UNKNOWN` CTA has no text to carry — the reconciler
	// above guarantees that — and an `OMITTED` one is a decision, not a gap, so
	// carrying either into the draft would mean a heading with nothing under it
	// or a heading a reader has to delete before sending.
	const suggestedCta = doc.suggestedCta?.trim();
	if (doc.ctaState === "PRESENT" && suggestedCta) {
		sections.push(`## Suggested call to action\n\n${suggestedCta}`);
	}

	return sections;
}

/**
 * Compose the Markdown a reader actually edits from a parsed Newsletter Blurb
 * document.
 *
 * Follows spec §5.5's field table: `headline`, `blurb`, and `suggestedCta` only
 * when `ctaState` is `PRESENT`. Everything else this document carries —
 * `ctaState` itself, `audience`, `releaseStatus`, `suggestedAssets`,
 * `inputsNeeded` and `safetyNote` — is advice ABOUT the draft rather than part
 * of it, the same split the Case Study, Stakeholder Email and Webinar Script
 * working drafts make, and a draft that carried it would be a draft whose author
 * deletes six sections before every single send.
 */
export function composeNewsletterBlurbWorkingDraftBody(
	doc: NewsletterBlurbDocument,
): string {
	return newsletterBlurbDraftSections(doc).join("\n\n");
}

/**
 * Said of an asset the clamp moved out of `confirmed`, never of one the model
 * itself put into `needsConfirmation` on its own — mirrors the identical note in
 * `CaseStudyPanel` and `publishing-webinar-script-body.ts`, and the reasoning
 * behind its separate wording: "the draft was unsure" and "Fabric overruled the
 * draft" are different facts about the same line, and a reader who cannot tell
 * them apart cannot tell a clamp from ordinary caution.
 */
const ASSET_CLAMP_NOTE =
	"Moved out of the confirmed list by Fabric, from an open approval thread naming them:";

/**
 * Compose the export a sender takes out of Fabric — everything the working
 * draft carries, plus the advice that draft deliberately omits.
 *
 * Follows spec §5.5's field table: the working draft's own content, plus
 * `releaseStatus`, `audience` and `ctaState` FIRST, then both `suggestedAssets`
 * lists plus the clamp attribution, `inputsNeeded` and `safetyNote`.
 *
 * The three caveat lines are rendered immediately under the headline, and
 * ALWAYS — never only when they are interesting — because the export is the one
 * surface meant to leave Fabric and be read standalone, without the panel's own
 * caveats beside it. A sender who opens this file needs to learn in the first
 * three lines who it was framed for and whether the release claim is confirmed,
 * before pasting a paragraph short enough to look already checked into a
 * template addressed to a list.
 *
 * `clamped` is REQUIRED, not optional. An optional parameter lets a future
 * caller forget it and silently ship an export whose asset lists cannot be told
 * apart from ones the model itself was merely cautious about — a caller with
 * nothing to attribute must say so explicitly by passing `{}`, the same way the
 * panel reads `generation.clamped` as a sibling database column alongside
 * `content` rather than as part of the content JSON, which this document's own
 * `suggestedAssets` shape cannot carry.
 *
 * Deliberately uncapped: this string is never persisted or re-parsed, so none of
 * the length bounds that protect a stored working draft apply to it.
 */
export function composeNewsletterBlurbExport(
	doc: NewsletterBlurbDocument,
	clamped: PublishingClampRecord,
): string {
	const [heading, ...rest] = newsletterBlurbDraftSections(doc);

	const sections: string[] = [
		heading,
		`**Release status:** ${RELEASE_STATUS_LABELS[doc.releaseStatus]}`,
		`**Audience:** ${AUDIENCE_LABELS[doc.audience]}`,
		`**Call to action:** ${CTA_STATE_LABELS[doc.ctaState]}`,
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
