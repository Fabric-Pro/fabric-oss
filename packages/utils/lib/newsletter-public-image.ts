/**
 * Published release-notes images: the only objects the image proxy serves
 * from the newsletter's bucket.
 *
 * A published key is `newsletter-public/<32 lowercase hex>.<png|jpg|jpeg>`.
 * The name is pure randomness — no tenant, project or send id — so knowing
 * one image's URL reveals nothing about any other object, and the strict
 * pattern keeps every review-stage key (which starts with a tenant prefix) out
 * of reach of the unauthenticated proxy.
 */

export const NEWSLETTER_PUBLIC_IMAGE_PREFIX = "newsletter-public";

const PUBLIC_IMAGE_FILE = /^[0-9a-f]{32,64}\.(png|jpe?g)$/;

/** The content type to serve a published image file with, or null when the
 *  name is not a published image file. */
export function newsletterPublicImageContentType(
	fileName: string,
): "image/png" | "image/jpeg" | null {
	const match = PUBLIC_IMAGE_FILE.exec(fileName);
	if (!match) {
		return null;
	}
	return match[1] === "png" ? "image/png" : "image/jpeg";
}
