import { randomBytes, randomUUID } from "node:crypto";
import { ORPCError } from "@orpc/server";
import {
	db,
	deleteDiscardedNewsletterSendImages,
	getNewsletterSendForSendPhase,
	listNewsletterSendImages,
	type NewsletterImageRefusal,
	type PublishedNewsletterImage,
} from "@repo/database";
import {
	deleteNewsletterImageObjects,
	deleteNewsletterSendFolder,
	newsletterImageBucket,
	newsletterSendImagesPrefix,
	publishNewsletterImages,
} from "@repo/database/prisma/queries/projects/newsletter-image-publish";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import { hasImageSignature } from "./image-signature";

export { deleteNewsletterImageObjects };

/**
 * Storage for the images a reviewer attaches to a held release-notes send.
 * The bucket, the send's folder, deletion and publishing are shared with the
 * worker in `@repo/database/.../newsletter-image-publish`.
 *
 * Everything lives in the private `projectContexts` bucket, like the Brand
 * kit's files, so no bucket needs provisioning.
 *
 *  - An upload goes by signed PUT to
 *    `<tenant>/newsletter-images/<sendId>/pending/<token>`. The caller only
 *    ever holds the token; the key is rebuilt here from the project's tenant
 *    and the send the token is presented with, so a token cannot name another
 *    tenant's or another send's object.
 *  - Committing the upload checks the stored type and size, copies it to
 *    `<tenant>/newsletter-images/<sendId>/<uuid>.<png|jpg>`, which the signed
 *    PUT cannot reach, and then checks the copy's bytes really are a PNG or
 *    JPEG, so the checked bytes cannot be swapped afterwards.
 *  - Approval copies an included image to
 *    `newsletter-public/<32 hex>.<png|jpg>`, the one prefix the image proxy
 *    serves without authentication.
 */

/** Largest image accepted; the browser scales an image down to fit first. */
export const NEWSLETTER_IMAGE_MAX_BYTES = 300 * 1024;

export const NEWSLETTER_IMAGE_CONTENT_TYPES = [
	"image/png",
	"image/jpeg",
] as const;
export type NewsletterImageContentType =
	(typeof NEWSLETTER_IMAGE_CONTENT_TYPES)[number];

/** A signed PUT is used at once, from the review panel that asked for it. */
const UPLOAD_URL_TTL_SECONDS = 300;

/** Signed reads are for showing the review panel now, not for sharing. */
const READ_URL_TTL_SECONDS = 900;

/** 24 random bytes as base64url: exactly this shape, nothing else. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32}$/;

interface ReviewProject {
	id: string;
	organizationId: string | null;
	userId: string;
}

function extensionFor(contentType: NewsletterImageContentType): "png" | "jpg" {
	return contentType === "image/png" ? "png" : "jpg";
}

function isImageContentType(
	value: string,
): value is NewsletterImageContentType {
	return (NEWSLETTER_IMAGE_CONTENT_TYPES as readonly string[]).includes(
		value,
	);
}

function pendingKey(
	project: ReviewProject,
	sendId: string,
	token: string,
): string {
	if (!TOKEN_PATTERN.test(token)) {
		throw new ORPCError("BAD_REQUEST", {
			message: "The image upload is not valid",
		});
	}
	return `${newsletterSendImagesPrefix(project, sendId)}pending/${token}`;
}

/**
 * The project the caller was authorized for by `requireProjectPermission`,
 * loaded by id. The tenant comes from this row; the caller still guards
 * `input.organizationId` against it with `assertInputOrgMatchesProject`.
 */
export async function loadReviewProject(
	projectId: string,
): Promise<ReviewProject> {
	const project = await db.project.findUnique({
		where: { id: projectId },
		select: { id: true, organizationId: true, userId: true },
	});
	if (!project) {
		throw new ORPCError("NOT_FOUND", { message: "Project not found" });
	}
	return project;
}

/** Answer a refused image write with the error the review panel expects. */
export function throwImageRefusal(refusal: NewsletterImageRefusal): never {
	switch (refusal.reason) {
		case "SEND_NOT_FOUND":
			throw new ORPCError("NOT_FOUND", { message: "Send not found" });
		case "IMAGE_NOT_FOUND":
			throw new ORPCError("NOT_FOUND", { message: "Image not found" });
		case "NOT_PENDING":
			throw new ORPCError("CONFLICT", {
				message:
					"This newsletter is no longer awaiting review, so its images can no longer be changed.",
				data: { currentStatus: refusal.status },
			});
		case "SCREENSHOTS_DISABLED":
			throw new ORPCError("BAD_REQUEST", {
				message: "Images are not turned on for this newsletter.",
			});
		case "HIGHLIGHT_OUT_OF_RANGE":
			throw new ORPCError("BAD_REQUEST", {
				message: "highlightIndex out of range",
			});
		case "HIGHLIGHT_FULL":
			throw new ORPCError("BAD_REQUEST", {
				message: "This highlight already has two images.",
				data: { code: "highlight_full" },
			});
		case "NOT_SENT":
			throw new ORPCError("CONFLICT", {
				message:
					"This newsletter has not been sent, so it has no published images.",
				data: { currentStatus: refusal.status },
			});
		case "CAPTURE_IN_PROGRESS":
			throw new ORPCError("CONFLICT", {
				message: "This screenshot is already being captured.",
				data: { code: "capture_in_progress" },
			});
		case "CAPTURE_LIMIT":
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This newsletter has reached its limit of screenshot captures. Upload an image instead.",
				data: { code: "capture_limit" },
			});
		case "NOT_CAPTURED":
			throw new ORPCError("BAD_REQUEST", {
				message:
					"This image was uploaded. Replace it to change it instead.",
			});
		case "NO_CAPTURE_ENVIRONMENT":
			throw new ORPCError("BAD_REQUEST", {
				message:
					"No environment is set to capture screenshots from for this newsletter.",
				data: { code: "no_capture_environment" },
			});
		default: {
			const exhaustive: never = refusal;
			throw new Error(`Unhandled image refusal: ${String(exhaustive)}`);
		}
	}
}

/**
 * Refuse early, before anything is signed or copied, when the send is not
 * this project's, no longer held, or does not take images. The query layer
 * checks the same again under the send's row lock. Returns the send.
 */
export async function requireImageReviewableSend(
	projectId: string,
	sendId: string,
): Promise<
	NonNullable<Awaited<ReturnType<typeof getNewsletterSendForSendPhase>>>
> {
	const row = await getNewsletterSendForSendPhase(sendId);
	if (!row || row.projectId !== projectId) {
		throwImageRefusal({ reason: "SEND_NOT_FOUND" });
	}
	if (row.status !== "PENDING_APPROVAL") {
		throwImageRefusal({ reason: "NOT_PENDING", status: row.status });
	}
	if (!row.screenshotsEnabled) {
		throwImageRefusal({ reason: "SCREENSHOTS_DISABLED" });
	}
	return row;
}

/** A signed PUT for one image of `sendId`, and the token that names it. */
export async function createNewsletterImageUpload(
	project: ReviewProject,
	sendId: string,
	contentType: NewsletterImageContentType,
	contentLength: number | undefined,
): Promise<{ signedUploadUrl: string; uploadToken: string }> {
	const storage = getStorageProvider();
	if (!storage.supportsPresignedUrls || !storage.getSignedUploadUrl) {
		throw new ORPCError("SERVICE_UNAVAILABLE", {
			message: "Uploads are temporarily unavailable",
		});
	}
	const uploadToken = randomBytes(24).toString("base64url");
	const signedUploadUrl = await storage.getSignedUploadUrl(
		pendingKey(project, sendId, uploadToken),
		{
			bucket: newsletterImageBucket(),
			contentType,
			contentLength,
			expiresIn: UPLOAD_URL_TTL_SECONDS,
		},
	);
	return { signedUploadUrl, uploadToken };
}

function storageFailure(): ORPCError<"INTERNAL_SERVER_ERROR", unknown> {
	return new ORPCError("INTERNAL_SERVER_ERROR", {
		message: "Could not save the image",
	});
}

function imageTooLarge(): ORPCError<"BAD_REQUEST", { code: string }> {
	return new ORPCError("BAD_REQUEST", {
		message: "The image is too large",
		data: { code: "too_large" },
	});
}

function imageUnsupported(): ORPCError<"BAD_REQUEST", { code: string }> {
	return new ORPCError("BAD_REQUEST", {
		message: "Use a PNG or JPEG image",
		data: { code: "unsupported" },
	});
}

/**
 * Check the upload a token names and copy it to its review key. A refused
 * upload is deleted and answered with BAD_REQUEST and a `code` the panel can
 * explain (`too_large`, `unsupported`): the stored type and size are checked
 * first, then the copy's bytes, which must start like the declared type.
 */
export async function commitNewsletterImageUpload(
	project: ReviewProject,
	sendId: string,
	token: string,
): Promise<{ storageKey: string; bytes: number }> {
	const source = pendingKey(project, sendId, token);
	const storage = getStorageProvider();

	let metadata: Awaited<ReturnType<typeof storage.getFileMetadata>>;
	try {
		metadata = await storage.getFileMetadata(source, {
			bucket: newsletterImageBucket(),
		});
	} catch {
		throw storageFailure();
	}
	if (!metadata) {
		throw new ORPCError("BAD_REQUEST", {
			message: "The image upload was not found. Upload it again.",
		});
	}

	if (metadata.size > NEWSLETTER_IMAGE_MAX_BYTES) {
		await deleteNewsletterImageObjects([source]);
		throw imageTooLarge();
	}
	const contentType = metadata.contentType.split(";")[0].trim().toLowerCase();
	if (!isImageContentType(contentType)) {
		await deleteNewsletterImageObjects([source]);
		throw imageUnsupported();
	}

	const prefix = newsletterSendImagesPrefix(project, sendId);
	const storageKey = `${prefix}${randomUUID()}.${extensionFor(contentType)}`;
	try {
		await storage.copyFile(source, storageKey, {
			bucket: newsletterImageBucket(),
		});
	} catch {
		throw storageFailure();
	}

	// The bytes are checked on the copy, not the upload: the signed PUT can
	// still overwrite the upload until it expires, never the copy.
	let data: Buffer;
	try {
		const file = await storage.downloadFile(storageKey, {
			bucket: newsletterImageBucket(),
		});
		data = file.data;
	} catch {
		await deleteNewsletterImageObjects([storageKey]);
		throw storageFailure();
	}
	if (data.length > NEWSLETTER_IMAGE_MAX_BYTES) {
		await deleteNewsletterImageObjects([source, storageKey]);
		throw imageTooLarge();
	}
	if (!hasImageSignature(data, contentType)) {
		await deleteNewsletterImageObjects([source, storageKey]);
		throw imageUnsupported();
	}

	await deleteNewsletterImageObjects([source]);
	return { storageKey, bytes: data.length };
}

/**
 * A short-lived signed read of a review image. `inline` shows it; `attachment`
 * makes the browser save it, which a cross-origin `<a download>` cannot.
 */
async function signNewsletterImageRead(
	storageKey: string,
	disposition: "inline" | "attachment",
): Promise<string> {
	const isPng = storageKey.endsWith(".png");
	return getStorageProvider().getSignedUrl(storageKey, {
		bucket: newsletterImageBucket(),
		expiresIn: READ_URL_TTL_SECONDS,
		responseContentType: isPng ? "image/png" : "image/jpeg",
		responseContentDisposition:
			disposition === "inline"
				? "inline"
				: `attachment; filename="newsletter-image.${isPng ? "png" : "jpg"}"`,
	});
}

/**
 * The client view of a review image: its object key is replaced by signed
 * view and download URLs (null while there is no object to show). An image
 * being captured again keeps showing the object it has until the new one
 * lands; only READY images count towards the email.
 */
export async function presentReviewImage<
	T extends { storageKey: string | null; captureState: string },
>(
	image: T,
): Promise<
	Omit<T, "storageKey"> & { url: string | null; downloadUrl: string | null }
> {
	const { storageKey, ...rest } = image;
	if (!storageKey || image.captureState === "FAILED") {
		return { ...rest, url: null, downloadUrl: null };
	}
	const [url, downloadUrl] = await Promise.all([
		signNewsletterImageRead(storageKey, "inline"),
		signNewsletterImageRead(storageKey, "attachment"),
	]);
	return { ...rest, url, downloadUrl };
}

/**
 * Remove the images of a send that will never go out, rows and objects, then
 * the rest of its review folder (an upload never added). Best-effort like
 * `deleteNewsletterImageObjects`: a failure is logged, never thrown, so it
 * cannot fail the decision it follows.
 */
export async function discardNewsletterSendImages(
	project: ReviewProject,
	sendId: string,
): Promise<void> {
	try {
		const keys = await deleteDiscardedNewsletterSendImages(
			project.id,
			sendId,
		);
		await deleteNewsletterImageObjects(keys);
	} catch (error) {
		logger.warn("[Newsletter] discarded send's images not removed", {
			sendId,
			error: error instanceof Error ? error.name : "unknown",
		});
	}
	await deleteNewsletterSendFolder(project, sendId);
}

/**
 * Copy every image that will go out to its public key, before the approval
 * flips the row. Only included, READY images under highlights the reviewer
 * kept are published. A failure skips that image (logged) and never fails
 * the approval; the send goes out without it.
 */
export async function publishReviewImages(input: {
	projectId: string;
	sendId: string;
	removedHighlightIndexes: number[];
	highlightCount: number;
}): Promise<PublishedNewsletterImage[]> {
	let images: Awaited<ReturnType<typeof listNewsletterSendImages>>;
	try {
		images = await listNewsletterSendImages(input.projectId, input.sendId);
	} catch (error) {
		logger.warn("[Newsletter] review images not read; sending without", {
			sendId: input.sendId,
			error: error instanceof Error ? error.name : "unknown",
		});
		return [];
	}
	return publishNewsletterImages({
		sendId: input.sendId,
		images,
		removedHighlightIndexes: input.removedHighlightIndexes,
		highlightCount: input.highlightCount,
	});
}
