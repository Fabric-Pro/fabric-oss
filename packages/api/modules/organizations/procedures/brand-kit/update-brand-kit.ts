import { ORPCError } from "@orpc/server";
import {
	BRAND_KIT_MAX_ACCENTS,
	BRAND_KIT_MAX_GUIDANCE_LENGTH,
	type BrandKitAssetKeys,
	type BrandKitFields,
	BrandKitValidationError,
	getBrandKit,
	normalizeBrandKitFields,
	upsertBrandKit,
} from "@repo/database";
import { normalizeWebsiteUrl } from "@repo/integrations/website-brand";
import { BRAND_ASSET_REJECTION_CODES } from "@repo/utils/brand-assets";
import { HEX_COLOR_PATTERN } from "@repo/utils/brand-colors";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireInputOrgPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertGlossyOrProposalArtifactEnabledForOrganization } from "../../../projects/lib/proposal-artifact-feature";
import {
	BRAND_KIT_ASSET_KINDS,
	type BrandKitAssetKind,
	brandKitPendingKey,
	deleteBrandKitObjects,
	listBrandKitPendingKeys,
	promoteBrandKitAsset,
} from "../../lib/brand-kit-assets";
import { requireOrgMembership } from "../../lib/membership";
import { brandKitOutputSchema, presentBrandKit } from "./get-brand-kit";

/** What a save does with one stored file. */
const assetActionSchema = z.discriminatedUnion("action", [
	z.object({ action: z.literal("keep") }),
	z.object({ action: z.literal("remove") }),
	z.object({
		action: z.literal("replace"),
		/** The token `brandKit.createAssetUploadUrl` returned. */
		token: z.string().max(128),
	}),
]);

type AssetAction = z.infer<typeof assetActionSchema>;

/** The kit column each file is stored in. */
const ASSET_COLUMNS = {
	hero: "heroKey",
	displayFont: "displayFontKey",
	bodyFont: "bodyFontKey",
} as const satisfies Record<BrandKitAssetKind, keyof BrandKitAssetKeys>;

/** The family a font file is uploaded for. */
const FONT_FAMILIES = {
	displayFont: "displayFontFamily",
	bodyFont: "bodyFontFamily",
} as const;

function invalid(code: string): ORPCError<"BAD_REQUEST", unknown> {
	return new ORPCError("BAD_REQUEST", {
		message: "The Brand kit is not valid",
		data: { code },
	});
}

function conflict(): ORPCError<"CONFLICT", unknown> {
	return new ORPCError("CONFLICT", {
		message: "Someone else changed the Brand kit. Reload it and try again.",
	});
}

/**
 * After a save failed with an error: delete the files it promoted unless the
 * stored kit points at them, and nothing when the kit cannot be read.
 */
async function deleteUnsavedBrandKitKeys(
	organizationId: string,
	promotedKeys: string[],
): Promise<void> {
	if (promotedKeys.length === 0) {
		return;
	}
	let stored: Awaited<ReturnType<typeof getBrandKit>>;
	try {
		stored = await getBrandKit(organizationId);
	} catch {
		return;
	}
	const referenced = new Set(
		Object.values(ASSET_COLUMNS).map((column) => stored?.[column] ?? null),
	);
	await deleteBrandKitObjects(
		organizationId,
		promotedKeys.filter((key) => !referenced.has(key)),
	);
}

/**
 * Update the organization's Brand kit (Fizzy #2589, extended in Fizzy #2946).
 *
 * Writes `OrganizationBrandKit` only. The named brand color and the logo stay
 * in organization metadata and are not touched: the auth library writes that
 * metadata wholesale, so nothing here reads or writes it, and the primary is
 * never filled from the named brand color.
 *
 * A field left out keeps what is stored, so a caller that knows only the
 * accents and guidance (the Glossy-era form, an API client) changes nothing
 * else. With `expectedVersion` the save applies only if nobody saved since
 * that version was read (CONFLICT otherwise); without it, it applies over
 * whatever is stored.
 *
 * A new hero or font file is named by the token its upload returned and is
 * promoted in three ordered steps so storage and database never disagree:
 *   1. everything is validated, then each upload is checked and copied to a
 *      new immutable key; a refused upload answers `assetRejected` with the
 *      code the browser's pre-check uses, and nothing is saved;
 *   2. the version compare-and-set records the keys;
 *   3. on success, the superseded files, the uploads this save used and
 *      every pending upload older than 15 minutes are deleted (each belongs
 *      to a save that read an older version and can now only conflict); on
 *      a conflict, the files this attempt promoted are deleted; on an error,
 *      only those the stored kit does not point at, since the save may have
 *      committed with only its answer lost.
 * Step 3 is best-effort: a leftover object is unreferenced and stays under
 * the organization's prefix, which the organization purge sweeps.
 *
 * AUTHORIZATION: `ORG_UPDATE` against the requested organization, then admin
 * or owner membership of it, then the Brand kit gate (GLOSSY_EDITION or
 * PROPOSAL_ARTIFACT for that organization).
 */
export const updateBrandKitProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_UPDATE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "PUT",
		path: "/organizations/{organizationId}/brand-kit",
		tags: ["Organizations", "Glossy"],
		summary: "Update the organization Brand kit",
		description:
			"Set the colors, fonts, hero image, website and brand guidance used to style the organization's Glossy editions and Proposals.",
	})
	.input(
		z.object({
			organizationId: z.string(),
			/** The version `brandKit.get` returned; 0 when there was none. */
			expectedVersion: z.number().int().min(0).optional(),
			accentColors: z
				.array(z.string().regex(HEX_COLOR_PATTERN))
				.max(BRAND_KIT_MAX_ACCENTS),
			guidance: z.string().max(BRAND_KIT_MAX_GUIDANCE_LENGTH).nullable(),
			primaryColor: z
				.string()
				.regex(HEX_COLOR_PATTERN)
				.nullable()
				.optional(),
			displayFontFamily: z.string().max(128).nullable().optional(),
			bodyFontFamily: z.string().max(128).nullable().optional(),
			website: z.string().max(2048).nullable().optional(),
			assets: z
				.object({
					hero: assetActionSchema.optional(),
					displayFont: assetActionSchema.optional(),
					bodyFont: assetActionSchema.optional(),
				})
				.optional(),
		}),
	)
	.output(
		z.discriminatedUnion("outcome", [
			z.object({
				outcome: z.literal("applied"),
				brandKit: brandKitOutputSchema,
			}),
			z.object({
				outcome: z.literal("assetRejected"),
				kind: z.enum(BRAND_KIT_ASSET_KINDS),
				code: z.enum(BRAND_ASSET_REJECTION_CODES),
			}),
		]),
	)
	.handler(async ({ context, input }) => {
		const { organizationId, expectedVersion } = input;

		const membership = await requireOrgMembership(
			context.user.id,
			organizationId,
			["admin", "owner"],
		);
		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You must be an admin or owner of this organization",
			});
		}
		await assertGlossyOrProposalArtifactEnabledForOrganization(
			organizationId,
		);

		// Everything the compare-and-set will validate, validated BEFORE a
		// file is promoted, so a typo cannot leave an orphaned object behind.
		let website: string | null | undefined;
		if (input.website !== undefined) {
			website = input.website?.trim()
				? normalizeWebsiteUrl(input.website)
				: null;
			if (input.website?.trim() && !website) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Enter the organization's public website, like example.com",
					data: { code: "invalidWebsite" },
				});
			}
		}
		let fields: BrandKitFields;
		try {
			fields = normalizeBrandKitFields({
				accentColors: input.accentColors,
				guidance: input.guidance,
				primaryColor: input.primaryColor,
				displayFontFamily: input.displayFontFamily,
				bodyFontFamily: input.bodyFontFamily,
				website,
			});
		} catch (error) {
			if (error instanceof BrandKitValidationError) {
				throw invalid(error.code);
			}
			throw error;
		}

		const actions: [BrandKitAssetKind, AssetAction][] =
			BRAND_KIT_ASSET_KINDS.map((kind) => [
				kind,
				input.assets?.[kind] ?? { action: "keep" },
			]);
		for (const [, action] of actions) {
			if (action.action === "replace") {
				// Refuses a key, a path or another organization's prefix
				// before storage is touched.
				brandKitPendingKey(organizationId, action.token);
			}
		}

		// An early answer for the common stale case, and the stored state a
		// font file is checked against. The compare-and-set below stays the
		// authority; this only spares a promotion that could not win.
		const current = await getBrandKit(organizationId);
		if (
			expectedVersion !== undefined &&
			(current?.version ?? 0) !== expectedVersion
		) {
			throw conflict();
		}
		for (const kind of ["displayFont", "bodyFont"] as const) {
			const action = input.assets?.[kind]?.action ?? "keep";
			const family = FONT_FAMILIES[kind];
			const hasFile =
				action === "replace" ||
				(action === "keep" && Boolean(current?.[ASSET_COLUMNS[kind]]));
			const nextFamily =
				fields[family] !== undefined
					? fields[family]
					: (current?.[family] ?? null);
			if (hasFile && !nextFamily) {
				throw invalid("fontWithoutFamily");
			}
		}

		const assets: BrandKitAssetKeys = {};
		const promotedKeys: string[] = [];
		try {
			for (const [kind, action] of actions) {
				if (action.action === "remove") {
					assets[ASSET_COLUMNS[kind]] = null;
				} else if (action.action === "replace") {
					const promotion = await promoteBrandKitAsset(
						organizationId,
						kind,
						action.token,
					);
					if (!promotion.ok) {
						await deleteBrandKitObjects(
							organizationId,
							promotedKeys,
						);
						return {
							outcome: "assetRejected" as const,
							kind,
							code: promotion.code,
						};
					}
					promotedKeys.push(promotion.key);
					assets[ASSET_COLUMNS[kind]] = promotion.key;
				}
			}
		} catch (error) {
			await deleteBrandKitObjects(organizationId, promotedKeys);
			throw error;
		}

		let saved: Awaited<ReturnType<typeof upsertBrandKit>>;
		try {
			saved = await upsertBrandKit({
				organizationId,
				...fields,
				assets,
				expectedVersion,
				updatedById: context.user.id,
			});
		} catch (error) {
			if (error instanceof BrandKitValidationError) {
				await deleteBrandKitObjects(organizationId, promotedKeys);
				throw invalid(error.code);
			}
			await deleteUnsavedBrandKitKeys(organizationId, promotedKeys);
			throw error;
		}
		if (saved.outcome === "conflict") {
			await deleteBrandKitObjects(organizationId, promotedKeys);
			throw conflict();
		}

		const usedUploads = actions.flatMap(([, action]) =>
			action.action === "replace"
				? [brandKitPendingKey(organizationId, action.token)]
				: [],
		);
		const pendingKeys = await listBrandKitPendingKeys(organizationId);
		await deleteBrandKitObjects(organizationId, [
			...saved.supersededKeys,
			...usedUploads,
			...pendingKeys,
		]);

		// Field names only — guidance is free text an audit reader does not
		// need, colors are visible on the settings page itself, and storage
		// keys stay out of the audit row.
		recordAuditFromRequest(context, {
			action: "org.brand_kit.updated",
			category: "org",
			organizationId,
			resource: { type: "organization", id: organizationId, name: null },
			metadata: { changedFields: saved.changedFields },
		});

		return {
			outcome: "applied" as const,
			brandKit: await presentBrandKit(organizationId, saved.brandKit),
		};
	});
