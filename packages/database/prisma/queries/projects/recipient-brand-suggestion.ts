/**
 * A project's recipient website fetch (Fizzy #2946): a suggestion the Style
 * tab shows as "fetched, not applied" until a member confirms a field of it.
 *
 * Only the fetch writes this row, never a person, and the recipient brand row
 * is never written here: confirming copies a field across through the
 * recipient brand's own compare-and-set. The attempt and result columns are
 * kept apart as in `brand-site-fetch.ts`, and every write is conditioned on
 * the attempt it belongs to. Organization members read it; project guests
 * never do.
 */

import { normalizeHexColorList } from "@repo/utils/glossy/visual-colors";
import {
	type BrandFetchFailureCode,
	isJoinableBrandFetchAttempt,
	isRecipientSuggestedLogoKey,
	neutralizeBrandName,
} from "@repo/utils/proposal-artifact/brand-sources";
import { db } from "../../client";

const SHA256_HEX = /^[0-9a-f]{64}$/;

const SUGGESTION_SELECT = {
	projectId: true,
	organizationId: true,
	website: true,
	requestId: true,
	status: true,
	failureCode: true,
	requestedById: true,
	requestedAt: true,
	resultWebsite: true,
	name: true,
	colors: true,
	logoKey: true,
	logoHash: true,
	fetchedAt: true,
} as const;

export interface RecipientBrandSuggestionView {
	projectId: string;
	organizationId: string;
	website: string;
	requestId: string;
	status: string;
	failureCode: string | null;
	requestedById: string | null;
	requestedAt: Date;
	resultWebsite: string | null;
	name: string | null;
	colors: string[];
	logoKey: string | null;
	logoHash: string | null;
	fetchedAt: Date | null;
}

/**
 * The project's latest recipient website fetch, read in the owning
 * organization: a row left behind in another organization reads as none.
 */
export async function getRecipientBrandSuggestion(input: {
	projectId: string;
	organizationId: string;
}): Promise<RecipientBrandSuggestionView | null> {
	return db.projectRecipientBrandSuggestion.findFirst({
		where: {
			projectId: input.projectId,
			organizationId: input.organizationId,
		},
		select: SUGGESTION_SELECT,
	});
}

/**
 * Record a new attempt for `website`, replacing the previous attempt's state
 * and keeping its result. Writes nothing (`stale`) unless the project's
 * recipient brand, in the same organization, still names `website`, and
 * nothing (`joined`) while a recent attempt for the same website is still
 * running. The recipient brand row is locked for the check, so concurrent
 * starts are decided one after the other. With `failureCode` the attempt is
 * recorded as already FAILED, unless it would replace a running attempt for
 * the same website, which it joins instead.
 */
export async function startRecipientBrandSuggestion(input: {
	projectId: string;
	organizationId: string;
	website: string;
	requestId: string;
	requestedById: string;
	requestedAt: Date;
	failureCode?: BrandFetchFailureCode;
}): Promise<"started" | "stale" | "joined"> {
	return db.$transaction(async (tx) => {
		const [brand] = await tx.$queryRaw<
			{ website: string | null; organizationId: string }[]
		>`
			SELECT "website", "organizationId" FROM "project_recipient_brand"
			WHERE "projectId" = ${input.projectId}
			FOR UPDATE`;
		if (
			!brand?.website ||
			brand.website !== input.website ||
			brand.organizationId !== input.organizationId
		) {
			return "stale";
		}
		const current = await tx.projectRecipientBrandSuggestion.findUnique({
			where: { projectId: input.projectId },
			select: { website: true, status: true, requestedAt: true },
		});
		if (
			isJoinableBrandFetchAttempt(
				current,
				input.website,
				input.requestedAt,
			)
		) {
			return "joined";
		}
		const attempt = {
			organizationId: input.organizationId,
			website: input.website,
			requestId: input.requestId,
			status: input.failureCode ? "FAILED" : "RUNNING",
			failureCode: input.failureCode ?? null,
			requestedById: input.requestedById,
			requestedAt: input.requestedAt,
		};
		await tx.projectRecipientBrandSuggestion.upsert({
			where: { projectId: input.projectId },
			create: { projectId: input.projectId, ...attempt },
			update: attempt,
		});
		return "started";
	});
}

export type RecipientBrandSuggestionOutcome =
	| {
			ok: true;
			name: string | null;
			colors: string[];
			logoKey: string | null;
			logoHash: string | null;
	  }
	| { ok: false; failureCode: BrandFetchFailureCode };

export type FinishRecipientBrandSuggestionResult =
	| {
			applied: true;
			/** The suggested logo this result replaced, for cleanup. */
			previousLogoKey: string | null;
	  }
	| { applied: false };

/**
 * Finish the attempt `requestId`. A success writes the result for the website
 * that attempt fetched: the name neutralized, colours as lowercase `#rrggbb`,
 * the logo only when its key is one of this project's suggested logos. A
 * failure writes only the attempt. `applied: false` when a newer attempt
 * replaced this one, it already finished, or the project is gone; the caller
 * then deletes the logo it stored for this attempt.
 */
export async function finishRecipientBrandSuggestion(input: {
	projectId: string;
	requestId: string;
	website: string;
	outcome: RecipientBrandSuggestionOutcome;
	fetchedAt: Date;
}): Promise<FinishRecipientBrandSuggestionResult> {
	const where = {
		projectId: input.projectId,
		requestId: input.requestId,
		status: "RUNNING",
	};
	const { outcome } = input;
	if (!outcome.ok) {
		const { count } = await db.projectRecipientBrandSuggestion.updateMany({
			where,
			data: { status: "FAILED", failureCode: outcome.failureCode },
		});
		return count > 0
			? { applied: true, previousLogoKey: null }
			: { applied: false };
	}
	const logoKey =
		outcome.logoKey &&
		isRecipientSuggestedLogoKey(input.projectId, outcome.logoKey)
			? outcome.logoKey
			: null;
	const logoHash =
		logoKey && outcome.logoHash && SHA256_HEX.test(outcome.logoHash)
			? outcome.logoHash
			: null;

	return db.$transaction(async (tx) => {
		const current = await tx.projectRecipientBrandSuggestion.findFirst({
			where,
			select: { logoKey: true },
		});
		if (!current) {
			return { applied: false as const };
		}
		const { count } = await tx.projectRecipientBrandSuggestion.updateMany({
			where,
			data: {
				status: "SUCCEEDED",
				failureCode: null,
				resultWebsite: input.website,
				name: neutralizeBrandName(outcome.name),
				colors: normalizeHexColorList(outcome.colors),
				logoKey,
				logoHash,
				fetchedAt: input.fetchedAt,
			},
		});
		if (count === 0) {
			return { applied: false as const };
		}
		return {
			applied: true as const,
			previousLogoKey:
				current.logoKey && current.logoKey !== logoKey
					? current.logoKey
					: null,
		};
	});
}
