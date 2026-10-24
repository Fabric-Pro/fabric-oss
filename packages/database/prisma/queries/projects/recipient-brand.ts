/**
 * A project's recipient brand (Fizzy #2589): the name, website, logo and
 * colors of the party an edition is prepared for. One row per project.
 *
 * Confirmation is a compare-and-set on `version`: every writer names the
 * version it read, so one editor cannot overwrite another's confirmation, or
 * confirm a logo the other uploaded, without seeing it first. Version 0 means
 * "no row yet". The logo object itself is promoted by the procedure (copy the
 * pending upload to a new immutable key, then this compare-and-set, then
 * cleanup), so storage and database never disagree about the current logo.
 */

import { HEX_COLOR_PATTERN } from "@repo/utils/brand-colors";
import { isBrandWebsiteHost } from "@repo/utils/proposal-artifact/brand-sources";
import { db } from "../../client";

export const RECIPIENT_BRAND_MAX_COLORS = 3;
export const RECIPIENT_BRAND_MAX_NAME_LENGTH = 200;

const PROMOTION_ID = /^[A-Za-z0-9_-]+$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** The only key a confirmed recipient logo may have, for this project. */
export function recipientLogoKeyPrefix(projectId: string): string {
	return `project-brand/${projectId}/recipient-brand/current/`;
}

/**
 * Whether `key` is a promoted recipient logo of THIS project:
 * `project-brand/{projectId}/recipient-brand/current/{promotionId}.png`.
 * The migration's CHECK constraint enforces the same shape in the database.
 */
export function isRecipientLogoKeyForProject(
	projectId: string,
	key: string,
): boolean {
	const prefix = recipientLogoKeyPrefix(projectId);
	if (!key.startsWith(prefix) || !key.endsWith(".png")) {
		return false;
	}
	return PROMOTION_ID.test(key.slice(prefix.length, -".png".length));
}

export type RecipientBrandValidationCode =
	| "nameTooLong"
	| "invalidWebsite"
	| "invalidLogoKey"
	| "tooManyColors"
	| "invalidColor";

export class RecipientBrandValidationError extends Error {
	constructor(readonly code: RecipientBrandValidationCode) {
		super(`Invalid recipient brand: ${code}`);
		this.name = "RecipientBrandValidationError";
	}
}

export interface RecipientBrandFields {
	name: string | null;
	website: string | null;
	logoKey: string | null;
	colors: string[];
}

/**
 * Validate and normalize recipient brand fields: trimmed name (empty becomes
 * null) of at most 200 UTF-16 code units, website as `https://host` with a
 * host of lowercase letters, digits, dots and hyphens, a logo key under this
 * project's current prefix, and up to three lowercase `#rrggbb` colors.
 */
export function normalizeRecipientBrandFields(
	projectId: string,
	input: {
		name?: string | null;
		website?: string | null;
		logoKey?: string | null;
		colors?: string[];
	},
): RecipientBrandFields {
	const name = input.name?.trim() || null;
	if (name && name.length > RECIPIENT_BRAND_MAX_NAME_LENGTH) {
		throw new RecipientBrandValidationError("nameTooLong");
	}

	const website = normalizeWebsite(input.website);

	const logoKey = input.logoKey || null;
	if (logoKey && !isRecipientLogoKeyForProject(projectId, logoKey)) {
		throw new RecipientBrandValidationError("invalidLogoKey");
	}

	const colors = input.colors ?? [];
	if (colors.length > RECIPIENT_BRAND_MAX_COLORS) {
		throw new RecipientBrandValidationError("tooManyColors");
	}
	if (!colors.every((color) => HEX_COLOR_PATTERN.test(color))) {
		throw new RecipientBrandValidationError("invalidColor");
	}

	return {
		name,
		website,
		logoKey,
		colors: colors.map((color) => color.toLowerCase()),
	};
}

function normalizeWebsite(website: string | null | undefined): string | null {
	const trimmed = website?.trim();
	if (!trimmed) {
		return null;
	}
	let url: URL;
	try {
		url = new URL(trimmed);
	} catch {
		throw new RecipientBrandValidationError("invalidWebsite");
	}
	// The host as the parser writes it (an IDN as punycode); an IP literal or
	// a name with any other character is refused, as the fetch rows' CHECK
	// constraints would refuse it.
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.port ||
		url.pathname !== "/" ||
		url.search ||
		url.hash ||
		!isBrandWebsiteHost(url.hostname)
	) {
		throw new RecipientBrandValidationError("invalidWebsite");
	}
	return url.origin;
}

export interface RecipientBrandView extends RecipientBrandFields {
	projectId: string;
	organizationId: string;
	/** SHA-256 of the promoted logo; null for a logo promoted before it existed. */
	logoHash: string | null;
	version: number;
	updatedById: string | null;
	updatedAt: Date;
}

const RECIPIENT_BRAND_SELECT = {
	projectId: true,
	organizationId: true,
	name: true,
	website: true,
	logoKey: true,
	logoHash: true,
	colors: true,
	version: true,
	updatedById: true,
	updatedAt: true,
} as const;

/** The project's recipient brand, or null when none has been confirmed. */
export async function getRecipientBrand(
	projectId: string,
): Promise<RecipientBrandView | null> {
	return db.projectRecipientBrand.findUnique({
		where: { projectId },
		select: RECIPIENT_BRAND_SELECT,
	});
}

export interface ConfirmRecipientBrandInput {
	projectId: string;
	/** The version the editor read; 0 when the project had no recipient brand. */
	expectedVersion: number;
	name?: string | null;
	website?: string | null;
	/** The promoted key, `project-brand/{projectId}/recipient-brand/current/…`. */
	logoKey?: string | null;
	/** SHA-256 (hex) of the promoted logo's bytes; kept only with a logo. */
	logoHash?: string | null;
	colors?: string[];
	updatedById: string;
	/** The organization the gate resolved; checked against the project's. */
	organizationId?: string;
	/**
	 * When the values come from a website fetch's suggestion: the attempt the
	 * editor saw. The write applies only while that attempt is still the
	 * stored, successful one for the row's current website, checked under the
	 * same row lock a new fetch takes, so a fetch that replaced the
	 * suggestion meanwhile turns the confirmation `stale`.
	 */
	suggestion?: { requestId: string };
}

export type ConfirmRecipientBrandResult =
	| {
			outcome: "applied";
			version: number;
			/** The logo key this confirmation replaced, for best-effort cleanup. */
			previousLogoKey: string | null;
	  }
	| { outcome: "conflict" }
	| { outcome: "stale" };

/**
 * Save the recipient brand if nobody changed it since `expectedVersion` was
 * read. `conflict` writes nothing; the caller deletes the object it promoted
 * for this attempt and asks the editor to reload.
 */
export async function confirmRecipientBrand(
	input: ConfirmRecipientBrandInput,
): Promise<ConfirmRecipientBrandResult> {
	const fields = normalizeRecipientBrandFields(input.projectId, input);
	const logoHash =
		fields.logoKey && input.logoHash && SHA256_HEX.test(input.logoHash)
			? input.logoHash
			: null;
	const project = await db.project.findUnique({
		where: { id: input.projectId },
		select: { organizationId: true },
	});
	const organizationId = project?.organizationId;
	if (!organizationId) {
		throw new Error("The project is not in an organization");
	}
	if (input.organizationId && input.organizationId !== organizationId) {
		throw new Error("The project belongs to another organization");
	}

	if (input.expectedVersion === 0 && !input.suggestion) {
		// ON CONFLICT DO NOTHING: of two first confirmations, one inserts and
		// the other sees a row it did not read, which is a conflict.
		const { count } = await db.projectRecipientBrand.createMany({
			data: [
				{
					projectId: input.projectId,
					organizationId,
					...fields,
					logoHash,
					version: 1,
					updatedById: input.updatedById,
				},
			],
			skipDuplicates: true,
		});
		return count > 0
			? { outcome: "applied", version: 1, previousLogoKey: null }
			: { outcome: "conflict" };
	}

	return db.$transaction(async (tx) => {
		if (input.suggestion) {
			// The lock a fetch's start takes before it replaces the suggestion,
			// so the check below and that replacement cannot interleave.
			await tx.$queryRaw`
				SELECT 1 FROM "project_recipient_brand"
				WHERE "projectId" = ${input.projectId}
				FOR UPDATE`;
		}
		const current = await tx.projectRecipientBrand.findUnique({
			where: { projectId: input.projectId },
			select: { version: true, logoKey: true, website: true },
		});
		if (input.suggestion) {
			const suggestion =
				await tx.projectRecipientBrandSuggestion.findUnique({
					where: { projectId: input.projectId },
					select: {
						requestId: true,
						status: true,
						resultWebsite: true,
					},
				});
			if (
				!current?.website ||
				suggestion?.requestId !== input.suggestion.requestId ||
				suggestion.status !== "SUCCEEDED" ||
				suggestion.resultWebsite !== current.website
			) {
				return { outcome: "stale" as const };
			}
		}
		if (!current || current.version !== input.expectedVersion) {
			return { outcome: "conflict" as const };
		}
		const { count } = await tx.projectRecipientBrand.updateMany({
			where: {
				projectId: input.projectId,
				version: input.expectedVersion,
			},
			data: {
				...fields,
				logoHash,
				version: { increment: 1 },
				updatedById: input.updatedById,
			},
		});
		if (count === 0) {
			return { outcome: "conflict" as const };
		}
		// The version did not move between the read and the write, so the
		// logo read above is exactly the one this write replaced.
		return {
			outcome: "applied" as const,
			version: input.expectedVersion + 1,
			previousLogoKey: current.logoKey,
		};
	});
}
