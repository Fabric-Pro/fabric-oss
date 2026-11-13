/**
 * Storage side of release-notes images, shared by the API (uploads and the
 * approval) and the worker (automatic captures, and a send that goes out
 * without review).
 *
 * Imported by its path, never through the package barrel: it pulls in the
 * storage provider, which nothing else in `@repo/database` needs at runtime.
 *
 * Everything lives in the private `projectContexts` bucket. Review objects sit
 * under `<tenant>/newsletter-images/<sendId>/`; publishing copies an image to
 * `newsletter-public/<32 hex>.<png|jpg>`, the one prefix the image proxy
 * serves without authentication.
 */
import { randomBytes } from "node:crypto";
import { config } from "@repo/config";
import { logger } from "@repo/logs";
import { buildTenantStoragePath, getStorageProvider } from "@repo/storage";
import { toAbsoluteUrl } from "@repo/utils/base-url";
import { NEWSLETTER_PUBLIC_IMAGE_PREFIX } from "@repo/utils/newsletter-public-image";
import type { PublishedNewsletterImage } from "./newsletter-image-embed";

/** The bucket every newsletter image object lives in. */
export function newsletterImageBucket(): string {
	return config.storage.bucketNames.projectContexts;
}

/** The tenant-owned folder of one send's review images, ending in `/`. */
export function newsletterSendImagesPrefix(
	tenant: { organizationId: string | null; userId: string | null },
	sendId: string,
): string {
	// An organization row may carry no user; the organization owns the path then.
	const userId = tenant.userId ?? tenant.organizationId;
	if (!userId) {
		throw new Error("A newsletter image belongs to no tenant");
	}
	return buildTenantStoragePath({
		organizationId: tenant.organizationId,
		userId,
		sub: `newsletter-images/${sendId}/`,
	});
}

/**
 * Best-effort deletion. A leftover object is unreferenced and unguessable,
 * so a failure is logged, never thrown — an image problem must not fail the
 * request it rides on.
 */
export async function deleteNewsletterImageObjects(
	keys: Array<string | null>,
): Promise<void> {
	const unique = [
		...new Set(keys.filter((key): key is string => Boolean(key))),
	];
	if (unique.length === 0) {
		return;
	}
	try {
		const result = await getStorageProvider().deleteObjects(unique, {
			bucket: newsletterImageBucket(),
		});
		if (result.errors.length > 0) {
			logger.warn("[Newsletter] image objects left in storage", {
				count: result.errors.length,
			});
		}
	} catch (error) {
		logger.warn("[Newsletter] image object cleanup failed", {
			error: error instanceof Error ? error.name : "unknown",
		});
	}
}

/** Pages of a send's folder listed in one cleanup; a send holds a handful. */
const SEND_FOLDER_MAX_PAGES = 5;

/**
 * Delete everything under one finished send's review folder: the review
 * images, and uploads a reviewer started but never added. Published copies
 * live under the public prefix and are kept. Call it only once the send is
 * delivered or will never go out; nothing reads its review objects then.
 * `tenant` is the project's, as the uploads were named. Best-effort like
 * `deleteNewsletterImageObjects`.
 */
export async function deleteNewsletterSendFolder(
	tenant: { organizationId: string | null; userId: string | null },
	sendId: string,
): Promise<void> {
	try {
		const storage = getStorageProvider();
		const bucket = newsletterImageBucket();
		const prefix = newsletterSendImagesPrefix(tenant, sendId);
		let continuationToken: string | undefined;
		for (let page = 0; page < SEND_FOLDER_MAX_PAGES; page++) {
			const listed = await storage.listObjects({
				bucket,
				prefix,
				continuationToken,
				maxKeys: 1000,
			});
			const keys = listed.objects.map((object) => object.key);
			if (keys.length > 0) {
				const result = await storage.deleteObjects(keys, { bucket });
				if (result.errors.length > 0) {
					logger.warn("[Newsletter] send folder objects left", {
						sendId,
						count: result.errors.length,
					});
				}
			}
			continuationToken = listed.nextContinuationToken;
			if (!continuationToken) {
				return;
			}
		}
	} catch (error) {
		logger.warn("[Newsletter] send folder cleanup failed", {
			sendId,
			error: error instanceof Error ? error.name : "unknown",
		});
	}
}

interface PublishableImage {
	id: string;
	highlightIndex: number;
	captureState: string;
	included: boolean;
	storageKey: string | null;
	/** Set by an earlier publish of this same object; reused, not replaced. */
	publicKey?: string | null;
}

/**
 * Copy every image that will go out to its public key. Only included, READY
 * images under highlights that are kept are published. A failed copy skips
 * that image (logged) and never fails the caller; the send goes out without
 * it. An image an earlier attempt already published keeps its public key, so
 * a retry leaves no second public copy behind. `afterEachCopy` runs after
 * every copy attempt, for a caller that has to report progress.
 */
export async function publishNewsletterImages(input: {
	sendId: string;
	images: readonly PublishableImage[];
	removedHighlightIndexes: number[];
	highlightCount: number;
	afterEachCopy?: () => void;
}): Promise<PublishedNewsletterImage[]> {
	const removed = new Set(input.removedHighlightIndexes);
	const published: PublishedNewsletterImage[] = [];
	for (const image of input.images) {
		if (
			!image.included ||
			image.captureState !== "READY" ||
			!image.storageKey ||
			removed.has(image.highlightIndex) ||
			image.highlightIndex >= input.highlightCount
		) {
			continue;
		}
		const extension = image.storageKey.endsWith(".png") ? "png" : "jpg";
		const fileName = `${randomBytes(16).toString("hex")}.${extension}`;
		const publicKey =
			image.publicKey ?? `${NEWSLETTER_PUBLIC_IMAGE_PREFIX}/${fileName}`;
		try {
			await getStorageProvider().copyFile(image.storageKey, publicKey, {
				bucket: newsletterImageBucket(),
			});
		} catch (error) {
			logger.warn("[Newsletter] review image not published", {
				sendId: input.sendId,
				imageId: image.id,
				error: error instanceof Error ? error.name : "unknown",
			});
			continue;
		} finally {
			input.afterEachCopy?.();
		}
		published.push({
			imageId: image.id,
			storageKey: image.storageKey,
			publicKey,
			url: toAbsoluteUrl(
				`/image-proxy/${newsletterImageBucket()}/${publicKey}`,
			),
		});
	}
	return published;
}
