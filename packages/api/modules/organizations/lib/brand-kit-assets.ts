import { randomBytes, randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { normalizeHeroImage } from "@repo/integrations/website-brand";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import {
	BRAND_ASSET_MAX_BYTES,
	BRAND_FONT_CONTENT_TYPES,
	type BrandAssetKind,
	type BrandAssetRejectionCode,
} from "@repo/utils/brand-assets";
import {
	isOrganizationFontKey,
	isOrganizationHeroKey,
	organizationBrandPendingPrefix,
	organizationBrandPrefix,
} from "@repo/utils/proposal-artifact/brand-sources";
import { decodeBrandFont } from "../../../lib/brand-font";

/**
 * The Brand kit's stored files (Fizzy #2946): its hero image and its display
 * and body font files, and the only place their storage keys are built.
 *
 * An upload goes by signed PUT to `organization-brand/{organizationId}/pending/{token}`
 * in the private `projectContexts` bucket. A Brand kit save names the token;
 * the server reads the stored size first, then checks the bytes, and copies
 * them to a new immutable key (`…/hero/{id}.{png|jpg}`, `…/fonts/{id}.{woff2|ttf}`)
 * before the save's compare-and-set records it. Keys are built HERE from the
 * verified organization id and a server-generated token; a client never names
 * a key, so it can never point a save at another organization's object, a
 * workspace file, or a path with `..` in it.
 */

/** The Brand kit's files, as a save and an upload name them. */
export const BRAND_KIT_ASSET_KINDS = [
	"hero",
	"displayFont",
	"bodyFont",
] as const;
export type BrandKitAssetKind = (typeof BRAND_KIT_ASSET_KINDS)[number];

/** A signed PUT is used at once, from the form that asked for it. */
export const BRAND_KIT_UPLOAD_URL_TTL_SECONDS = 300;

/** Signed reads are for rendering a preview right now, not for sharing. */
const BRAND_KIT_READ_URL_TTL_SECONDS = 300;

/**
 * How old a pending upload must be before another save sweeps it. A younger
 * one may belong to a form still open (another admin's, or another tab),
 * whose own save would otherwise find its upload gone.
 */
const BRAND_KIT_PENDING_SWEEP_MIN_AGE_MS = 15 * 60_000;

/** 24 random bytes as base64url: exactly this shape, nothing else. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

/** The upload vocabulary a Brand kit file is checked against. */
export function brandKitAssetVocabulary(
	kind: BrandKitAssetKind,
): BrandAssetKind {
	return kind === "hero" ? "hero" : "font";
}

export function brandKitBucket(): string {
	return config.storage.bucketNames.projectContexts;
}

/** A new, unguessable name for one pending upload. */
export function newBrandKitAssetToken(): string {
	return randomBytes(24).toString("base64url");
}

/**
 * The pending object a token names, for THIS organization. Refuses anything
 * that is not a token — a key, a path, `..`, another organization's prefix —
 * before it can reach storage.
 */
export function brandKitPendingKey(
	organizationId: string,
	token: unknown,
): string {
	if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) {
		throw new ORPCError("BAD_REQUEST", {
			message: "The Brand kit upload is not valid",
		});
	}
	return `${organizationBrandPendingPrefix(organizationId)}${token}`;
}

/**
 * A new immutable key for a promoted file, with a fresh server-generated id.
 * The shape is exactly what the column's predicate and CHECK constraint
 * accept; a mismatch fails before any object is written.
 */
function newBrandKitAssetKey(
	organizationId: string,
	kind: BrandKitAssetKind,
	extension: "png" | "jpg" | "woff2" | "ttf",
): string {
	const folder = kind === "hero" ? "hero" : "fonts";
	const key = `${organizationBrandPrefix(organizationId)}${folder}/${randomUUID()}.${extension}`;
	const valid =
		kind === "hero"
			? isOrganizationHeroKey(organizationId, key)
			: isOrganizationFontKey(organizationId, key);
	if (!valid) {
		// Unreachable unless the builder and the predicates drift apart.
		throw new Error("Brand kit key does not match its column's shape");
	}
	return key;
}

function storageFailure(): ORPCError<"INTERNAL_SERVER_ERROR", unknown> {
	return new ORPCError("INTERNAL_SERVER_ERROR", {
		message: "Could not save the Brand kit file",
	});
}

type BrandKitPromotion =
	| { ok: true; key: string }
	| { ok: false; code: BrandAssetRejectionCode };

type CheckedBytes =
	| {
			ok: true;
			bytes: Buffer;
			extension: "png" | "jpg" | "woff2" | "ttf";
			contentType: string;
	  }
	| { ok: false; code: BrandAssetRejectionCode };

async function checkBytes(
	kind: BrandKitAssetKind,
	bytes: Buffer,
): Promise<CheckedBytes> {
	if (kind === "hero") {
		const hero = await normalizeHeroImage(bytes);
		if (!hero.ok) {
			return hero;
		}
		return hero.format === "png"
			? {
					ok: true,
					bytes: hero.bytes,
					extension: "png",
					contentType: "image/png",
				}
			: {
					ok: true,
					bytes: hero.bytes,
					extension: "jpg",
					contentType: "image/jpeg",
				};
	}
	// A font is stored as uploaded once it decodes: its bytes decide its
	// format, whatever type it was signed for.
	if (bytes.byteLength > BRAND_ASSET_MAX_BYTES.font) {
		return { ok: false, code: "too_large" };
	}
	const format = decodeBrandFont(bytes);
	if (!format) {
		return { ok: false, code: "unsupported" };
	}
	return {
		ok: true,
		bytes,
		extension: format,
		contentType: BRAND_FONT_CONTENT_TYPES[format],
	};
}

/**
 * Check the pending upload a token names and copy it to a new immutable key.
 * Nothing references the new object yet, so any failure here changes
 * nothing. The stored size is read first, and an object over its kind's cap
 * is refused without its bytes being read. A refused upload is deleted and
 * answered with the code the browser's pre-check uses for the same file.
 */
export async function promoteBrandKitAsset(
	organizationId: string,
	kind: BrandKitAssetKind,
	token: string,
): Promise<BrandKitPromotion> {
	const pendingKey = brandKitPendingKey(organizationId, token);
	const storage = getStorageProvider();
	const bucket = brandKitBucket();

	let metadata: Awaited<ReturnType<typeof storage.getFileMetadata>>;
	try {
		metadata = await storage.getFileMetadata(pendingKey, { bucket });
	} catch {
		throw storageFailure();
	}
	if (!metadata) {
		// Never uploaded, already consumed, or cleaned up after another
		// admin's save.
		throw new ORPCError("BAD_REQUEST", {
			message: "The Brand kit upload was not found. Upload it again.",
		});
	}

	let checked: CheckedBytes;
	if (metadata.size > BRAND_ASSET_MAX_BYTES[brandKitAssetVocabulary(kind)]) {
		checked = { ok: false, code: "too_large" };
	} else {
		let bytes: Buffer;
		try {
			bytes = (await storage.downloadFile(pendingKey, { bucket })).data;
		} catch {
			throw storageFailure();
		}
		checked = await checkBytes(kind, bytes);
	}
	if (!checked.ok) {
		await deleteBrandKitObjects(organizationId, [pendingKey]);
		return { ok: false, code: checked.code };
	}

	const key = newBrandKitAssetKey(organizationId, kind, checked.extension);
	try {
		await storage.uploadFile(key, checked.bytes, {
			bucket,
			contentType: checked.contentType,
		});
	} catch {
		throw storageFailure();
	}
	return { ok: true, key };
}

/**
 * A short-lived signed read of the organization's hero, inline, or null for
 * a key that is not this organization's hero.
 */
export async function signBrandKitHeroRead(
	organizationId: string,
	key: string,
	expiresIn: number = BRAND_KIT_READ_URL_TTL_SECONDS,
): Promise<string | null> {
	if (!isOrganizationHeroKey(organizationId, key)) {
		return null;
	}
	return getStorageProvider().getSignedUrl(key, {
		bucket: brandKitBucket(),
		expiresIn,
		responseContentType: key.endsWith(".png") ? "image/png" : "image/jpeg",
		responseContentDisposition: "inline",
	});
}

/**
 * Best-effort deletion after a save. A leftover object is unreferenced and
 * stays under the organization's prefix, which the organization purge sweeps,
 * so a failure here is logged, never thrown. Only keys under this
 * organization's prefix are ever deleted.
 */
export async function deleteBrandKitObjects(
	organizationId: string,
	keys: string[],
): Promise<void> {
	const prefix = organizationBrandPrefix(organizationId);
	const unique = [...new Set(keys)].filter((key) => key.startsWith(prefix));
	if (unique.length === 0) {
		return;
	}
	try {
		const result = await getStorageProvider().deleteObjects(unique, {
			bucket: brandKitBucket(),
		});
		if (result.errors.length > 0) {
			logger.warn(
				`[BrandKit] ${result.errors.length} object(s) left for organization ${organizationId}`,
			);
		}
	} catch (error) {
		logger.warn(
			`[BrandKit] cleanup failed for organization ${organizationId}: ${
				error instanceof Error ? error.name : "unknown"
			}`,
		);
	}
}

/**
 * Every pending upload of the organization older than
 * {@link BRAND_KIT_PENDING_SWEEP_MIN_AGE_MS}, for cleanup after a save
 * applies. Best-effort like the deletion it feeds: a listing failure leaves
 * the objects for the organization purge.
 */
export async function listBrandKitPendingKeys(
	organizationId: string,
	now: Date = new Date(),
): Promise<string[]> {
	const cutoff = now.getTime() - BRAND_KIT_PENDING_SWEEP_MIN_AGE_MS;
	const keys: string[] = [];
	try {
		let continuationToken: string | undefined;
		// An organization has a handful of pending uploads; the page bound
		// only stops a misbehaving listing from looping.
		for (let page = 0; page < 10; page++) {
			const result = await getStorageProvider().listObjects({
				bucket: brandKitBucket(),
				prefix: organizationBrandPendingPrefix(organizationId),
				continuationToken,
			});
			for (const object of result.objects) {
				if (object.lastModified.getTime() <= cutoff) {
					keys.push(object.key);
				}
			}
			if (!result.nextContinuationToken) {
				break;
			}
			continuationToken = result.nextContinuationToken;
		}
	} catch (error) {
		logger.warn(
			`[BrandKit] could not list pending uploads for organization ${organizationId}: ${
				error instanceof Error ? error.name : "unknown"
			}`,
		);
	}
	return keys;
}
