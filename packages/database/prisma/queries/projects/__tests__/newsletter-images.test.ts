/**
 * Review images of a held release-notes send, against a real Postgres:
 * `newsletter-images.ts` and the image half of `approveNewsletterSend`.
 *
 * What a mock cannot show: that every write is refused unless the send row
 * (locked FOR UPDATE) is PENDING_APPROVAL, belongs to the project and has
 * `screenshotsEnabled`; that the two-per-highlight cap and the contiguous
 * positions hold; that an image id from another project is never found; and
 * that approval embeds exactly the included READY images of kept highlights
 * without reordering the stored highlights; and that a rejected or expired
 * send's images are removed while any other send's are kept. Also the
 * reviewer capture limit and its audit, approval refusing while a capture
 * runs, including every image at once, placement, and taking a sent send's
 * images down.
 *
 * Self-skips when DATABASE_URL is unset or the CI placeholder
 * (`hasReachableDatabaseUrl`), like the sibling `newsletter-transitions.test.ts`.
 */

import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { hasReachableDatabaseUrl } from "../../../../__tests__/_helpers/db-availability";
import { newsletterContentSchema } from "../../../../src/newsletter-schema";
import { db, Prisma } from "../../../client";
import { approveNewsletterSend, buildCreateSendData } from "../newsletter";
import {
	clearPublishedNewsletterSendImages,
	listPublishedNewsletterSendImages,
} from "../newsletter-image-takedown";
import {
	countCapturingNewsletterImages,
	createNewsletterCaptureRows,
	createNewsletterSendImage,
	createPromptedNewsletterCapture,
	deleteDiscardedNewsletterSendImages,
	deleteNewsletterSendImage,
	includeAllNewsletterSendImages,
	listNewsletterSendImages,
	NEWSLETTER_CAPTURE_STALE_MS,
	NEWSLETTER_REVIEWER_CAPTURES_MAX,
	releaseStaleNewsletterCaptures,
	replaceNewsletterSendImageStorage,
	startNewsletterImageRecapture,
	updateNewsletterSendImage,
} from "../newsletter-images";

describe.skipIf(!hasReachableDatabaseUrl())(
	"newsletter send images (real Postgres)",
	() => {
		const RUN_ID = `${Date.now()}-${process.pid}`;
		const USER_ID = `test-newsletter-images-user-${RUN_ID}`;
		let counter = 0;

		beforeAll(async () => {
			const now = new Date();
			await db.$executeRaw(Prisma.sql`
				INSERT INTO "user" (id, name, email, "emailVerified", "onboardingComplete", "createdAt", "updatedAt")
				VALUES (${USER_ID}, ${"Newsletter Images User"}, ${`${USER_ID}@example.com`}, true, false, ${now}, ${now})
				ON CONFLICT (id) DO NOTHING
			`);
		});

		afterEach(async () => {
			// Deleting the project cascades its sends, and the sends their images.
			await db.project.deleteMany({ where: { userId: USER_ID } });
		});

		const content = {
			schemaVersion: 1,
			headline: "h",
			intro: "i",
			hasMajorFeatures: true,
			highlights: [
				{ title: "a", description: "da" },
				{ title: "b", description: "db" },
				{ title: "c", description: "dc" },
			],
		};

		async function seed(
			overrides: { status?: string; screenshotsEnabled?: boolean } = {},
		) {
			counter += 1;
			const project = await db.project.create({
				data: { name: `Newsletter Images ${counter}`, userId: USER_ID },
			});
			const send = await db.newsletterSend.create({
				data: {
					...buildCreateSendData({
						projectId: project.id,
						organizationId: null,
						userId: USER_ID,
						dedupeKey: `manual:${RUN_ID}:${counter}`,
						trigger: "MANUAL",
						timeWindowStart: new Date(0),
						timeWindowEnd: new Date(1),
						triggeredByUserId: USER_ID,
						detailLevel: "STANDARD",
						requireApproval: true,
						screenshotsEnabled:
							overrides.screenshotsEnabled ?? true,
					}),
					status: overrides.status ?? "PENDING_APPROVAL",
					content,
				},
			});
			return { project, send };
		}

		async function attach(
			projectId: string,
			sendId: string,
			highlightIndex: number,
			name: string,
		) {
			return createNewsletterSendImage({
				projectId,
				sendId,
				highlightIndex,
				storageKey: `${USER_ID}/newsletter-images/${sendId}/${name}.png`,
				bytes: 1000,
				width: 800,
				height: 450,
				altText: name,
				createdByUserId: USER_ID,
			});
		}

		async function attachOk(
			projectId: string,
			sendId: string,
			highlightIndex: number,
			name: string,
		) {
			const result = await attach(
				projectId,
				sendId,
				highlightIndex,
				name,
			);
			if (!result.ok) {
				throw new Error(`attach refused: ${result.refusal.reason}`);
			}
			return result.image;
		}

		const placement = async (projectId: string, sendId: string) =>
			(await listNewsletterSendImages(projectId, sendId)).map((i) => [
				i.altText,
				i.highlightIndex,
				i.position,
			]);

		describe("createNewsletterSendImage", () => {
			it("appends images to a highlight, included, with the send's tenant columns", async () => {
				const { project, send } = await seed();

				await attachOk(project.id, send.id, 1, "first");
				await attachOk(project.id, send.id, 1, "second");

				expect(await placement(project.id, send.id)).toEqual([
					["first", 1, 0],
					["second", 1, 1],
				]);
				const row = await db.newsletterSendImage.findFirstOrThrow({
					where: { sendId: send.id, altText: "first" },
				});
				expect(row).toMatchObject({
					included: true,
					source: "UPLOAD",
					captureState: "READY",
					organizationId: null,
					userId: USER_ID,
					projectId: project.id,
				});
			});

			it("refuses a third image on one highlight", async () => {
				const { project, send } = await seed();
				await attachOk(project.id, send.id, 0, "one");
				await attachOk(project.id, send.id, 0, "two");

				const result = await attach(project.id, send.id, 0, "three");

				expect(result).toEqual({
					ok: false,
					refusal: { reason: "HIGHLIGHT_FULL" },
				});
			});

			it("refuses three uploads racing for the last slots: exactly two win", async () => {
				const { project, send } = await seed();

				const results = await Promise.all([
					attach(project.id, send.id, 2, "x"),
					attach(project.id, send.id, 2, "y"),
					attach(project.id, send.id, 2, "z"),
				]);

				expect(results.filter((r) => r.ok)).toHaveLength(2);
				const positions = (
					await listNewsletterSendImages(project.id, send.id)
				).map((i) => i.position);
				expect(positions).toEqual([0, 1]);
			});

			it("refuses an index outside the frozen highlights", async () => {
				const { project, send } = await seed();

				const result = await attach(project.id, send.id, 3, "nope");

				expect(result).toEqual({
					ok: false,
					refusal: { reason: "HIGHLIGHT_OUT_OF_RANGE" },
				});
			});

			it("refuses a send that is not awaiting review, naming its status", async () => {
				const { project, send } = await seed({ status: "APPROVED" });

				const result = await attach(project.id, send.id, 0, "late");

				expect(result).toEqual({
					ok: false,
					refusal: { reason: "NOT_PENDING", status: "APPROVED" },
				});
			});

			it("refuses a send that does not take images", async () => {
				const { project, send } = await seed({
					screenshotsEnabled: false,
				});

				const result = await attach(project.id, send.id, 0, "off");

				expect(result).toEqual({
					ok: false,
					refusal: { reason: "SCREENSHOTS_DISABLED" },
				});
			});

			it("refuses another project's send", async () => {
				const { send } = await seed();
				const { project: other } = await seed();

				const result = await attach(other.id, send.id, 0, "foreign");

				expect(result).toEqual({
					ok: false,
					refusal: { reason: "SEND_NOT_FOUND" },
				});
			});
		});

		describe("updateNewsletterSendImage", () => {
			it("moves an image to another highlight and renumbers both", async () => {
				const { project, send } = await seed();
				const first = await attachOk(project.id, send.id, 0, "first");
				await attachOk(project.id, send.id, 0, "second");
				await attachOk(project.id, send.id, 1, "other");

				const result = await updateNewsletterSendImage({
					projectId: project.id,
					imageId: first.id,
					highlightIndex: 1,
					position: 0,
				});

				expect(result.ok).toBe(true);
				expect(await placement(project.id, send.id)).toEqual([
					["second", 0, 0],
					["first", 1, 0],
					["other", 1, 1],
				]);
			});

			it("reorders within a highlight", async () => {
				const { project, send } = await seed();
				await attachOk(project.id, send.id, 0, "first");
				const second = await attachOk(project.id, send.id, 0, "second");

				await updateNewsletterSendImage({
					projectId: project.id,
					imageId: second.id,
					position: 0,
				});

				expect(await placement(project.id, send.id)).toEqual([
					["second", 0, 0],
					["first", 0, 1],
				]);
			});

			it("refuses a move onto a full highlight", async () => {
				const { project, send } = await seed();
				const moving = await attachOk(project.id, send.id, 0, "moving");
				await attachOk(project.id, send.id, 1, "b1");
				await attachOk(project.id, send.id, 1, "b2");

				const result = await updateNewsletterSendImage({
					projectId: project.id,
					imageId: moving.id,
					highlightIndex: 1,
				});

				expect(result).toEqual({
					ok: false,
					refusal: { reason: "HIGHLIGHT_FULL" },
				});
			});

			it("updates inclusion and description", async () => {
				const { project, send } = await seed();
				const image = await attachOk(project.id, send.id, 0, "x");

				const result = await updateNewsletterSendImage({
					projectId: project.id,
					imageId: image.id,
					included: false,
					altText: "The settings page",
				});

				expect(result).toMatchObject({
					ok: true,
					image: { included: false, altText: "The settings page" },
				});
			});

			it("never finds an image through another project", async () => {
				const { project, send } = await seed();
				const image = await attachOk(project.id, send.id, 0, "mine");
				const { project: other } = await seed();

				const result = await updateNewsletterSendImage({
					projectId: other.id,
					imageId: image.id,
					included: false,
				});

				expect(result).toEqual({
					ok: false,
					refusal: { reason: "IMAGE_NOT_FOUND" },
				});
				expect(
					await db.newsletterSendImage.findUniqueOrThrow({
						where: { id: image.id },
					}),
				).toMatchObject({ included: true });
			});
		});

		describe("deleteNewsletterSendImage / replaceNewsletterSendImageStorage", () => {
			it("deletes an image, returns its key and closes the gap", async () => {
				const { project, send } = await seed();
				const first = await attachOk(project.id, send.id, 0, "first");
				await attachOk(project.id, send.id, 0, "second");

				const result = await deleteNewsletterSendImage({
					projectId: project.id,
					imageId: first.id,
				});

				expect(result).toEqual({
					ok: true,
					storageKey: first.storageKey,
					wasCapturing: false,
				});
				expect(await placement(project.id, send.id)).toEqual([
					["second", 0, 0],
				]);
			});

			it("replaces the object, re-includes the image and returns the old key", async () => {
				const { project, send } = await seed();
				const image = await attachOk(project.id, send.id, 0, "x");
				await updateNewsletterSendImage({
					projectId: project.id,
					imageId: image.id,
					included: false,
				});

				const result = await replaceNewsletterSendImageStorage({
					projectId: project.id,
					imageId: image.id,
					storageKey: `${USER_ID}/newsletter-images/${send.id}/new.jpg`,
					bytes: 2000,
					width: null,
					height: null,
				});

				expect(result).toMatchObject({
					ok: true,
					previousStorageKey: image.storageKey,
					image: { included: true, bytes: 2000, width: null },
				});
			});
		});

		describe("deleteDiscardedNewsletterSendImages", () => {
			/** A held send with two images, then moved to `status`. */
			async function seedWithImages(status: string) {
				const { project, send } = await seed();
				const one = await attachOk(project.id, send.id, 0, "one");
				const two = await attachOk(project.id, send.id, 1, "two");
				await db.newsletterSend.update({
					where: { id: send.id },
					data: { status },
				});
				return {
					project,
					send,
					keys: [one.storageKey, two.storageKey],
				};
			}

			const imageCount = (sendId: string) =>
				db.newsletterSendImage.count({ where: { sendId } });

			it.each(["REJECTED", "EXPIRED", "FAILED", "SKIPPED_EMPTY"])(
				"removes every image of a %s send and returns their keys",
				async (status) => {
					const { project, send, keys } =
						await seedWithImages(status);

					const removed = await deleteDiscardedNewsletterSendImages(
						project.id,
						send.id,
					);

					expect([...removed].sort()).toEqual([...keys].sort());
					expect(await imageCount(send.id)).toBe(0);
				},
			);

			it("returns the public copy of an image a failed send published", async () => {
				const { project, send, keys } = await seedWithImages("FAILED");
				const first = await db.newsletterSendImage.findFirstOrThrow({
					where: { sendId: send.id },
					orderBy: { highlightIndex: "asc" },
				});
				const publicKey = "newsletter-public/0123456789abcdef.jpg";
				await db.newsletterSendImage.update({
					where: { id: first.id },
					data: { publicKey },
				});

				const removed = await deleteDiscardedNewsletterSendImages(
					project.id,
					send.id,
				);

				expect([...removed].sort()).toEqual(
					[...keys, publicKey].sort(),
				);
			});

			it.each(["PENDING_APPROVAL", "APPROVED", "SENT"])(
				"keeps the images of a %s send",
				async (status) => {
					const { project, send } = await seedWithImages(status);

					const removed = await deleteDiscardedNewsletterSendImages(
						project.id,
						send.id,
					);

					expect(removed).toEqual([]);
					expect(await imageCount(send.id)).toBe(2);
				},
			);

			it("never removes the images of another project's send", async () => {
				const { send } = await seedWithImages("REJECTED");
				const { project: other } = await seed();

				const removed = await deleteDiscardedNewsletterSendImages(
					other.id,
					send.id,
				);

				expect(removed).toEqual([]);
				expect(await imageCount(send.id)).toBe(2);
			});

			it("leaves the other sends of the project alone", async () => {
				const { project, send } = await seedWithImages("REJECTED");
				const held = await db.newsletterSend.create({
					data: {
						...buildCreateSendData({
							projectId: project.id,
							organizationId: null,
							userId: USER_ID,
							dedupeKey: `manual:${RUN_ID}:held-${send.id}`,
							trigger: "MANUAL",
							timeWindowStart: new Date(0),
							timeWindowEnd: new Date(1),
							triggeredByUserId: USER_ID,
							detailLevel: "STANDARD",
							requireApproval: true,
							screenshotsEnabled: true,
						}),
						status: "PENDING_APPROVAL",
						content,
					},
				});
				await attachOk(project.id, held.id, 0, "held");

				await deleteDiscardedNewsletterSendImages(project.id, send.id);

				expect(await placement(project.id, held.id)).toEqual([
					["held", 0, 0],
				]);
			});

			it("returns no keys for a discarded send without images", async () => {
				const { project, send } = await seed({ status: "REJECTED" });

				const removed = await deleteDiscardedNewsletterSendImages(
					project.id,
					send.id,
				);

				expect(removed).toEqual([]);
			});
		});

		describe("createNewsletterCaptureRows", () => {
			const captures = [
				{ highlightIndex: 0, prompt: "The filters panel." },
				{ highlightIndex: 2, prompt: "The export dialog." },
			];
			const create = (projectId: string, sendId: string) =>
				createNewsletterCaptureRows({
					projectId,
					sendId,
					captures,
					included: true,
					createdByUserId: USER_ID,
				});

			it("creates one row per highlight, and a repeat adds none and resumes the open ones", async () => {
				const { project, send } = await seed({ status: "PENDING" });

				const first = await create(project.id, send.id);
				const again = await create(project.id, send.id);

				expect(first.map((row) => row.highlightIndex)).toEqual([0, 2]);
				expect(again).toEqual(first);
				expect(
					await db.newsletterSendImage.count({
						where: { sendId: send.id },
					}),
				).toBe(2);
			});

			it("leaves a highlight whose capture already finished alone", async () => {
				const { project, send } = await seed({ status: "PENDING" });
				const [done, open] = await create(project.id, send.id);
				await db.newsletterSendImage.update({
					where: { id: done.id },
					data: {
						captureState: "READY",
						storageKey: `${USER_ID}/newsletter-images/${send.id}/done.jpg`,
					},
				});

				const again = await create(project.id, send.id);

				expect(again).toEqual([open]);
				expect(
					await db.newsletterSendImage.count({
						where: { sendId: send.id },
					}),
				).toBe(2);
			});
		});

		describe("releaseStaleNewsletterCaptures", () => {
			async function capturing(
				projectId: string,
				sendId: string,
				highlightIndex: number,
				storageKey: string | null,
			) {
				return db.newsletterSendImage.create({
					data: {
						sendId,
						projectId,
						userId: USER_ID,
						highlightIndex,
						position: 0,
						captureState: "CAPTURING",
						included: true,
						source: "PROMPT",
						storageKey,
						prompt: "The filters panel.",
						createdByUserId: USER_ID,
					},
				});
			}
			const later = () =>
				new Date(Date.now() + NEWSLETTER_CAPTURE_STALE_MS + 60_000);

			it("fails an empty capture and returns a recapture to its image", async () => {
				const { project, send } = await seed();
				const empty = await capturing(project.id, send.id, 0, null);
				const over = await capturing(
					project.id,
					send.id,
					1,
					`${USER_ID}/newsletter-images/${send.id}/old.jpg`,
				);

				const released = await releaseStaleNewsletterCaptures({
					projectId: project.id,
					sendId: send.id,
					now: later(),
				});

				expect(released).toBe(2);
				expect(
					await db.newsletterSendImage.findUniqueOrThrow({
						where: { id: empty.id },
					}),
				).toMatchObject({
					captureState: "FAILED",
					errorMessage: "The capture stopped without a result.",
				});
				expect(
					await db.newsletterSendImage.findUniqueOrThrow({
						where: { id: over.id },
					}),
				).toMatchObject({
					captureState: "READY",
					storageKey: `${USER_ID}/newsletter-images/${send.id}/old.jpg`,
				});
				expect(
					await countCapturingNewsletterImages(project.id, send.id),
				).toBe(0);
			});

			it("leaves a capture that is still recent, and a send still generating", async () => {
				const { project, send } = await seed();
				const { project: generating, send: pending } = await seed({
					status: "PENDING",
				});
				await capturing(project.id, send.id, 0, null);
				await capturing(generating.id, pending.id, 0, null);

				expect(
					await releaseStaleNewsletterCaptures({
						projectId: project.id,
						sendId: send.id,
					}),
				).toBe(0);
				expect(
					await releaseStaleNewsletterCaptures({
						projectId: generating.id,
						now: later(),
					}),
				).toBe(0);
				expect(
					await countCapturingNewsletterImages(project.id, send.id),
				).toBe(1);
			});
		});

		describe("reviewer capture limit", () => {
			const actor = { userId: USER_ID, email: null, name: null };

			/** A held send with a capture environment and `starts` captures. */
			async function seedCapturable(starts: number) {
				const seeded = await seed();
				await db.newsletterSend.update({
					where: { id: seeded.send.id },
					data: {
						screenshotEnvironmentId: "env-1",
						captureStarts: starts,
					},
				});
				return seeded;
			}

			const promptCapture = (projectId: string, sendId: string) =>
				createPromptedNewsletterCapture({
					projectId,
					sendId,
					highlightIndex: 0,
					prompt: "The filters panel.",
					actor,
				});

			const startsOf = async (sendId: string) =>
				(
					await db.newsletterSend.findUniqueOrThrow({
						where: { id: sendId },
						select: { captureStarts: true },
					})
				).captureStarts;

			it("counts and audits each capture, and refuses one past the limit", async () => {
				const { project, send } = await seedCapturable(
					NEWSLETTER_REVIEWER_CAPTURES_MAX - 1,
				);

				const last = await promptCapture(project.id, send.id);
				const refused = await promptCapture(project.id, send.id);

				expect(last.ok).toBe(true);
				expect(refused).toEqual({
					ok: false,
					refusal: { reason: "CAPTURE_LIMIT" },
				});
				expect(await startsOf(send.id)).toBe(
					NEWSLETTER_REVIEWER_CAPTURES_MAX,
				);
				const audit = await db.auditLog.findMany({
					where: {
						action: "newsletter.screenshots.capture_started",
						resourceId: send.id,
					},
					select: { metadata: true },
				});
				expect(audit).toHaveLength(1);
				expect(audit[0]?.metadata).toMatchObject({
					sendId: send.id,
					imageId: last.ok ? last.image.id : "",
					kind: "prompt",
				});
			});

			it("counts a capture again against the same limit", async () => {
				const { project, send } = await seedCapturable(0);
				const first = await promptCapture(project.id, send.id);
				if (!first.ok) {
					throw new Error(`capture refused: ${first.refusal.reason}`);
				}
				await db.newsletterSendImage.update({
					where: { id: first.image.id },
					data: { captureState: "FAILED" },
				});
				await db.newsletterSend.update({
					where: { id: send.id },
					data: { captureStarts: NEWSLETTER_REVIEWER_CAPTURES_MAX },
				});

				const result = await startNewsletterImageRecapture({
					projectId: project.id,
					imageId: first.image.id,
					actor,
				});

				expect(result).toEqual({
					ok: false,
					refusal: { reason: "CAPTURE_LIMIT" },
				});
				expect(
					await db.newsletterSendImage.findUniqueOrThrow({
						where: { id: first.image.id },
					}),
				).toMatchObject({ captureState: "FAILED" });
			});
		});

		describe("includeAllNewsletterSendImages", () => {
			it("includes the READY images of kept highlights and nothing else", async () => {
				const { project, send } = await seed();
				const kept = await attachOk(project.id, send.id, 0, "kept");
				const dropped = await attachOk(
					project.id,
					send.id,
					1,
					"dropped",
				);
				const failed = await attachOk(project.id, send.id, 2, "failed");
				await db.newsletterSendImage.updateMany({
					where: { id: { in: [kept.id, dropped.id, failed.id] } },
					data: { included: false },
				});
				await db.newsletterSendImage.update({
					where: { id: failed.id },
					data: { captureState: "FAILED" },
				});

				const result = await includeAllNewsletterSendImages({
					projectId: project.id,
					sendId: send.id,
					removedHighlightIndexes: [1],
				});

				expect(result.ok && result.images.map((i) => i.id)).toEqual([
					kept.id,
				]);
				const included = (
					await listNewsletterSendImages(project.id, send.id)
				).map((i) => [i.altText, i.included]);
				expect(included).toEqual([
					["kept", true],
					["dropped", false],
					["failed", false],
				]);
			});
		});

		describe("startNewsletterImageRecapture", () => {
			it("includes an empty failed slot the reviewer captures again", async () => {
				const { project, send } = await seed({
					status: "PENDING_APPROVAL",
				});
				await db.newsletterSend.update({
					where: { id: send.id },
					data: { screenshotEnvironmentId: "env-1" },
				});
				const failed = await db.newsletterSendImage.create({
					data: {
						sendId: send.id,
						projectId: project.id,
						userId: USER_ID,
						highlightIndex: 0,
						position: 0,
						captureState: "FAILED",
						included: false,
						source: "AI",
						prompt: "The filters panel.",
						createdByUserId: USER_ID,
					},
				});

				const result = await startNewsletterImageRecapture({
					projectId: project.id,
					imageId: failed.id,
					actor: { userId: USER_ID },
				});

				expect(result).toMatchObject({
					ok: true,
					image: { captureState: "CAPTURING", included: true },
				});
			});
		});

		describe("approveNewsletterSend with images", () => {
			it("embeds only included READY images of kept highlights and keeps the stored order", async () => {
				const { project, send } = await seed();
				const kept = await attachOk(project.id, send.id, 0, "kept");
				const excluded = await attachOk(
					project.id,
					send.id,
					0,
					"excluded",
				);
				const removedHighlight = await attachOk(
					project.id,
					send.id,
					1,
					"gone",
				);
				const replaced = await attachOk(
					project.id,
					send.id,
					2,
					"replaced",
				);
				await updateNewsletterSendImage({
					projectId: project.id,
					imageId: excluded.id,
					included: false,
				});
				const publish = (image: {
					id: string;
					storageKey: string | null;
				}) => ({
					imageId: image.id,
					storageKey: image.storageKey ?? "",
					publicKey: `newsletter-public/${image.id}.png`,
					url: `https://example.com/image-proxy/b/newsletter-public/${image.id}.png`,
				});

				const result = await approveNewsletterSend({
					sendId: send.id,
					removedHighlightIndexes: [1],
					highlightOrder: [2, 0, 1],
					publishedImages: [
						publish(kept),
						publish(excluded),
						publish(removedHighlight),
						// Published from a key the image no longer points at.
						{ ...publish(replaced), storageKey: "stale/key.png" },
					],
					audit: {
						reviewedByUserId: USER_ID,
						organizationId: null,
						projectId: project.id,
					},
				});

				expect(result).toEqual({
					approved: true,
					embeddedImageIds: [kept.id],
				});
				const stored = await db.newsletterSend.findUniqueOrThrow({
					where: { id: send.id },
				});
				expect(stored.highlightOrder).toEqual([2, 0, 1]);
				expect(stored.content).toEqual({
					...content,
					highlights: [
						{
							...content.highlights[0],
							images: [
								{
									url: publish(kept).url,
									alt: "kept",
									width: 800,
									height: 450,
								},
							],
						},
						content.highlights[1],
						content.highlights[2],
					],
				});
				const keptRow = await db.newsletterSendImage.findUniqueOrThrow({
					where: { id: kept.id },
				});
				expect(keptRow.publicKey).toBe(publish(kept).publicKey);

				// Once approved, the images can no longer change.
				expect(await attach(project.id, send.id, 2, "after")).toEqual({
					ok: false,
					refusal: { reason: "NOT_PENDING", status: "APPROVED" },
				});
			});

			it("embeds nothing and leaves the content alone when the approval loses", async () => {
				const { project, send } = await seed();
				const image = await attachOk(project.id, send.id, 0, "x");
				await db.newsletterSend.update({
					where: { id: send.id },
					data: { status: "REJECTED" },
				});

				const result = await approveNewsletterSend({
					sendId: send.id,
					removedHighlightIndexes: [],
					publishedImages: [
						{
							imageId: image.id,
							storageKey: image.storageKey ?? "",
							publicKey: "newsletter-public/x.png",
							url: "https://example.com/x.png",
						},
					],
					audit: {
						reviewedByUserId: USER_ID,
						organizationId: null,
						projectId: project.id,
					},
				});

				expect(result).toEqual({
					approved: false,
					embeddedImageIds: [],
				});
				const stored = await db.newsletterSend.findUniqueOrThrow({
					where: { id: send.id },
				});
				expect(stored.content).toEqual(content);
			});

			it("is not approved while a screenshot is still being captured", async () => {
				const { project, send } = await seed();
				const image = await attachOk(project.id, send.id, 0, "x");
				await db.newsletterSendImage.update({
					where: { id: image.id },
					data: { captureState: "CAPTURING" },
				});

				const result = await approveNewsletterSend({
					sendId: send.id,
					removedHighlightIndexes: [],
					audit: {
						reviewedByUserId: USER_ID,
						organizationId: null,
						projectId: project.id,
					},
				});

				expect(result).toEqual({
					approved: false,
					embeddedImageIds: [],
					stillCapturing: true,
				});
				expect(
					(
						await db.newsletterSend.findUniqueOrThrow({
							where: { id: send.id },
						})
					).status,
				).toBe("PENDING_APPROVAL");
			});

			it("writes the placement of an image shown above its text", async () => {
				const { project, send } = await seed();
				const above = await attachOk(project.id, send.id, 0, "above");
				const below = await attachOk(project.id, send.id, 0, "below");
				await updateNewsletterSendImage({
					projectId: project.id,
					imageId: above.id,
					placement: "ABOVE",
				});
				const publish = (image: {
					id: string;
					storageKey: string | null;
				}) => ({
					imageId: image.id,
					storageKey: image.storageKey ?? "",
					publicKey: `newsletter-public/${image.id}.png`,
					url: `https://example.com/image-proxy/b/newsletter-public/${image.id}.png`,
				});

				await approveNewsletterSend({
					sendId: send.id,
					removedHighlightIndexes: [],
					publishedImages: [publish(above), publish(below)],
					audit: {
						reviewedByUserId: USER_ID,
						organizationId: null,
						projectId: project.id,
					},
				});

				const stored = await db.newsletterSend.findUniqueOrThrow({
					where: { id: send.id },
				});
				const parsed = newsletterContentSchema.parse(stored.content);
				expect(parsed.highlights[0]?.images).toEqual([
					{
						url: publish(above).url,
						alt: "above",
						width: 800,
						height: 450,
						placement: "ABOVE",
					},
					{
						url: publish(below).url,
						alt: "below",
						width: 800,
						height: 450,
					},
				]);
			});
		});

		describe("taking a sent newsletter's images down", () => {
			/** A sent send whose two images were published into its content. */
			async function seedPublished() {
				const { project, send } = await seed();
				const one = await attachOk(project.id, send.id, 0, "one");
				const two = await attachOk(project.id, send.id, 1, "two");
				const url = (id: string) =>
					`https://example.com/image-proxy/b/newsletter-public/${id}.png`;
				await approveNewsletterSend({
					sendId: send.id,
					removedHighlightIndexes: [],
					publishedImages: [one, two].map((image) => ({
						imageId: image.id,
						storageKey: image.storageKey ?? "",
						publicKey: `newsletter-public/${image.id}.png`,
						url: url(image.id),
					})),
					audit: {
						reviewedByUserId: USER_ID,
						organizationId: null,
						projectId: project.id,
					},
				});
				await db.newsletterSend.update({
					where: { id: send.id },
					data: { status: "SENT" },
				});
				return { project, send, one, two };
			}

			it("lists the public copies of a sent send, and refuses one not sent", async () => {
				const { project, send, one, two } = await seedPublished();
				const { project: heldProject, send: held } = await seed();

				const published = await listPublishedNewsletterSendImages(
					project.id,
					send.id,
				);
				const notSent = await listPublishedNewsletterSendImages(
					heldProject.id,
					held.id,
				);

				expect(published).toEqual({
					ok: true,
					images: [one, two].map((image) => ({
						id: image.id,
						publicKey: `newsletter-public/${image.id}.png`,
					})),
				});
				expect(notSent).toEqual({
					ok: false,
					refusal: { reason: "NOT_SENT", status: "PENDING_APPROVAL" },
				});
			});

			it("clears only the images taken down, drops them from the content and audits it", async () => {
				const { project, send, one, two } = await seedPublished();

				const removed = await clearPublishedNewsletterSendImages({
					projectId: project.id,
					sendId: send.id,
					imageIds: [one.id],
					failedCount: 1,
					actor: { userId: USER_ID },
				});

				expect(removed).toBe(1);
				const rows = await db.newsletterSendImage.findMany({
					where: { sendId: send.id },
					orderBy: { highlightIndex: "asc" },
					select: { publicKey: true },
				});
				expect(rows.map((row) => row.publicKey)).toEqual([
					null,
					`newsletter-public/${two.id}.png`,
				]);
				const stored = await db.newsletterSend.findUniqueOrThrow({
					where: { id: send.id },
				});
				const parsed = newsletterContentSchema.parse(stored.content);
				expect(parsed.highlights[0]?.images).toBeUndefined();
				expect(parsed.highlights[1]?.images).toHaveLength(1);
				const audit = await db.auditLog.findMany({
					where: {
						action: "newsletter.screenshots.unpublished",
						resourceId: send.id,
					},
					select: { metadata: true },
				});
				expect(audit).toHaveLength(1);
				expect(audit[0]?.metadata).toMatchObject({
					removedCount: 1,
					failedCount: 1,
				});
			});
		});
	},
);
