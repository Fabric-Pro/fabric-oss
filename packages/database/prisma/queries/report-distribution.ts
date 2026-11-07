import { createHash } from "node:crypto";
import {
	hasPermission,
	Permissions,
	resolveOrgPermissions,
} from "@repo/permissions";
import { z } from "zod";
import { db, type Prisma } from "../client";
import { recordAuditTx } from "./audit-log";
import {
	canAccessReportInstance,
	readReportProjectBindings,
} from "./lib/report-access";

export class ReportDistributionError extends Error {
	constructor(
		readonly code: "NOT_FOUND" | "FORBIDDEN" | "CONFLICT" | "BAD_REQUEST",
		message: string,
	) {
		super(message);
		this.name = "ReportDistributionError";
	}
}
const metadataOf = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
export function reportArtifactHash(artifact: {
	content: string | null;
	s3Path?: string | null;
	metadata?: unknown;
}): string | null {
	if (!artifact.s3Path && artifact.content !== null) {
		return createHash("sha256").update(artifact.content).digest("hex");
	}
	const value = metadataOf(artifact.metadata).sha256;
	return typeof value === "string" && /^[a-f0-9]{64}$/.test(value)
		? value
		: null;
}
export const reportDistributionSchema = z.strictObject({
	artifactId: z.string().min(1),
	requestId: z.string().uuid(),
	expectedArtifactHash: z.string().regex(/^[a-f0-9]{64}$/),
	recipientUserIds: z.array(z.string().min(1)).min(1).max(50),
	message: z.string().max(1000).optional(),
});
const receiptSchema = z.strictObject({
	id: z.string().uuid(),
	fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
	recipientUserIds: z.array(z.string()).max(50),
	distributedAt: z.string().datetime(),
	senderUserId: z.string(),
});
const receiptsOf = (metadata: Record<string, unknown>) =>
	z
		.array(receiptSchema)
		.max(200)
		.parse(metadata.reportInboxDistributions ?? []);
export function reportInboxDeliveryHistory(metadata: unknown) {
	return receiptsOf(metadataOf(metadata)).map(
		({ fingerprint: _, ...receipt }) => ({
			...receipt,
			channel: "INBOX" as const,
		}),
	);
}
export interface ReportDistributionActor {
	userId: string;
	organizationId: string;
	boundProjectId?: string;
}
/** Explicit inbox publication: the immutable artifact hash, audience, receipt and notifications commit together. */
export async function distributeReportArtifact(
	actor: ReportDistributionActor,
	raw: z.input<typeof reportDistributionSchema>,
) {
	const input = reportDistributionSchema.parse(raw);
	input.requestId = input.requestId.toLowerCase();
	const recipients = [...new Set(input.recipientUserIds)].sort();
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify([
				input.artifactId,
				input.expectedArtifactHash,
				recipients,
				input.message ?? "",
			]),
		)
		.digest("hex");
	return db.$transaction(async (tx) => {
		await tx.$queryRaw`SELECT id FROM template_instance_artifact WHERE id=${input.artifactId} FOR UPDATE`;
		const artifact = await tx.templateInstanceArtifact.findFirst({
			where: {
				id: input.artifactId,
				organizationId: actor.organizationId,
			},
			include: { execution: { include: { instance: true } } },
		});
		if (
			!artifact ||
			artifact.execution.status !== "COMPLETED" ||
			!(await canAccessReportInstance(
				artifact.execution.instance,
				actor,
				artifact.execution.parameters,
			))
		) {
			throw new ReportDistributionError(
				"NOT_FOUND",
				"Report artifact not found",
			);
		}
		const member = await tx.member.findUnique({
			where: {
				organizationId_userId: {
					organizationId: actor.organizationId,
					userId: actor.userId,
				},
			},
			select: { role: true },
		});
		if (
			!member ||
			!hasPermission(
				resolveOrgPermissions(member.role),
				Permissions.REPORT_SHARE,
			)
		) {
			throw new ReportDistributionError(
				"FORBIDDEN",
				"Your current role cannot distribute reports",
			);
		}
		const projects = readReportProjectBindings(
			artifact.execution.instance.fabricConfig,
			artifact.execution.parameters,
		);
		if (
			actor.boundProjectId &&
			(projects.length !== 1 || projects[0] !== actor.boundProjectId)
		) {
			throw new ReportDistributionError(
				"NOT_FOUND",
				"Report artifact not found",
			);
		}
		if (reportArtifactHash(artifact) !== input.expectedArtifactHash) {
			throw new ReportDistributionError(
				"CONFLICT",
				"The report artifact changed. Review the exact output again.",
			);
		}
		const allowed = await Promise.all(
			recipients.map((userId) =>
				canAccessReportInstance(
					artifact.execution.instance,
					{ userId, organizationId: actor.organizationId },
					artifact.execution.parameters,
				),
			),
		);
		if (allowed.some((value) => !value)) {
			throw new ReportDistributionError(
				"FORBIDDEN",
				"Every recipient must currently have access to this report and its project evidence",
			);
		}
		const metadata = metadataOf(artifact.metadata);
		const receipts = receiptsOf(metadata);
		const existing = receipts.find(
			(receipt) =>
				receipt.id === input.requestId &&
				receipt.senderUserId === actor.userId,
		);
		if (existing) {
			if (existing.fingerprint !== fingerprint) {
				throw new ReportDistributionError(
					"CONFLICT",
					"This delivery request was already used for different recipients or output",
				);
			}
			return {
				deliveryId: existing.id,
				channel: "INBOX" as const,
				recipientCount: existing.recipientUserIds.length,
				distributedAt: existing.distributedAt,
				replayed: true,
			};
		}
		if (receipts.length >= 200) {
			throw new ReportDistributionError(
				"BAD_REQUEST",
				"This artifact has reached its delivery-history limit. Create a new reviewed edition.",
			);
		}
		const distributedAt = new Date().toISOString();
		await tx.notification.createMany({
			data: recipients.map((userId) => ({
				id: `report-delivery-${createHash("sha256")
					.update(
						JSON.stringify([
							actor.organizationId,
							actor.userId,
							input.artifactId,
							input.requestId,
							userId,
						]),
					)
					.digest("hex")}`,
				userId,
				organizationId: actor.organizationId,
				type: "REPORT_COMPLETED",
				category: "SYSTEM",
				title: "A report was shared with you",
				snippet:
					input.message?.trim() ||
					"Open the reviewed report artifact",
				link: `report-templates/instances/${artifact.execution.instanceId}?tab=history&executionId=${artifact.execution.id}&artifactId=${artifact.id}`,
				projectId: projects.length === 1 ? projects[0] : undefined,
				actorUserId: actor.userId,
				payload: {
					executionId: artifact.execution.id,
					instanceId: artifact.execution.instanceId,
					instanceName: artifact.execution.instance.name,
					status: "COMPLETED",
					artifactId: artifact.id,
					distributionId: input.requestId,
				},
			})),
		});
		await tx.templateInstanceArtifact.update({
			where: { id: artifact.id },
			data: {
				metadata: {
					...metadata,
					reportInboxDistributions: [
						...receipts,
						{
							id: input.requestId,
							fingerprint,
							recipientUserIds: recipients,
							distributedAt,
							senderUserId: actor.userId,
						},
					],
				} as Prisma.InputJsonValue,
			},
		});
		await recordAuditTx(tx, {
			category: "org",
			action: "report.artifact_distributed",
			organizationId: actor.organizationId,
			actor: { type: "user", userId: actor.userId },
			resource: { type: "report_artifact", id: artifact.id },
			metadata: {
				executionId: artifact.execution.id,
				channel: "INBOX",
				recipientCount: recipients.length,
				deliveryId: input.requestId,
			},
		});
		return {
			deliveryId: input.requestId,
			channel: "INBOX" as const,
			recipientCount: recipients.length,
			distributedAt,
			replayed: false,
		};
	});
}
