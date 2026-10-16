import { config } from "@repo/config";
import {
	isRecipientLogoKeyForProject,
	trustedOrganizationLogoKey,
} from "@repo/database";
import { getStorageProvider } from "@repo/storage";
import type {
	ThemeAssetRef,
	ThemeAssetUrl,
} from "@repo/utils/proposal-artifact/theme-tokens";
import { signRecipientLogoRead } from "./recipient-brand";

/**
 * Signed reads of the two brand logos a document can wear (Fizzy #2946): the
 * organization's own logo and the recipient brand's logo. The Glossy edition
 * and the Proposal theme both sign through here, so the bucket, the inline
 * PNG response and the key checks stay one implementation.
 *
 * A signed URL is handed to whoever may read the document, project guests
 * included, so every key is checked again here against the one prefix its
 * upload writes, even when the resolver that produced it already did: a
 * reference that drifted (a stored value, a new caller) never reaches
 * storage unchecked.
 */

/**
 * How long a theme asset read lasts: as long as the recipient brand's own
 * preview read. The live page asks for its tokens again whenever it is shown
 * after a minute, and these reads reach project guests, so a guest removed
 * from the project keeps a working logo link for minutes, not an hour.
 */
const THEME_ASSET_READ_TTL_SECONDS = 5 * 60;

/**
 * A signed read of the organization's uploaded logo, rendered inline as the
 * PNG its upload writes. The caller has already passed the key through
 * `trustedOrganizationLogoKey`.
 */
export async function signOrganizationLogoRead(
	key: string,
	expiresIn: number,
): Promise<string> {
	return getStorageProvider().getSignedUrl(key, {
		bucket: config.storage.bucketNames.avatars,
		expiresIn,
		responseContentType: "image/png",
		responseContentDisposition: "inline",
	});
}

/**
 * One theme asset as a signed read, or null. The key is checked for its kind
 * first: an organization logo must be exactly that organization's upload key,
 * a recipient logo a promoted logo of this very project. A key that fails is
 * null before storage is touched. Best-effort like the recipient brand's own
 * read: a storage failure leaves the page without that logo rather than
 * failing the read that carries it.
 *
 * `organizationId` must be the project's OWNING organization.
 */
export async function signThemeAsset(
	ref: ThemeAssetRef,
	ctx: { organizationId: string; projectId: string },
	expiresIn: number = THEME_ASSET_READ_TTL_SECONDS,
): Promise<ThemeAssetUrl | null> {
	try {
		switch (ref.kind) {
			case "organization-logo": {
				const key = trustedOrganizationLogoKey(
					ref.key,
					ctx.organizationId,
				);
				return key
					? { url: await signOrganizationLogoRead(key, expiresIn) }
					: null;
			}
			case "recipient-logo":
				return isRecipientLogoKeyForProject(ctx.projectId, ref.key)
					? { url: await signRecipientLogoRead(ref.key, expiresIn) }
					: null;
			default:
				return null;
		}
	} catch {
		return null;
	}
}
