import type { ReleaseHighlight } from "@repo/utils/group-highlights";
import type { orpcClient } from "@shared/lib/orpc-client";

export type PendingNewsletterSend = Awaited<
	ReturnType<typeof orpcClient.newsletter.sends.pending>
>["sends"][number];

export type PendingNewsletterImage = PendingNewsletterSend["images"][number];

/** The email's own highlight shape, so the dialog can group like the email. */
export type ReviewHighlight = ReleaseHighlight;

interface ReviewContent {
	headline?: string;
	intro?: string;
	highlights?: ReviewHighlight[];
}

/**
 * The frozen draft a reviewer reads. `content` is a Prisma Json column; this
 * is the reading the review panel has always used, kept in one place.
 */
export function readReviewContent(
	content: PendingNewsletterSend["content"],
): ReviewContent | null {
	return (content as ReviewContent | null) ?? null;
}
