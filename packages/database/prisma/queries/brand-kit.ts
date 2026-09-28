/**
 * The organization Brand kit (Fizzy #2589): accent colors and brand guidance
 * text used to style Glossy editions.
 *
 * It lives in `OrganizationBrandKit`, never in organization metadata: the auth
 * library writes metadata wholesale, so a key kept there can be lost to a
 * concurrent update no compare-and-set of ours could prevent. The existing
 * named brand color stays in metadata (see `brand-color.ts`) and is neither
 * read nor written here.
 */

import { HEX_COLOR_PATTERN } from "@repo/utils/brand-colors";
import { db } from "../client";

export const BRAND_KIT_MAX_ACCENTS = 3;
export const BRAND_KIT_MAX_GUIDANCE_LENGTH = 2000;

export type BrandKitValidationCode =
	| "tooManyAccents"
	| "invalidAccent"
	| "guidanceTooLong";

export class BrandKitValidationError extends Error {
	constructor(readonly code: BrandKitValidationCode) {
		super(`Invalid Brand kit: ${code}`);
		this.name = "BrandKitValidationError";
	}
}

export interface BrandKitFields {
	accentColors: string[];
	guidance: string | null;
}

/**
 * Validate and normalize Brand kit fields: up to three `#rrggbb` accents
 * (lowercased) and guidance of at most 2,000 characters (trimmed; empty
 * becomes null).
 */
export function normalizeBrandKitFields(input: {
	accentColors: string[];
	guidance?: string | null;
}): BrandKitFields {
	if (input.accentColors.length > BRAND_KIT_MAX_ACCENTS) {
		throw new BrandKitValidationError("tooManyAccents");
	}
	if (!input.accentColors.every((color) => HEX_COLOR_PATTERN.test(color))) {
		throw new BrandKitValidationError("invalidAccent");
	}
	const guidance = input.guidance?.trim() || null;
	if (guidance && guidance.length > BRAND_KIT_MAX_GUIDANCE_LENGTH) {
		throw new BrandKitValidationError("guidanceTooLong");
	}
	return {
		accentColors: input.accentColors.map((color) => color.toLowerCase()),
		guidance,
	};
}

export interface BrandKitView extends BrandKitFields {
	organizationId: string;
	updatedById: string | null;
	updatedAt: Date;
}

const BRAND_KIT_SELECT = {
	organizationId: true,
	accentColors: true,
	guidance: true,
	updatedById: true,
	updatedAt: true,
} as const;

/** The organization's Brand kit, or null when it has never been saved. */
export async function getBrandKit(
	organizationId: string,
): Promise<BrandKitView | null> {
	return db.organizationBrandKit.findUnique({
		where: { organizationId },
		select: BRAND_KIT_SELECT,
	});
}

/**
 * The Brand kit of the organization that owns `projectId` — the only read path
 * for project guests, who are not members of that organization. The caller
 * has already passed the project gate; the organization comes from the
 * project row and never from the caller. Null for an unknown project, a
 * project outside any organization, or an organization with no kit.
 */
export async function getBrandKitForProject(
	projectId: string,
): Promise<BrandKitView | null> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true },
	});
	if (!project?.organizationId) {
		return null;
	}
	return getBrandKit(project.organizationId);
}

export type BrandKitField = keyof BrandKitFields;

/**
 * Create or update the organization's Brand kit. Returns the saved kit and the
 * names of the fields that changed, for an audit entry that lists field names
 * only.
 */
export async function upsertBrandKit(input: {
	organizationId: string;
	accentColors: string[];
	guidance?: string | null;
	updatedById: string;
}): Promise<{ brandKit: BrandKitView; changedFields: BrandKitField[] }> {
	const fields = normalizeBrandKitFields(input);
	const previous = await getBrandKit(input.organizationId);
	const brandKit = await db.organizationBrandKit.upsert({
		where: { organizationId: input.organizationId },
		create: {
			organizationId: input.organizationId,
			...fields,
			updatedById: input.updatedById,
		},
		update: { ...fields, updatedById: input.updatedById },
		select: BRAND_KIT_SELECT,
	});
	const changedFields: BrandKitField[] = [];
	if (
		(previous?.accentColors ?? []).join(",") !==
		fields.accentColors.join(",")
	) {
		changedFields.push("accentColors");
	}
	if ((previous?.guidance ?? null) !== fields.guidance) {
		changedFields.push("guidance");
	}
	return { brandKit, changedFields };
}
