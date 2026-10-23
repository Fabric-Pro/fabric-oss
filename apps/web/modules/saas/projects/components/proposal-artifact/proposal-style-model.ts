/**
 * The Style tab's model (Fizzy #2946): the draft it edits, the checks a save
 * makes before the request, where each proposer colour comes from, and how a
 * fetch of the recipient's website reads. Pure functions and types only; the
 * state lives in `useProposalStyle`.
 */

import {
	type BrandCandidate,
	type BrandFetchFailureCode,
	brandAlternatives,
	effectiveBrandFetchAttempt,
} from "@repo/utils/proposal-artifact/brand-sources";
import { parseBrandColorList } from "@saas/shared/components/BrandColorListField";
import type { orpcClient } from "@shared/lib/orpc-client";
import { getOrpcCode } from "../field-mapping/orpc-error";

// The server's limits, restated for the browser: they live in
// `@repo/database` (`PROPOSAL_STYLE_MAX_*`), which would pull the Prisma
// client into the bundle. Checking here only spares a round trip; the
// server re-checks.
export const PROPOSAL_STYLE_DIRECTION_MAX_CHARS = 500;
export const PROPOSAL_STYLE_MAX_ACCENTS = 3;

/** A refusal: the gate is off, the document is gone, or the caller is not a member. */
export const DENIED_CODES = new Set(["NOT_FOUND", "FORBIDDEN", "UNAUTHORIZED"]);

/** What `projects.proposalArtifact.getStyle` returns: null until someone saves one. */
export type ProposalStyle = Awaited<
	ReturnType<typeof orpcClient.projects.proposalArtifact.getStyle>
>;

/** What `projects.recipientBrand.get` returns. */
export type RecipientBrandRead = Awaited<
	ReturnType<typeof orpcClient.projects.recipientBrand.get>
>;

/** What `projects.proposalArtifact.getBrandSources` returns. */
type BrandSources = Awaited<
	ReturnType<typeof orpcClient.projects.proposalArtifact.getBrandSources>
>;
export type ProposerSources = BrandSources["proposer"];
export type RecipientSources = NonNullable<BrandSources["recipient"]>;
type RecipientSuggestion = NonNullable<RecipientSources["suggestion"]>;
export type SuggestionResult = NonNullable<RecipientSuggestion["result"]>;
export type SuggestionField = SuggestionResult["alternatives"][number];

/** The style as the editor is shaping it: entries as typed. */
export type ProposalStyleDraft = {
	styleDirection: string;
	/** Zero or one entry. */
	primary: string[];
	accents: string[];
	/** Whether Fabric adds diagrams after each generation. */
	autoVisuals: boolean;
};

/** No saved Style means diagrams are added. */
export function proposalStyleDraftFrom(
	style: ProposalStyle | undefined,
): ProposalStyleDraft {
	return {
		styleDirection: style?.styleDirection ?? "",
		primary: style?.primaryColor ? [style.primaryColor] : [],
		accents: style?.accentColors ?? [],
		autoVisuals: style?.autoVisuals ?? true,
	};
}

/** The server's validation codes, which double as the inline copy keys. */
export type ProposalStyleError =
	| "directionTooLong"
	| "invalidColor"
	| "tooManyAccentColors";

const STYLE_ERRORS = new Set<string>([
	"directionTooLong",
	"invalidColor",
	"tooManyAccentColors",
]);

export type ProposalStyleInput = {
	styleDirection: string | null;
	primaryColor: string | null;
	accentColors: string[];
	/**
	 * Always sent: the server keeps the stored value only when it is absent,
	 * which is what an older client's save looks like.
	 */
	autoVisuals: boolean;
};

/**
 * The checks `projects.proposalArtifact.updateStyle` makes, run before the
 * request: a trimmed direction of at most 500 characters (empty clears it),
 * `#rrggbb` colours (`#rgb` widened, blanks dropped), at most three accents.
 *
 * The draft holds only what the person set for this document, so an empty
 * primary goes as null and empty accents as `[]`: both inherit. A value the
 * form only displays as inherited is never in the draft, so it is never
 * saved as an override.
 */
export function validateProposalStyleDraft(
	draft: ProposalStyleDraft,
):
	| { ok: true; value: ProposalStyleInput }
	| { ok: false; error: ProposalStyleError } {
	const styleDirection = draft.styleDirection.trim();
	if (styleDirection.length > PROPOSAL_STYLE_DIRECTION_MAX_CHARS) {
		return { ok: false, error: "directionTooLong" };
	}
	const primary = parseBrandColorList(draft.primary);
	const accents = parseBrandColorList(draft.accents);
	if (!primary || !accents || primary.length > 1) {
		return { ok: false, error: "invalidColor" };
	}
	if (accents.length > PROPOSAL_STYLE_MAX_ACCENTS) {
		return { ok: false, error: "tooManyAccentColors" };
	}
	return {
		ok: true,
		value: {
			styleDirection: styleDirection || null,
			primaryColor: primary[0] ?? null,
			accentColors: accents,
			autoVisuals: draft.autoVisuals,
		},
	};
}

/** The validation code a refused save carries, when it is one of ours. */
export function styleErrorOf(error: unknown): ProposalStyleError | null {
	if (getOrpcCode(error) !== "BAD_REQUEST") {
		return null;
	}
	const code = (error as { data?: { code?: unknown } }).data?.code;
	return typeof code === "string" && STYLE_ERRORS.has(code)
		? (code as ProposalStyleError)
		: null;
}

export function sameDraft(a: unknown, b: unknown): boolean {
	return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * The values a person may pick instead of what the draft resolves to: the
 * Brand kit's and the website's, once per distinct value, never the neutral
 * default. `override` is the draft as the server would store it, so a typed
 * `#1F4E79` is the kit's `#1f4e79`: null inherits, and undefined (a draft
 * that does not parse) offers none.
 */
export function alternativesFor<T>(
	override: T | null | undefined,
	inherited: BrandCandidate<T>,
	candidates: Array<BrandCandidate<T | null>>,
): Array<BrandCandidate<T>> {
	if (override === undefined) {
		return [];
	}
	const resolved: BrandCandidate<T | null> =
		override === null ? inherited : { source: "MANUAL", value: override };
	return brandAlternatives<T | null>(resolved, candidates).flatMap(
		(candidate) =>
			candidate.value === null
				? []
				: [{ source: candidate.source, value: candidate.value }],
	);
}

/** A proposer colour field: the one primary colour, or the accents. */
export type ProposerColorKind = "primary" | "accents";

/**
 * Where a proposer colour field's value comes from, for the draft as it
 * stands: what it inherits without an override (the server's answer, with
 * its source) and the values the Brand kit and the website offer instead.
 * The primary reads as a list of at most one, so both fields share a shape.
 */
export function proposerColorSources(
	kind: ProposerColorKind,
	entries: string[],
	proposer: ProposerSources,
): {
	inherited: BrandCandidate<string[]>;
	alternatives: Array<BrandCandidate<string[]>>;
} {
	const one = (value: string | null) => (value ? [value] : null);
	const sources =
		kind === "primary"
			? {
					inherited: {
						source: proposer.primary.inherited.source,
						value: [proposer.primary.inherited.value],
					},
					brandKit: one(proposer.primary.brandKit),
					vendorSite: one(proposer.primary.vendorSite),
				}
			: {
					inherited: proposer.accents.inherited,
					brandKit: proposer.accents.brandKit,
					vendorSite: proposer.accents.vendorSite,
				};
	const parsed = parseBrandColorList(entries);
	return {
		inherited: sources.inherited,
		alternatives: alternativesFor<string[]>(
			parsed === null ? undefined : parsed.length > 0 ? parsed : null,
			sources.inherited,
			[
				{ source: "BRAND_KIT", value: sources.brandKit },
				{ source: "VENDOR_SITE", value: sources.vendorSite },
			],
		),
	};
}

/** Whether the person has typed anything into a colour field. */
export function hasEntries(entries: string[]): boolean {
	return entries.some((entry) => entry.trim() !== "");
}

/** A fetch of the recipient's website as the Style tab shows it. */
export type SuggestionView =
	| { kind: "none" }
	| { kind: "running" }
	| {
			kind: "failed";
			/** Nothing usable found is not a failure here: see `nothingFound`. */
			code: Exclude<BrandFetchFailureCode, "no_logo" | "no_colors">;
	  }
	| { kind: "nothingFound" }
	| { kind: "found"; requestId: string; result: SuggestionResult }
	/** Everything it found is what the recipient brand already holds. */
	| { kind: "matches" };

/**
 * The suggestion as a reader sees it now: a RUNNING attempt past its
 * lifetime reads as timed out here too, so the card never spins once
 * polling stops. A failure that found nothing usable and a success with
 * nothing in it both read as nothing found.
 */
export function suggestionViewOf(
	suggestion: RecipientSuggestion | null,
	requesting: boolean,
	now: Date,
): SuggestionView {
	if (requesting) {
		return { kind: "running" };
	}
	if (!suggestion) {
		return { kind: "none" };
	}
	const attempt = effectiveBrandFetchAttempt(
		{
			status: suggestion.status,
			failureCode: suggestion.failureCode,
			requestedAt: new Date(suggestion.requestedAt),
		},
		now,
	);
	if (attempt.status === "RUNNING") {
		return { kind: "running" };
	}
	if (attempt.status === "FAILED") {
		const code = attempt.failureCode ?? "failed";
		return code === "no_logo" || code === "no_colors"
			? { kind: "nothingFound" }
			: { kind: "failed", code };
	}
	const result = suggestion.result;
	if (!result) {
		return { kind: "none" };
	}
	if (!result.name && result.colors.length === 0 && !result.logoUrl) {
		return { kind: "nothingFound" };
	}
	return result.alternatives.length > 0
		? { kind: "found", requestId: suggestion.requestId, result }
		: { kind: "matches" };
}

/** What the last Save came to. */
export type SaveFeedbackState =
	| { kind: "none" }
	| { kind: "saved" }
	| { kind: "invalid"; error: ProposalStyleError }
	| { kind: "styleFailed" }
	| { kind: "recipientFailed" }
	| { kind: "recipientConflict" };

/** What the last Confirm of a suggested value came to. */
export type ConfirmFeedback =
	| { kind: "none" }
	| { kind: "applied"; host: string }
	| { kind: "conflict" }
	| { kind: "stale" }
	| { kind: "logoRejected" }
	| { kind: "failed" };
