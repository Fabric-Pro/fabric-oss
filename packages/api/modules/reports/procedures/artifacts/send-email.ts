import { ORPCError } from "@orpc/server";
import { createId } from "@paralleldrive/cuid2";
import {
	createTemplateInstanceArtifactEmailDeliveries,
	db,
	getTemplateInstanceArtifact,
} from "@repo/database";
import { sendEmail } from "@repo/mail";
import { downloadFile } from "@repo/storage";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertArtifactTenantAccess } from "./_tenant";

/**
 * MVP cap on recipients per send action — bounds the synchronous loop and
 * dissuades misuse. Above this, the UI / API will reject the request.
 */
const MAX_RECIPIENTS = 50;

const sendEmailInputSchema = z
	.object({
		artifactId: z.string(),
		organizationId: z.string().nullable().optional(),
		recipientUserIds: z.array(z.string()).default([]),
		recipientEmails: z.array(z.string().email()).default([]),
		messageBody: z.string().max(10_000).optional(),
	})
	.refine((v) => v.recipientUserIds.length + v.recipientEmails.length > 0, {
		message: "At least one recipient is required",
	})
	.refine(
		(v) =>
			v.recipientUserIds.length + v.recipientEmails.length <=
			MAX_RECIPIENTS,
		{
			message: `Too many recipients (max ${MAX_RECIPIENTS} per send)`,
		},
	);

/**
 * Send a generated report artifact by email to a set of organization members
 * and/or freeform external email addresses. Each recipient receives a separate
 * message with the artifact attached. Per-recipient outcome is recorded in
 * `report_artifact_email_delivery` and the aggregated `{ sent, failed }`
 * counts are returned to the UI so the user gets an immediate confirmation
 * (or partial-failure surface) per Fizzy #1026 acceptance criteria.
 *
 * Synchronous fan-out by design — MVP, ≤ 50 recipients. Provider failures are
 * caught per-recipient and surfaced; one bad address does not abort the rest.
 */
export const sendArtifactEmailProcedure = tenantProtectedProcedure
	.use(requireInputOrgPermission(Permissions.REPORT_SHARE))
	.input(sendEmailInputSchema)
	.handler(async ({ input, context }) => {
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		const artifact = await getTemplateInstanceArtifact(input.artifactId);

		if (!artifact) {
			throw new ORPCError("NOT_FOUND", {
				message: "Report artifact not found",
			});
		}

		assertArtifactTenantAccess(artifact, {
			userId: context.user.id,
			organizationId,
		});

		// Resolve the attachment payload from whichever storage backend the
		// artifact was written to. Mirrors `downloadArtifactProcedure` so the
		// "Send" action works for every output format the workflow emits.
		let attachmentContent: Buffer;
		if (artifact.content && !artifact.s3Path) {
			attachmentContent = Buffer.from(artifact.content, "utf-8");
		} else if (artifact.s3Path && artifact.s3Bucket) {
			const { data } = await downloadFile(artifact.s3Path, {
				bucket: artifact.s3Bucket,
			});
			attachmentContent = data;
		} else {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Artifact has no content available",
			});
		}

		// Resolve org-member recipients to their {id, name, email}. We only
		// load users from the active tenant — for personal context we just
		// confirm `userId === self`, for org context we accept any member of
		// the same org. Anything outside is silently dropped.
		const userRecipients = input.recipientUserIds.length
			? await db.user.findMany({
					where: organizationId
						? {
								id: { in: input.recipientUserIds },
								members: { some: { organizationId } },
							}
						: {
								id: {
									in: input.recipientUserIds.filter(
										(id) => id === context.user.id,
									),
								},
							},
					select: { id: true, name: true, email: true },
				})
			: [];

		// Dedupe everything by email — an org member who is also pasted in the
		// freeform field must only receive one message.
		const seen = new Set<string>();
		const recipients: Array<{
			email: string;
			userId: string | null;
			displayName: string | null;
		}> = [];

		for (const u of userRecipients) {
			const key = u.email.toLowerCase();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			recipients.push({
				email: u.email,
				userId: u.id,
				displayName: u.name ?? null,
			});
		}
		for (const e of input.recipientEmails) {
			const key = e.toLowerCase();
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			recipients.push({ email: e, userId: null, displayName: null });
		}

		if (recipients.length === 0) {
			throw new ORPCError("BAD_REQUEST", {
				message: "No valid recipients after deduplication",
			});
		}

		const subject = `${artifact.name} — Fabric report`;
		const defaultText = `${context.user.name ?? context.user.email} shared a Fabric report with you.\nAttachment: ${artifact.name}\n`;
		const textBody = input.messageBody
			? `${input.messageBody}\n\n—\n${defaultText}`
			: defaultText;

		const deliveryRows: Array<{
			recipient: (typeof recipients)[number];
			status: "SENT" | "FAILED";
			errorMessage: string | null;
		}> = [];

		for (const recipient of recipients) {
			try {
				const ok = await sendEmail({
					to: recipient.email,
					subject,
					text: textBody,
					attachments: [
						{
							filename: artifact.name,
							content: attachmentContent,
							contentType: artifact.mimeType,
						},
					],
				});
				if (ok) {
					deliveryRows.push({
						recipient,
						status: "SENT",
						errorMessage: null,
					});
				} else {
					// sendEmail swallows provider errors and returns false —
					// see packages/mail/src/util/send.ts. We don't have the
					// underlying message, but we MUST record the failure.
					deliveryRows.push({
						recipient,
						status: "FAILED",
						errorMessage: "Email provider rejected the message",
					});
				}
			} catch (e) {
				deliveryRows.push({
					recipient,
					status: "FAILED",
					errorMessage:
						e instanceof Error ? e.message : "Unknown error",
				});
			}
		}

		// Single `sendId` ties all per-recipient rows of this Send-button click
		// together so the history UI collapses them into one entry.
		const sendId = createId();

		await createTemplateInstanceArtifactEmailDeliveries(
			deliveryRows.map((row) => ({
				artifactId: artifact.id,
				sendId,
				userId: context.user.id,
				organizationId: organizationId ?? null,
				recipientUserId: row.recipient.userId,
				recipientEmail: row.recipient.email,
				messageBody: input.messageBody ?? null,
				status: row.status,
				errorMessage: row.errorMessage,
			})),
		);

		const sent = deliveryRows.filter((r) => r.status === "SENT").length;
		const failed = deliveryRows
			.filter((r) => r.status === "FAILED")
			.map((r) => ({
				email: r.recipient.email,
				error: r.errorMessage ?? "Unknown error",
			}));

		return {
			sent,
			failed,
			totalRecipients: recipients.length,
		};
	});
