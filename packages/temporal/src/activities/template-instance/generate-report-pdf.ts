import { createHash } from "node:crypto";
import { config } from "@repo/config";
import { canExecuteReportInstance, db, recordAuditTx } from "@repo/database";
import type { Prisma } from "@repo/database/prisma/generated/client";
import { deleteFile, uploadFile } from "@repo/storage";
import { Context } from "@temporalio/activity";
import { ApplicationFailure } from "@temporalio/common";
import { generatePDFActivity } from "../frame-export/generate-pdf";
import { getFrameContentActivity } from "../frame-export/get-frame-content";
import { loadReportPublication } from "./report-publication";

export interface ReportPdfInput {
	executionId: string;
	sourceArtifactId: string;
	userId: string;
	organizationId: string;
}
const object = (value: unknown): Record<string, unknown> =>
	value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
const refused = () =>
	ApplicationFailure.nonRetryable(
		"The report document changed or is unavailable. Review it before generating a PDF.",
		"REPORT_PDF_UNAVAILABLE",
	);
/** One offline render/upload activity: PDF bytes never enter workflow history. */
export async function generateReportPdfArtifact(input: ReportPdfInput) {
	const { execution } = await loadReportPublication(input);
	const source = await db.templateInstanceArtifact.findFirst({
		where: {
			id: input.sourceArtifactId,
			executionId: input.executionId,
			userId: input.userId,
			organizationId: input.organizationId,
		},
	});
	const metadata = object(source?.metadata);
	if (
		!source ||
		!["MARKDOWN", "HTML"].includes(source.artifactType) ||
		typeof metadata.linkedFrameId !== "string" ||
		typeof metadata.linkedFrameUpdatedAt !== "string"
	) {
		throw refused();
	}
	const name = `${source.name.replace(/\.(md|html)$/i, "")}.pdf`;
	const existing = await db.templateInstanceArtifact.findFirst({
		where: {
			executionId: input.executionId,
			organizationId: input.organizationId,
			userId: input.userId,
			name,
			artifactType: "PDF",
		},
	});
	if (existing) {
		return {
			id: existing.id,
			name: existing.name,
			artifactType: "PDF",
			mimeType: "application/pdf",
			size: existing.size,
		};
	}
	const activity = Context.current();
	const heartbeat = setInterval(
		() => activity.heartbeat("Rendering report PDF"),
		5000,
	);
	let key: string | undefined;
	try {
		activity.cancellationSignal.throwIfAborted();
		const frame = await getFrameContentActivity({
			frameId: metadata.linkedFrameId,
			userId: input.userId,
			organizationId: input.organizationId,
			expectedUpdatedAt: metadata.linkedFrameUpdatedAt,
		});
		if (
			frame.document.metadata?.sourceRunType !== "REPORT_EXECUTION" ||
			frame.document.metadata?.sourceRunId !== input.executionId
		) {
			throw refused();
		}
		const pdf = await generatePDFActivity({
			content: frame.document,
			orientation: "portrait",
		});
		activity.cancellationSignal.throwIfAborted();
		await loadReportPublication(input);
		const sha256 = createHash("sha256").update(pdf).digest("hex");
		key = `report-artifacts/${input.organizationId}/${input.executionId}/${sha256}.pdf`;
		await uploadFile(key, pdf, {
			bucket: config.storage.bucketNames.projectContexts,
			contentType: "application/pdf",
			access: "private",
		});
		activity.cancellationSignal.throwIfAborted();
		const result = await db.$transaction(async (tx) => {
			await tx.$queryRaw`SELECT id FROM template_instance WHERE id=${execution.instanceId} FOR SHARE`;
			await tx.$queryRaw`SELECT id FROM template_instance_execution WHERE id=${input.executionId} FOR UPDATE`;
			const current = await tx.templateInstanceExecution.findFirst({
				where: {
					id: input.executionId,
					userId: input.userId,
					organizationId: input.organizationId,
				},
				include: { instance: true },
			});
			if (
				!current ||
				current.status === "CANCELLED" ||
				!current.instance.isActive ||
				!(await canExecuteReportInstance(
					current.instance,
					input,
					current.parameters,
				))
			) {
				throw refused();
			}
			await loadReportPublication(input);
			await tx.$queryRaw`SELECT id FROM agent_workspace_file WHERE id=${metadata.linkedFrameId} FOR SHARE`;
			const reviewed = await tx.agentWorkspaceFile.findFirst({
				where: {
					id: metadata.linkedFrameId as string,
					organizationId: input.organizationId,
					sourceRunType: "REPORT_EXECUTION",
					sourceRunId: input.executionId,
					updatedAt: new Date(
						metadata.linkedFrameUpdatedAt as string,
					),
				},
				select: { id: true },
			});
			if (!reviewed) {
				throw refused();
			}
			const winner = await tx.templateInstanceArtifact.findFirst({
				where: {
					executionId: input.executionId,
					organizationId: input.organizationId,
					userId: input.userId,
					name,
					artifactType: "PDF",
				},
			});
			if (winner) {
				return winner;
			}
			const artifact = await tx.templateInstanceArtifact.create({
				data: {
					executionId: input.executionId,
					userId: input.userId,
					organizationId: input.organizationId,
					name,
					description: source.description,
					artifactType: "PDF",
					s3Path: key,
					s3Bucket: config.storage.bucketNames.projectContexts,
					mimeType: "application/pdf",
					size: pdf.length,
					metadata: {
						sourceArtifactId: source.id,
						linkedFrameId: metadata.linkedFrameId,
						sourceFrameUpdatedAt: metadata.linkedFrameUpdatedAt,
						sha256,
						...(frame.document.theme?.branding
							? { branding: frame.document.theme.branding }
							: {}),
					} as Prisma.InputJsonValue,
				},
			});
			await recordAuditTx(tx, {
				category: "org",
				action: "report.artifact_generated",
				organizationId: input.organizationId,
				actor: { type: "user", userId: input.userId },
				resource: { type: "report_artifact", id: artifact.id },
				metadata: {
					executionId: input.executionId,
					sourceArtifactId: source.id,
					format: "PDF",
				},
			});
			return artifact;
		});
		if (result.s3Path !== key) {
			await deleteFile(key, {
				bucket: config.storage.bucketNames.projectContexts,
			}).catch(() => undefined);
		}
		return {
			id: result.id,
			name: result.name,
			artifactType: "PDF",
			mimeType: "application/pdf",
			size: result.size,
		};
	} catch (error) {
		if (
			key &&
			!(await db.templateInstanceArtifact
				.findFirst({
					where: {
						s3Path: key,
						organizationId: input.organizationId,
						executionId: input.executionId,
					},
					select: { id: true },
				})
				.catch(() => ({ id: "unknown" })))
		) {
			await deleteFile(key, {
				bucket: config.storage.bucketNames.projectContexts,
			}).catch(() => undefined);
		}
		throw error;
	} finally {
		clearInterval(heartbeat);
	}
}
