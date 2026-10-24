/**
 * The organization's website fetch (Fizzy #2946): the row its brand colours
 * are read from as the VENDOR_SITE source, below the Brand kit.
 *
 * Only the fetch writes it, never a person. The attempt columns change when a
 * fetch starts and when it fails; the result columns only when one succeeds,
 * so a fetch that is running or has failed never takes away colours an
 * earlier one found. Every write is conditioned on the attempt it belongs to
 * (`requestId`, still RUNNING), so a superseded or cut-off fetch writes
 * nothing. No statement here touches the Brand kit itself.
 */

import {
	normalizeHexColorList,
	strictHexColor,
} from "@repo/utils/glossy/visual-colors";
import {
	type BrandFetchFailureCode,
	isJoinableBrandFetchAttempt,
} from "@repo/utils/proposal-artifact/brand-sources";
import { db } from "../client";

const SITE_FETCH_SELECT = {
	organizationId: true,
	website: true,
	requestId: true,
	status: true,
	failureCode: true,
	requestedById: true,
	requestedAt: true,
	resultWebsite: true,
	primaryColor: true,
	accentColors: true,
	fetchedAt: true,
} as const;

export interface BrandSiteFetchView {
	organizationId: string;
	website: string;
	requestId: string;
	status: string;
	failureCode: string | null;
	requestedById: string | null;
	requestedAt: Date;
	resultWebsite: string | null;
	primaryColor: string | null;
	accentColors: string[];
	fetchedAt: Date | null;
}

/** The organization's latest website fetch, or null when none ran. */
export async function getBrandSiteFetch(
	organizationId: string,
): Promise<BrandSiteFetchView | null> {
	return db.organizationBrandSiteFetch.findUnique({
		where: { organizationId },
		select: SITE_FETCH_SELECT,
	});
}

/**
 * Record a new attempt for `website`, replacing the previous attempt's state
 * and keeping its result. Writes nothing (`stale`) when the Brand kit's
 * website is no longer `website`, so an older request cannot overwrite the
 * attempt a newer website started, and nothing (`joined`) when an attempt for
 * the same website started within the join window is still running, so two
 * requests at once fetch once. The Brand kit row is locked for the check, so
 * concurrent starts are decided one after the other. With `failureCode` the
 * attempt is recorded as already FAILED (a refused automatic start), so the
 * form says why; a refused start joins a running attempt too, rather than
 * marking a fetch still in flight as failed.
 */
export async function startBrandSiteFetch(input: {
	organizationId: string;
	website: string;
	requestId: string;
	requestedById: string;
	requestedAt: Date;
	failureCode?: BrandFetchFailureCode;
}): Promise<"started" | "stale" | "joined"> {
	return db.$transaction(async (tx) => {
		const [kit] = await tx.$queryRaw<{ website: string | null }[]>`
			SELECT "website" FROM "organization_brand_kit"
			WHERE "organizationId" = ${input.organizationId}
			FOR UPDATE`;
		if (!kit?.website || kit.website !== input.website) {
			return "stale";
		}
		const current = await tx.organizationBrandSiteFetch.findUnique({
			where: { organizationId: input.organizationId },
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
			website: input.website,
			requestId: input.requestId,
			status: input.failureCode ? "FAILED" : "RUNNING",
			failureCode: input.failureCode ?? null,
			requestedById: input.requestedById,
			requestedAt: input.requestedAt,
		};
		await tx.organizationBrandSiteFetch.upsert({
			where: { organizationId: input.organizationId },
			create: { organizationId: input.organizationId, ...attempt },
			update: attempt,
		});
		return "started";
	});
}

export type BrandSiteFetchOutcome =
	| { ok: true; primaryColor: string | null; accentColors: string[] }
	| { ok: false; failureCode: BrandFetchFailureCode };

/**
 * Finish the attempt `requestId`. A success writes the result for the website
 * that attempt fetched; a failure writes only the attempt. Returns whether a
 * row changed: false when a newer attempt replaced this one, it already
 * finished, or the organization is gone. Colours are stored only as
 * lowercase `#rrggbb`; anything else is dropped.
 */
export async function finishBrandSiteFetch(input: {
	organizationId: string;
	requestId: string;
	website: string;
	outcome: BrandSiteFetchOutcome;
	fetchedAt: Date;
}): Promise<boolean> {
	const where = {
		organizationId: input.organizationId,
		requestId: input.requestId,
		status: "RUNNING",
	};
	if (!input.outcome.ok) {
		const { count } = await db.organizationBrandSiteFetch.updateMany({
			where,
			data: { status: "FAILED", failureCode: input.outcome.failureCode },
		});
		return count > 0;
	}
	const { count } = await db.organizationBrandSiteFetch.updateMany({
		where,
		data: {
			status: "SUCCEEDED",
			failureCode: null,
			resultWebsite: input.website,
			primaryColor: strictHexColor(input.outcome.primaryColor),
			accentColors: normalizeHexColorList(input.outcome.accentColors),
			fetchedAt: input.fetchedAt,
		},
	});
	return count > 0;
}
