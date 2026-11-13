/**
 * Review images of a held release-notes send (`NewsletterSendImage`).
 *
 * Uses the raw `db` client (BYPASSRLS) like the rest of the newsletter
 * queries: every query is bounded by `projectId`, and the tenant columns of a
 * new row are copied from its send, never taken from the caller.
 *
 * Every write first locks the send row (`FOR UPDATE`) and requires it to be
 * PENDING_APPROVAL with `screenshotsEnabled`; the generating workflow's own
 * captures are one exception, created while the send is still PENDING
 * (see "Automatic capture" below), and taking a sent send's images down is
 * the other. Approval locks that same row before it flips it, so an image
 * change and an approval are serialized: an edit that commits first is what
 * the approval sees, and an edit that waits on an approval finds the send no
 * longer reviewable. The per-highlight cap and the reviewer's capture limit
 * are counted under the same lock, so two requests can never both take the
 * last slot.
 *
 * Positions within a highlight are kept contiguous (0..n-1): every move and
 * removal renumbers the highlights it touched.
 *
 * What approval writes into the content lives in `newsletter-image-embed.ts`.
 */
import {
	NEWSLETTER_IMAGES_PER_HIGHLIGHT_MAX,
	type NewsletterImagePlacement,
	newsletterContentSchema,
} from "../../../src/newsletter-schema";
import { db } from "../../client";
import { recordAuditTx } from "../audit-log";

type Tx = Parameters<Parameters<typeof db.$transaction>[0]>[0];

const NEWSLETTER_SEND_IMAGE_SELECT = {
	id: true,
	sendId: true,
	highlightIndex: true,
	position: true,
	captureState: true,
	included: true,
	source: true,
	storageKey: true,
	altText: true,
	width: true,
	height: true,
	bytes: true,
	prompt: true,
	errorMessage: true,
	placement: true,
	createdAt: true,
	updatedAt: true,
} as const;

/**
 * Captures reviewers may start for one send, new ones and captures again
 * together. Each drives a browser and a model, so the limit bounds the cost
 * of one review; an upload is always possible instead.
 */
export const NEWSLETTER_REVIEWER_CAPTURES_MAX = 24;

/** Why an image write was refused. The API maps each to its error. */
export type NewsletterImageRefusal =
	| { reason: "SEND_NOT_FOUND" }
	| { reason: "NOT_PENDING"; status: string }
	| { reason: "NOT_SENT"; status: string }
	| { reason: "SCREENSHOTS_DISABLED" }
	| { reason: "HIGHLIGHT_OUT_OF_RANGE" }
	| { reason: "HIGHLIGHT_FULL" }
	| { reason: "IMAGE_NOT_FOUND" }
	| { reason: "CAPTURE_IN_PROGRESS" }
	| { reason: "CAPTURE_LIMIT" }
	| { reason: "NOT_CAPTURED" }
	| { reason: "NO_CAPTURE_ENVIRONMENT" };

/** The reviewer a capture or takedown is recorded against. */
export interface NewsletterImageActor {
	userId: string;
	email?: string | null;
	name?: string | null;
}

type Refused = { ok: false; refusal: NewsletterImageRefusal };

const refuse = (refusal: NewsletterImageRefusal): Refused => ({
	ok: false,
	refusal,
});

interface LockedSend {
	organizationId: string | null;
	userId: string | null;
	highlightCount: number;
	screenshotEnvironmentId: string | null;
	captureStarts: number;
}

/**
 * Lock the send and require it to take images and to be in `status`:
 * PENDING_APPROVAL for a reviewer's change, PENDING while the generating
 * workflow adds its own captures.
 */
async function lockSendForImages(
	tx: Tx,
	projectId: string,
	sendId: string,
	status: "PENDING" | "PENDING_APPROVAL",
): Promise<{ ok: true; send: LockedSend } | Refused> {
	const rows = await tx.$queryRaw<
		Array<{
			status: string;
			screenshotsEnabled: boolean;
			screenshotEnvironmentId: string | null;
			organizationId: string | null;
			userId: string | null;
			content: unknown;
			captureStarts: number;
		}>
	>`
		SELECT "status", "screenshotsEnabled", "screenshotEnvironmentId", "organizationId", "userId", "content", "captureStarts"
		FROM "newsletter_send"
		WHERE "id" = ${sendId} AND "projectId" = ${projectId}
		FOR UPDATE`;
	const row = rows[0];
	if (!row) {
		return refuse({ reason: "SEND_NOT_FOUND" });
	}
	if (row.status !== status) {
		return refuse({ reason: "NOT_PENDING", status: row.status });
	}
	if (!row.screenshotsEnabled) {
		return refuse({ reason: "SCREENSHOTS_DISABLED" });
	}
	const content = newsletterContentSchema.safeParse(row.content);
	return {
		ok: true,
		send: {
			organizationId: row.organizationId,
			userId: row.userId,
			highlightCount: content.success
				? content.data.highlights.length
				: 0,
			screenshotEnvironmentId: row.screenshotEnvironmentId,
			captureStarts: row.captureStarts,
		},
	};
}

function lockReviewableSend(tx: Tx, projectId: string, sendId: string) {
	return lockSendForImages(tx, projectId, sendId, "PENDING_APPROVAL");
}

/**
 * Count a reviewer's capture start against the send's limit and record who
 * started it. Runs under the send row lock the caller holds, after the caller
 * checked `captureStarts` against `NEWSLETTER_REVIEWER_CAPTURES_MAX`.
 */
async function recordCaptureStart(
	tx: Tx,
	input: {
		projectId: string;
		sendId: string;
		send: LockedSend;
		imageId: string;
		kind: "prompt" | "recapture";
		actor: NewsletterImageActor;
	},
): Promise<void> {
	await tx.newsletterSend.update({
		where: { id: input.sendId },
		data: { captureStarts: { increment: 1 } },
	});
	await recordAuditTx(tx, {
		action: "newsletter.screenshots.capture_started",
		actor: {
			type: "user",
			userId: input.actor.userId,
			emailSnapshot: input.actor.email ?? null,
			nameSnapshot: input.actor.name ?? null,
		},
		organizationId: input.send.organizationId,
		projectId: input.projectId,
		resource: { type: "newsletter_send", id: input.sendId },
		metadata: {
			sendId: input.sendId,
			imageId: input.imageId,
			kind: input.kind,
		},
	});
}

/** Rewrite `position` to match the order of `ids`. */
async function renumber(tx: Tx, ids: string[]): Promise<void> {
	for (const [position, id] of ids.entries()) {
		await tx.newsletterSendImage.update({
			where: { id },
			data: { position },
		});
	}
}

async function siblingIds(
	tx: Tx,
	sendId: string,
	highlightIndex: number,
	excludeId: string,
): Promise<string[]> {
	const rows = await tx.newsletterSendImage.findMany({
		where: { sendId, highlightIndex, NOT: { id: excludeId } },
		orderBy: { position: "asc" },
		select: { id: true },
	});
	return rows.map((r) => r.id);
}

/**
 * Every image of a send, in highlight then position order, with the public
 * key an earlier publish recorded so a retried publish can reuse it.
 */
export async function listNewsletterSendImages(
	projectId: string,
	sendId: string,
) {
	return db.newsletterSendImage.findMany({
		where: { projectId, sendId },
		orderBy: [{ highlightIndex: "asc" }, { position: "asc" }],
		select: { ...NEWSLETTER_SEND_IMAGE_SELECT, publicKey: true },
	});
}

/** One image, or null when it is not an image of this project. */
export async function getNewsletterSendImage(
	projectId: string,
	imageId: string,
) {
	return db.newsletterSendImage.findFirst({
		where: { id: imageId, projectId },
		select: NEWSLETTER_SEND_IMAGE_SELECT,
	});
}

/** Attach an uploaded image to the end of a highlight, included by default. */
export async function createNewsletterSendImage(input: {
	projectId: string;
	sendId: string;
	highlightIndex: number;
	storageKey: string;
	bytes: number;
	width: number | null;
	height: number | null;
	altText: string;
	createdByUserId: string;
}) {
	return db.$transaction(async (tx) => {
		const locked = await lockReviewableSend(
			tx,
			input.projectId,
			input.sendId,
		);
		if (!locked.ok) {
			return locked;
		}
		if (input.highlightIndex >= locked.send.highlightCount) {
			return refuse({ reason: "HIGHLIGHT_OUT_OF_RANGE" });
		}
		const siblings = await tx.newsletterSendImage.count({
			where: {
				sendId: input.sendId,
				highlightIndex: input.highlightIndex,
			},
		});
		if (siblings >= NEWSLETTER_IMAGES_PER_HIGHLIGHT_MAX) {
			return refuse({ reason: "HIGHLIGHT_FULL" });
		}
		const image = await tx.newsletterSendImage.create({
			data: {
				sendId: input.sendId,
				projectId: input.projectId,
				organizationId: locked.send.organizationId,
				userId: locked.send.userId,
				highlightIndex: input.highlightIndex,
				position: siblings,
				captureState: "READY",
				included: true,
				source: "UPLOAD",
				storageKey: input.storageKey,
				altText: input.altText,
				width: input.width,
				height: input.height,
				bytes: input.bytes,
				createdByUserId: input.createdByUserId,
			},
			select: NEWSLETTER_SEND_IMAGE_SELECT,
		});
		return { ok: true as const, image };
	});
}

/**
 * Change whether an image is included, its description, whether it shows
 * above or below the highlight's text, or where it sits. Moving to another
 * highlight is refused when that highlight is full; a position past the end
 * appends.
 */
export async function updateNewsletterSendImage(input: {
	projectId: string;
	imageId: string;
	included?: boolean;
	altText?: string;
	placement?: NewsletterImagePlacement;
	highlightIndex?: number;
	position?: number;
}) {
	const current = await getNewsletterSendImage(
		input.projectId,
		input.imageId,
	);
	if (!current) {
		return refuse({ reason: "IMAGE_NOT_FOUND" });
	}
	const { sendId } = current;
	return db.$transaction(async (tx) => {
		const locked = await lockReviewableSend(tx, input.projectId, sendId);
		if (!locked.ok) {
			return locked;
		}
		const image = await tx.newsletterSendImage.findFirst({
			where: { id: input.imageId, sendId },
			select: { highlightIndex: true },
		});
		if (!image) {
			return refuse({ reason: "IMAGE_NOT_FOUND" });
		}

		let moved: { highlightIndex: number; position: number } | null = null;
		if (
			input.highlightIndex !== undefined ||
			input.position !== undefined
		) {
			const target = input.highlightIndex ?? image.highlightIndex;
			if (target >= locked.send.highlightCount) {
				return refuse({ reason: "HIGHLIGHT_OUT_OF_RANGE" });
			}
			const targetIds = await siblingIds(
				tx,
				sendId,
				target,
				input.imageId,
			);
			if (targetIds.length >= NEWSLETTER_IMAGES_PER_HIGHLIGHT_MAX) {
				return refuse({ reason: "HIGHLIGHT_FULL" });
			}
			const position = Math.min(
				input.position ?? targetIds.length,
				targetIds.length,
			);
			if (target !== image.highlightIndex) {
				const sourceIds = await siblingIds(
					tx,
					sendId,
					image.highlightIndex,
					input.imageId,
				);
				await renumber(tx, sourceIds);
			}
			await renumber(tx, [
				...targetIds.slice(0, position),
				input.imageId,
				...targetIds.slice(position),
			]);
			moved = { highlightIndex: target, position };
		}

		const updated = await tx.newsletterSendImage.update({
			where: { id: input.imageId },
			data: {
				...(input.included !== undefined && {
					included: input.included,
				}),
				...(input.altText !== undefined && { altText: input.altText }),
				...(input.placement !== undefined && {
					placement: input.placement,
				}),
				...(moved ?? {}),
			},
			select: NEWSLETTER_SEND_IMAGE_SELECT,
		});
		return { ok: true as const, image: updated };
	});
}

/**
 * Include every READY image under the highlights the reviewer keeps, in one
 * change. Returns the images it included; an image already included, still
 * being captured or without a picture is left alone.
 */
export async function includeAllNewsletterSendImages(input: {
	projectId: string;
	sendId: string;
	removedHighlightIndexes: number[];
}) {
	return db.$transaction(async (tx) => {
		const locked = await lockReviewableSend(
			tx,
			input.projectId,
			input.sendId,
		);
		if (!locked.ok) {
			return locked;
		}
		const rows = await tx.newsletterSendImage.findMany({
			where: {
				sendId: input.sendId,
				captureState: "READY",
				included: false,
				highlightIndex: {
					notIn: input.removedHighlightIndexes,
					lt: locked.send.highlightCount,
				},
			},
			select: { id: true },
		});
		const ids = rows.map((row) => row.id);
		if (ids.length > 0) {
			await tx.newsletterSendImage.updateMany({
				where: { id: { in: ids } },
				data: { included: true },
			});
		}
		const images = await tx.newsletterSendImage.findMany({
			where: { id: { in: ids } },
			orderBy: [{ highlightIndex: "asc" }, { position: "asc" }],
			select: NEWSLETTER_SEND_IMAGE_SELECT,
		});
		return { ok: true as const, images };
	});
}

/**
 * Point an image at a newly uploaded object. The image becomes an included,
 * READY upload again; `previousStorageKey` is returned so the caller can
 * delete the object it replaced.
 */
export async function replaceNewsletterSendImageStorage(input: {
	projectId: string;
	imageId: string;
	storageKey: string;
	bytes: number;
	width: number | null;
	height: number | null;
}) {
	const current = await getNewsletterSendImage(
		input.projectId,
		input.imageId,
	);
	if (!current) {
		return refuse({ reason: "IMAGE_NOT_FOUND" });
	}
	const { sendId } = current;
	return db.$transaction(async (tx) => {
		const locked = await lockReviewableSend(tx, input.projectId, sendId);
		if (!locked.ok) {
			return locked;
		}
		const previous = await tx.newsletterSendImage.findFirst({
			where: { id: input.imageId, sendId },
			select: { storageKey: true },
		});
		if (!previous) {
			return refuse({ reason: "IMAGE_NOT_FOUND" });
		}
		const image = await tx.newsletterSendImage.update({
			where: { id: input.imageId },
			data: {
				storageKey: input.storageKey,
				bytes: input.bytes,
				width: input.width,
				height: input.height,
				included: true,
				source: "UPLOAD",
				captureState: "READY",
				publicKey: null,
				prompt: null,
				errorMessage: null,
			},
			select: NEWSLETTER_SEND_IMAGE_SELECT,
		});
		return {
			ok: true as const,
			image,
			previousStorageKey: previous.storageKey,
		};
	});
}

/**
 * Remove an image; returns its object key so the caller can delete it, and
 * whether a capture of it was still running so the caller can stop it.
 */
export async function deleteNewsletterSendImage(input: {
	projectId: string;
	imageId: string;
}) {
	const current = await getNewsletterSendImage(
		input.projectId,
		input.imageId,
	);
	if (!current) {
		return refuse({ reason: "IMAGE_NOT_FOUND" });
	}
	const { sendId } = current;
	return db.$transaction(async (tx) => {
		const locked = await lockReviewableSend(tx, input.projectId, sendId);
		if (!locked.ok) {
			return locked;
		}
		const image = await tx.newsletterSendImage.findFirst({
			where: { id: input.imageId, sendId },
			select: {
				highlightIndex: true,
				storageKey: true,
				captureState: true,
			},
		});
		if (!image) {
			return refuse({ reason: "IMAGE_NOT_FOUND" });
		}
		await tx.newsletterSendImage.delete({ where: { id: input.imageId } });
		await renumber(
			tx,
			await siblingIds(tx, sendId, image.highlightIndex, input.imageId),
		);
		return {
			ok: true as const,
			storageKey: image.storageKey,
			wasCapturing: image.captureState === "CAPTURING",
		};
	});
}

// ---- Automatic capture ----------------------------------------------------
//
// A capture row is CAPTURING until the capture activity completes it (READY)
// or fails it (FAILED with a reason). `prompt` holds what the capture was asked
// to show: curation's brief for an AI row, the reviewer's words for a PROMPT
// row. Capturing again over a READY image keeps its object until the new one
// lands, so a failure returns it to READY with the reason.

/**
 * The generating workflow's own captures: one CAPTURING row per highlight,
 * before the send is held or sent. `included` is false when a reviewer will
 * decide, true when the send goes out without review. Returns no rows when the
 * send has left PENDING or does not take images.
 *
 * Safe to repeat (an activity retry, a rerun or a reset of the workflow): a
 * highlight that already has an automatic row gets no second one, and the
 * automatic rows still CAPTURING are returned with the new ones, so each
 * highlight is captured exactly once.
 */
export async function createNewsletterCaptureRows(input: {
	projectId: string;
	sendId: string;
	captures: Array<{ highlightIndex: number; prompt: string }>;
	included: boolean;
	createdByUserId: string;
}): Promise<Array<{ id: string; highlightIndex: number }>> {
	return db.$transaction(async (tx) => {
		const locked = await lockSendForImages(
			tx,
			input.projectId,
			input.sendId,
			"PENDING",
		);
		if (!locked.ok) {
			return [];
		}
		const existing = await tx.newsletterSendImage.findMany({
			where: { sendId: input.sendId, source: "AI" },
			orderBy: [{ highlightIndex: "asc" }, { position: "asc" }],
			select: { id: true, highlightIndex: true, captureState: true },
		});
		const covered = new Set(existing.map((row) => row.highlightIndex));
		const created: Array<{ id: string; highlightIndex: number }> = [];
		for (const row of existing) {
			if (row.captureState === "CAPTURING") {
				created.push({
					id: row.id,
					highlightIndex: row.highlightIndex,
				});
			}
		}
		for (const capture of input.captures) {
			if (covered.has(capture.highlightIndex)) {
				continue;
			}
			const siblings = await tx.newsletterSendImage.count({
				where: {
					sendId: input.sendId,
					highlightIndex: capture.highlightIndex,
				},
			});
			if (siblings >= NEWSLETTER_IMAGES_PER_HIGHLIGHT_MAX) {
				continue;
			}
			const row = await tx.newsletterSendImage.create({
				data: {
					sendId: input.sendId,
					projectId: input.projectId,
					organizationId: locked.send.organizationId,
					userId: locked.send.userId,
					highlightIndex: capture.highlightIndex,
					position: siblings,
					captureState: "CAPTURING",
					included: input.included,
					source: "AI",
					prompt: capture.prompt,
					createdByUserId: input.createdByUserId,
				},
				select: { id: true, highlightIndex: true },
			});
			created.push(row);
		}
		return created.sort((a, b) => a.highlightIndex - b.highlightIndex);
	});
}

/**
 * A reviewer asks for a screenshot of one highlight in their own words: a new
 * CAPTURING row at the end of the highlight, included once it succeeds.
 * Counts against the send's capture limit and is audited.
 */
export async function createPromptedNewsletterCapture(input: {
	projectId: string;
	sendId: string;
	highlightIndex: number;
	prompt: string;
	actor: NewsletterImageActor;
}) {
	return db.$transaction(async (tx) => {
		const locked = await lockReviewableSend(
			tx,
			input.projectId,
			input.sendId,
		);
		if (!locked.ok) {
			return locked;
		}
		if (!locked.send.screenshotEnvironmentId) {
			return refuse({ reason: "NO_CAPTURE_ENVIRONMENT" });
		}
		if (locked.send.captureStarts >= NEWSLETTER_REVIEWER_CAPTURES_MAX) {
			return refuse({ reason: "CAPTURE_LIMIT" });
		}
		if (input.highlightIndex >= locked.send.highlightCount) {
			return refuse({ reason: "HIGHLIGHT_OUT_OF_RANGE" });
		}
		const siblings = await tx.newsletterSendImage.count({
			where: {
				sendId: input.sendId,
				highlightIndex: input.highlightIndex,
			},
		});
		if (siblings >= NEWSLETTER_IMAGES_PER_HIGHLIGHT_MAX) {
			return refuse({ reason: "HIGHLIGHT_FULL" });
		}
		const image = await tx.newsletterSendImage.create({
			data: {
				sendId: input.sendId,
				projectId: input.projectId,
				organizationId: locked.send.organizationId,
				userId: locked.send.userId,
				highlightIndex: input.highlightIndex,
				position: siblings,
				captureState: "CAPTURING",
				included: true,
				source: "PROMPT",
				prompt: input.prompt,
				createdByUserId: input.actor.userId,
			},
			select: NEWSLETTER_SEND_IMAGE_SELECT,
		});
		await recordCaptureStart(tx, {
			projectId: input.projectId,
			sendId: input.sendId,
			send: locked.send,
			imageId: image.id,
			kind: "prompt",
			actor: input.actor,
		});
		return { ok: true as const, image };
	});
}

/**
 * Capture a captured image again, optionally with new words. Refused for an
 * uploaded image and while a capture of it is still running. An empty failed
 * slot the reviewer captures again is included, like a capture they describe:
 * asking for it again is the decision to show it. Counts against the send's
 * capture limit and is audited.
 */
export async function startNewsletterImageRecapture(input: {
	projectId: string;
	imageId: string;
	prompt?: string;
	actor: NewsletterImageActor;
}) {
	const current = await getNewsletterSendImage(
		input.projectId,
		input.imageId,
	);
	if (!current) {
		return refuse({ reason: "IMAGE_NOT_FOUND" });
	}
	const { sendId } = current;
	return db.$transaction(async (tx) => {
		const locked = await lockReviewableSend(tx, input.projectId, sendId);
		if (!locked.ok) {
			return locked;
		}
		if (!locked.send.screenshotEnvironmentId) {
			return refuse({ reason: "NO_CAPTURE_ENVIRONMENT" });
		}
		const image = await tx.newsletterSendImage.findFirst({
			where: { id: input.imageId, sendId },
			select: { source: true, captureState: true, storageKey: true },
		});
		if (!image) {
			return refuse({ reason: "IMAGE_NOT_FOUND" });
		}
		if (image.source === "UPLOAD") {
			return refuse({ reason: "NOT_CAPTURED" });
		}
		if (image.captureState === "CAPTURING") {
			return refuse({ reason: "CAPTURE_IN_PROGRESS" });
		}
		if (locked.send.captureStarts >= NEWSLETTER_REVIEWER_CAPTURES_MAX) {
			return refuse({ reason: "CAPTURE_LIMIT" });
		}
		const emptyFailedSlot =
			image.captureState === "FAILED" && image.storageKey === null;
		const updated = await tx.newsletterSendImage.update({
			where: { id: input.imageId },
			data: {
				captureState: "CAPTURING",
				errorMessage: null,
				...(emptyFailedSlot && { included: true }),
				...(input.prompt !== undefined && { prompt: input.prompt }),
			},
			select: NEWSLETTER_SEND_IMAGE_SELECT,
		});
		await recordCaptureStart(tx, {
			projectId: input.projectId,
			sendId,
			send: locked.send,
			imageId: input.imageId,
			kind: "recapture",
			actor: input.actor,
		});
		return { ok: true as const, image: updated };
	});
}

/** What the capture activity needs about one CAPTURING image and its send. */
export async function getNewsletterImageCaptureTarget(imageId: string) {
	const image = await db.newsletterSendImage.findUnique({
		where: { id: imageId },
		select: {
			id: true,
			sendId: true,
			projectId: true,
			organizationId: true,
			userId: true,
			highlightIndex: true,
			captureState: true,
			prompt: true,
			createdByUserId: true,
			send: { select: { screenshotEnvironmentId: true } },
		},
	});
	return image?.captureState === "CAPTURING" ? image : null;
}

/**
 * Record a successful capture. Only a row still CAPTURING under a send that is
 * still generating or held is completed; otherwise (the row was removed or
 * failed meanwhile, or the send was decided) nothing changes and the caller
 * deletes the object it uploaded. Returns the object the capture replaced.
 */
export async function completeNewsletterImageCapture(input: {
	imageId: string;
	storageKey: string;
	bytes: number;
	width: number;
	height: number;
	altText: string;
}): Promise<{ ok: true; previousStorageKey: string | null } | { ok: false }> {
	return db.$transaction(async (tx) => {
		const image = await tx.newsletterSendImage.findUnique({
			where: { id: input.imageId },
			select: { sendId: true, projectId: true },
		});
		if (!image) {
			return { ok: false as const };
		}
		const rows = await tx.$queryRaw<Array<{ status: string }>>`
			SELECT "status" FROM "newsletter_send"
			WHERE "id" = ${image.sendId} AND "projectId" = ${image.projectId}
			FOR UPDATE`;
		const status = rows[0]?.status;
		if (status !== "PENDING" && status !== "PENDING_APPROVAL") {
			return { ok: false as const };
		}
		const current = await tx.newsletterSendImage.findFirst({
			where: { id: input.imageId, captureState: "CAPTURING" },
			select: { storageKey: true, altText: true },
		});
		if (!current) {
			return { ok: false as const };
		}
		await tx.newsletterSendImage.update({
			where: { id: input.imageId },
			data: {
				captureState: "READY",
				storageKey: input.storageKey,
				bytes: input.bytes,
				width: input.width,
				height: input.height,
				publicKey: null,
				errorMessage: null,
				// A description the reviewer wrote survives a new capture.
				...(current.altText.trim() === "" && {
					altText: input.altText,
				}),
			},
		});
		return {
			ok: true as const,
			previousStorageKey: current.storageKey,
		};
	});
}

/**
 * Record a failed capture with a short reason. A first capture becomes an
 * empty FAILED slot; a capture over an existing image keeps that image READY.
 * A row no longer CAPTURING is left alone.
 */
export async function failNewsletterImageCapture(input: {
	imageId: string;
	reason: string;
}): Promise<void> {
	await db.$transaction([
		db.newsletterSendImage.updateMany({
			where: {
				id: input.imageId,
				captureState: "CAPTURING",
				storageKey: null,
			},
			data: { captureState: "FAILED", errorMessage: input.reason },
		}),
		db.newsletterSendImage.updateMany({
			where: {
				id: input.imageId,
				captureState: "CAPTURING",
				storageKey: { not: null },
			},
			data: { captureState: "READY", errorMessage: input.reason },
		}),
	]);
}

/** How long a capture may stay CAPTURING before it is taken as lost. */
export const NEWSLETTER_CAPTURE_STALE_MS = 10 * 60_000;

/**
 * Settle the captures of held sends that stopped without a result: a
 * CAPTURING row untouched for `NEWSLETTER_CAPTURE_STALE_MS` becomes FAILED
 * with a reason, or READY again when it still holds the image it was
 * capturing over. A reviewer's capture is bounded well inside that time, so
 * only a lost one is settled. Scoped to `sendId` when given, otherwise to
 * every held send of the project. Returns how many rows changed.
 */
export async function releaseStaleNewsletterCaptures(input: {
	projectId: string;
	sendId?: string;
	now?: Date;
}): Promise<number> {
	const cutoff = new Date(
		(input.now ?? new Date()).getTime() - NEWSLETTER_CAPTURE_STALE_MS,
	);
	const stale = {
		projectId: input.projectId,
		...(input.sendId !== undefined && { sendId: input.sendId }),
		captureState: "CAPTURING" as const,
		updatedAt: { lt: cutoff },
		send: { status: "PENDING_APPROVAL" as const },
	};
	const reason = "The capture stopped without a result.";
	const [failed, restored] = await db.$transaction([
		db.newsletterSendImage.updateMany({
			where: { ...stale, storageKey: null },
			data: { captureState: "FAILED", errorMessage: reason },
		}),
		db.newsletterSendImage.updateMany({
			where: { ...stale, storageKey: { not: null } },
			data: { captureState: "READY", errorMessage: reason },
		}),
	]);
	return failed.count + restored.count;
}

/** How many images of a send are still being captured. */
export async function countCapturingNewsletterImages(
	projectId: string,
	sendId: string,
): Promise<number> {
	return db.newsletterSendImage.count({
		where: { projectId, sendId, captureState: "CAPTURING" },
	});
}

/** The tenant a project's newsletter review folders are named after. */
export async function getNewsletterProjectTenant(
	projectId: string,
): Promise<{ organizationId: string | null; userId: string | null } | null> {
	return db.project.findUnique({
		where: { id: projectId },
		select: { organizationId: true, userId: true },
	});
}

/**
 * Remove every image of a send that will never go out — rejected, expired,
 * failed or skipped — and return the object keys the rows held, so the
 * caller can delete them. That includes the public copy of an image a send
 * published before its delivery failed: nothing can take it down once the
 * row is gone. A send in any other state (or another project's) keeps its
 * images and returns no keys.
 */
export async function deleteDiscardedNewsletterSendImages(
	projectId: string,
	sendId: string,
): Promise<string[]> {
	return db.$transaction(async (tx) => {
		const rows = await tx.newsletterSendImage.findMany({
			where: {
				projectId,
				sendId,
				send: {
					projectId,
					status: {
						in: ["REJECTED", "EXPIRED", "FAILED", "SKIPPED_EMPTY"],
					},
				},
			},
			select: { id: true, storageKey: true, publicKey: true },
		});
		if (rows.length === 0) {
			return [];
		}
		await tx.newsletterSendImage.deleteMany({
			where: { id: { in: rows.map((row) => row.id) } },
		});
		return rows.flatMap((row) =>
			[row.storageKey, row.publicKey].filter((key): key is string =>
				Boolean(key),
			),
		);
	});
}
