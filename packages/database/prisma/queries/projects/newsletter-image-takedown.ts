/**
 * Taking a delivered newsletter's images down. Approval published them under
 * public keys, which every delivered email still points at. The caller lists
 * them, deletes the public objects, and then clears the keys of the ones that
 * are gone, so a row never loses its key while its object is still served.
 */
import {
	newsletterContentSchema,
	withoutPublishedImages,
} from "../../../src/newsletter-schema";
import { db } from "../../client";
import { recordAuditTx } from "../audit-log";
import type {
	NewsletterImageActor,
	NewsletterImageRefusal,
} from "./newsletter-images";

/** Statuses whose emails went out, to every recipient or to some. */
const DELIVERED_STATUSES: readonly string[] = ["SENT", "PARTIAL"];

/** The public copies a delivered send's images were published to. */
export async function listPublishedNewsletterSendImages(
	projectId: string,
	sendId: string,
): Promise<
	| { ok: true; images: Array<{ id: string; publicKey: string }> }
	| { ok: false; refusal: NewsletterImageRefusal }
> {
	const send = await db.newsletterSend.findFirst({
		where: { id: sendId, projectId },
		select: { status: true },
	});
	if (!send) {
		return { ok: false, refusal: { reason: "SEND_NOT_FOUND" } };
	}
	if (!DELIVERED_STATUSES.includes(send.status)) {
		return {
			ok: false,
			refusal: { reason: "NOT_SENT", status: send.status },
		};
	}
	const rows = await db.newsletterSendImage.findMany({
		where: { projectId, sendId, publicKey: { not: null } },
		orderBy: [{ highlightIndex: "asc" }, { position: "asc" }],
		select: { id: true, publicKey: true },
	});
	const images: Array<{ id: string; publicKey: string }> = [];
	for (const row of rows) {
		if (row.publicKey) {
			images.push({ id: row.id, publicKey: row.publicKey });
		}
	}
	return { ok: true, images };
}

/**
 * How many published images each of `sendIds` still has, by send id. Sends
 * with none are left out. The history table offers the takedown only where
 * there is something to take down.
 */
export async function countPublishedNewsletterSendImages(
	projectId: string,
	sendIds: string[],
): Promise<Map<string, number>> {
	const counts = new Map<string, number>();
	if (sendIds.length === 0) {
		return counts;
	}
	const rows = await db.newsletterSendImage.findMany({
		where: {
			projectId,
			sendId: { in: sendIds },
			publicKey: { not: null },
		},
		select: { sendId: true },
	});
	for (const row of rows) {
		counts.set(row.sendId, (counts.get(row.sendId) ?? 0) + 1);
	}
	return counts;
}

/**
 * After the caller deleted the public objects of `imageIds`: clear those
 * rows' public keys, drop the images from the send's content so the archive
 * stops showing them, and record the takedown, in one transaction. Returns
 * how many images were taken down.
 */
export async function clearPublishedNewsletterSendImages(input: {
	projectId: string;
	sendId: string;
	imageIds: string[];
	/** Images whose object could not be deleted, for the audit entry. */
	failedCount: number;
	actor: NewsletterImageActor;
}): Promise<number> {
	return db.$transaction(async (tx) => {
		const sends = await tx.$queryRaw<
			Array<{ content: unknown; organizationId: string | null }>
		>`
			SELECT "content", "organizationId" FROM "newsletter_send"
			WHERE "id" = ${input.sendId} AND "projectId" = ${input.projectId}
			FOR UPDATE`;
		const send = sends[0];
		if (!send) {
			return 0;
		}
		const rows = await tx.newsletterSendImage.findMany({
			where: {
				sendId: input.sendId,
				id: { in: input.imageIds },
				publicKey: { not: null },
			},
			select: { id: true, publicKey: true },
		});
		const keys: string[] = [];
		for (const row of rows) {
			if (row.publicKey) {
				keys.push(row.publicKey);
			}
		}
		if (rows.length > 0) {
			await tx.newsletterSendImage.updateMany({
				where: { id: { in: rows.map((row) => row.id) } },
				data: { publicKey: null },
			});
			const content = newsletterContentSchema.safeParse(send.content);
			if (content.success) {
				const remaining = withoutPublishedImages(content.data, keys);
				await tx.newsletterSend.update({
					where: { id: input.sendId },
					data: { content: remaining as object },
				});
			}
		}
		await recordAuditTx(tx, {
			action: "newsletter.screenshots.unpublished",
			actor: {
				type: "user",
				userId: input.actor.userId,
				emailSnapshot: input.actor.email ?? null,
				nameSnapshot: input.actor.name ?? null,
			},
			organizationId: send.organizationId,
			projectId: input.projectId,
			resource: { type: "newsletter_send", id: input.sendId },
			metadata: {
				sendId: input.sendId,
				removedCount: rows.length,
				failedCount: input.failedCount,
			},
		});
		return rows.length;
	});
}
