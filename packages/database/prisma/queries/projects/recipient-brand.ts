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
import { db } from "../../client";

export const RECIPIENT_BRAND_MAX_COLORS = 3;
export const RECIPIENT_BRAND_MAX_NAME_LENGTH = 200;

const PROMOTION_ID = /^[A-Za-z0-9_-]+$/;

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
 * null), website as `https://host`, a logo key under this project's current
 * prefix, and up to three lowercase `#rrggbb` colors.
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
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.port ||
		url.pathname !== "/" ||
		url.search ||
		url.hash
	) {
		throw new RecipientBrandValidationError("invalidWebsite");
	}
	return url.origin;
}

export interface RecipientBrandView extends RecipientBrandFields {
	projectId: string;
	organizationId: string;
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
	colors?: string[];
	updatedById: string;
	/** The organization the gate resolved; checked against the project's. */
	organizationId?: string;
}

export type ConfirmRecipientBrandResult =
	| {
			outcome: "applied";
			version: number;
			/** The logo key this confirmation replaced, for best-effort cleanup. */
			previousLogoKey: string | null;
	  }
	| { outcome: "conflict" };

/**
 * Save the recipient brand if nobody changed it since `expectedVersion` was
 * read. `conflict` writes nothing; the caller deletes the object it promoted
 * for this attempt and asks the editor to reload.
 */
export async function confirmRecipientBrand(
	input: ConfirmRecipientBrandInput,
): Promise<ConfirmRecipientBrandResult> {
	const fields = normalizeRecipientBrandFields(input.projectId, input);
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

	if (input.expectedVersion === 0) {
		// ON CONFLICT DO NOTHING: of two first confirmations, one inserts and
		// the other sees a row it did not read, which is a conflict.
		const { count } = await db.projectRecipientBrand.createMany({
			data: [
				{
					projectId: input.projectId,
					organizationId,
					...fields,
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
		const current = await tx.projectRecipientBrand.findUnique({
			where: { projectId: input.projectId },
			select: { version: true, logoKey: true },
		});
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
