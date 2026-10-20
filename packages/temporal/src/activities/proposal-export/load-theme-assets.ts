/**
 * The brand assets a Proposal export prints (Fizzy #2946): each logo the
 * guest-safe tokens point at, read from storage and re-encoded, so the print
 * page and the Word file carry bytes, never a key or a URL.
 *
 * Each key is checked again here, against the one place its upload writes,
 * before a byte is read: the organization logo is `{organizationId}.png` in
 * the avatars bucket, a recipient logo sits under this project's promoted
 * recipient-brand prefix. A logo that fails a check, cannot be read, would
 * overrun the export's image budget or does not decode is left off the
 * cover, and the export says so with one warning.
 */

import { config } from "@repo/config";
import {
	isRecipientLogoKeyForProject,
	trustedOrganizationLogoKey,
} from "@repo/database";
import {
	mapThemeAssets,
	type ProposalThemeTokens,
	type ThemeAssetRef,
} from "@repo/utils/proposal-artifact/theme-tokens";
import type { ExportImageBudget } from "../../lib/proposal-export/extract-document-images";
import { normalizeExportImage } from "../../lib/proposal-export/normalize-image";
import { readStoredObjectWithin } from "../../lib/proposal-export/read-stored-object";
import {
	type ExportThemeTokens,
	PROPOSAL_EXPORT_LIMITS,
	type ProposalExportWarning,
} from "../../lib/proposal-export/types";

/**
 * The longest edge a logo is kept at: the cover draws one at most 2.75 inches
 * wide, which this covers at print resolution.
 */
const LOGO_MAX_EDGE = 1200;

/** Where a stored asset lives. */
export interface ThemeAssetLocation {
	bucket: string;
	key: string;
}

/** Reads one stored asset's bytes; throws when it cannot. */
export type ThemeAssetReader = (
	location: ThemeAssetLocation,
) => Promise<Buffer>;

/** Abandons the read as soon as the object passes the per-image cap. */
const readStoredAsset: ThemeAssetReader = (location) =>
	readStoredObjectWithin(location, PROPOSAL_EXPORT_LIMITS.maxImageBytes);

/** The asset's storage location, or null when its key fails its check. */
export function themeAssetLocation(
	ref: ThemeAssetRef,
	scope: { organizationId: string; projectId: string },
): ThemeAssetLocation | null {
	switch (ref.kind) {
		case "organization-logo":
			return trustedOrganizationLogoKey(ref.key, scope.organizationId) ===
				ref.key
				? { bucket: config.storage.bucketNames.avatars, key: ref.key }
				: null;
		case "recipient-logo":
			return isRecipientLogoKeyForProject(scope.projectId, ref.key)
				? {
						bucket: config.storage.bucketNames.projectContexts,
						key: ref.key,
					}
				: null;
		default:
			return null;
	}
}

/** Every asset of the tokens as print-ready bytes, or left out. */
export async function loadThemeAssets(input: {
	tokens: ProposalThemeTokens;
	organizationId: string;
	projectId: string;
	budget: ExportImageBudget;
	read?: ThemeAssetReader;
}): Promise<{ tokens: ExportThemeTokens; warnings: ProposalExportWarning[] }> {
	const read = input.read ?? readStoredAsset;
	let unavailable = 0;
	const tokens = await mapThemeAssets(input.tokens, async (ref) => {
		const location = themeAssetLocation(ref, input);
		if (!location) {
			unavailable++;
			return null;
		}
		try {
			const bytes = await read(location);
			// As for the document's images: an object over the per-image cap
			// is dropped without spending the shared budget on it.
			if (
				bytes.byteLength > PROPOSAL_EXPORT_LIMITS.maxImageBytes ||
				!input.budget.charge(bytes.byteLength)
			) {
				unavailable++;
				return null;
			}
			const result = await normalizeExportImage(bytes, {
				maxEdge: LOGO_MAX_EDGE,
			});
			if (!result.ok) {
				unavailable++;
				return null;
			}
			return result.image;
		} catch {
			unavailable++;
			return null;
		}
	});
	return {
		tokens,
		warnings:
			unavailable > 0
				? [{ code: "LOGO_UNAVAILABLE", count: unavailable }]
				: [],
	};
}
