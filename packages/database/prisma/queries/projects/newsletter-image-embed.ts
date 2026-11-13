/**
 * The images a release-notes send goes out with, written into its content:
 * at approval (`writeApprovedNewsletterImages`, inside the approval
 * transaction) and for a send that goes out without review
 * (`embedCapturedNewsletterImages`). The review-side writes live in
 * `newsletter-images.ts`.
 */
import {
	NEWSLETTER_IMAGES_PER_HIGHLIGHT_MAX,
	type NewsletterContent,
	type NewsletterHighlightImage,
	newsletterContentSchema,
} from "../../../src/newsletter-schema";
import { db } from "../../client";

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

/** An image the approval copied to its public key before the row flipped. */
export interface PublishedNewsletterImage {
	imageId: string;
	/** The review object that was copied. An image replaced since is skipped. */
	storageKey: string;
	publicKey: string;
	url: string;
}

/**
 * Inside the approval transaction, after the row flipped to APPROVED: record
 * each published image's public key and write the effective images into
 * `content.highlights[i].images`. Re-reads the rows so an edit that committed
 * after the caller listed them wins: an image since excluded, removed,
 * replaced or moved under a removed highlight is not embedded. Highlight
 * indexes are untouched; the stored array keeps its order.
 *
 * Returns the ids of the embedded images; any other published object is
 * unreferenced and the caller may delete it.
 */
export async function writeApprovedNewsletterImages(
	tx: Tx,
	input: {
		sendId: string;
		removedHighlightIndexes: number[];
		published: PublishedNewsletterImage[];
	},
): Promise<string[]> {
	if (input.published.length === 0) {
		return [];
	}
	const send = await tx.newsletterSend.findUnique({
		where: { id: input.sendId },
		select: { content: true },
	});
	const content = newsletterContentSchema.safeParse(send?.content);
	if (!content.success) {
		return [];
	}
	const result = await embedPublishedNewsletterImages(tx, {
		sendId: input.sendId,
		content: content.data,
		removedHighlightIndexes: input.removedHighlightIndexes,
		published: input.published,
	});
	if (result.embedded.length === 0) {
		return [];
	}
	await tx.newsletterSend.update({
		where: { id: input.sendId },
		data: { content: result.content as object },
	});
	return result.embedded;
}

/**
 * The images a send goes out with, written into `content` (returned, not
 * stored): each published copy whose row is still included, READY, holds the
 * object that was copied and sits under a kept highlight. Records each
 * embedded row's public key. An image placed above its description carries
 * `placement: "ABOVE"`; one below carries none, as before placements. The
 * approval stores the result; a send that goes out without review hands it
 * straight to delivery.
 */
export async function embedPublishedNewsletterImages(
	tx: Tx,
	input: {
		sendId: string;
		content: NewsletterContent;
		removedHighlightIndexes: number[];
		published: PublishedNewsletterImage[];
	},
): Promise<{ content: NewsletterContent; embedded: string[] }> {
	if (input.published.length === 0) {
		return { content: input.content, embedded: [] };
	}
	const published = new Map(input.published.map((p) => [p.imageId, p]));
	const rows = await tx.newsletterSendImage.findMany({
		where: {
			sendId: input.sendId,
			id: { in: [...published.keys()] },
			included: true,
			captureState: "READY",
		},
		orderBy: [{ highlightIndex: "asc" }, { position: "asc" }],
		select: {
			id: true,
			storageKey: true,
			highlightIndex: true,
			altText: true,
			width: true,
			height: true,
			placement: true,
		},
	});

	const removed = new Set(input.removedHighlightIndexes);
	const imagesByHighlight = new Map<number, NewsletterHighlightImage[]>();
	const embedded: string[] = [];
	for (const row of rows) {
		const copy = published.get(row.id);
		if (
			!copy ||
			copy.storageKey !== row.storageKey ||
			removed.has(row.highlightIndex) ||
			row.highlightIndex >= input.content.highlights.length
		) {
			continue;
		}
		const images = imagesByHighlight.get(row.highlightIndex) ?? [];
		if (images.length >= NEWSLETTER_IMAGES_PER_HIGHLIGHT_MAX) {
			continue;
		}
		images.push({
			url: copy.url,
			alt: row.altText,
			...(row.width !== null && { width: row.width }),
			...(row.height !== null && { height: row.height }),
			...(row.placement === "ABOVE" && { placement: "ABOVE" as const }),
		});
		imagesByHighlight.set(row.highlightIndex, images);
		await tx.newsletterSendImage.update({
			where: { id: row.id },
			data: { publicKey: copy.publicKey },
		});
		embedded.push(row.id);
	}
	if (embedded.length === 0) {
		return { content: input.content, embedded };
	}
	return {
		content: {
			...input.content,
			highlights: input.content.highlights.map((highlight, i) => {
				const images = imagesByHighlight.get(i);
				return images ? { ...highlight, images } : highlight;
			}),
		},
		embedded,
	};
}

/**
 * The review-off path of a send with automatic screenshots: embed the
 * captures the workflow already published into the content it is about to
 * deliver, in one transaction. Returns the content to deliver and the ids of
 * the embedded images.
 */
export async function embedCapturedNewsletterImages(input: {
	sendId: string;
	content: NewsletterContent;
	published: PublishedNewsletterImage[];
}): Promise<{ content: NewsletterContent; embedded: string[] }> {
	return db.$transaction((tx) =>
		embedPublishedNewsletterImages(tx, {
			sendId: input.sendId,
			content: input.content,
			removedHighlightIndexes: [],
			published: input.published,
		}),
	);
}
