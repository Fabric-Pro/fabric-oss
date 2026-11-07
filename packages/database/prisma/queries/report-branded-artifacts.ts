import { artifactBrandFontFaceCss } from "@repo/utils/artifact-brand-fonts";
import type { ArtifactBrandSnapshot } from "@repo/utils/artifact-brand-snapshot";
import {
	artifactBrandCoverHtml,
	artifactBrandPresentationCss,
	artifactBrandSnapshotSchema,
} from "@repo/utils/artifact-brand-snapshot";
import {
	ARTIFACT_STATIC_CSP,
	sanitizeArtifactHtmlFragment,
} from "@repo/utils/artifact-static-html";
import { db, type Prisma } from "../client";
import { recordAuditTx } from "./audit-log";
import { createFrame } from "./frames";
import { canExecuteReportInstance } from "./lib/report-access";
import { hasProjectAccess } from "./projects/projects";

/** One artifact and one linked Frame per occurrence/output, even after a lost activity response. */
export async function storeBrandedReportArtifact(input: {
	executionId: string;
	userId: string;
	organizationId: string;
	projectId?: string;
	name: string;
	description?: string;
	artifactType: "MARKDOWN" | "HTML";
	content: string;
	mimeType: string;
	metadata?: Prisma.InputJsonValue;
	branding?: ArtifactBrandSnapshot;
}) {
	const branding = input.branding
		? artifactBrandSnapshotSchema.parse(input.branding)
		: undefined;
	return db.$transaction(async (tx) => {
		await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`report-brand:${input.executionId}:${input.name}:${input.artifactType}`}, 0))`;
		await tx.$queryRaw`SELECT id FROM template_instance_execution WHERE id = ${input.executionId} FOR UPDATE`;
		const execution = await tx.templateInstanceExecution.findFirst({
			where: {
				id: input.executionId,
				userId: input.userId,
				organizationId: input.organizationId,
			},
			include: { instance: true },
		});
		if (
			!execution ||
			execution.status === "CANCELLED" ||
			!execution.instance.isActive ||
			!(await canExecuteReportInstance(
				execution.instance,
				{ userId: input.userId, organizationId: input.organizationId },
				execution.parameters,
			))
		) {
			throw new Error("Report publication access was revoked");
		}
		if (
			input.projectId &&
			(!(await tx.project.findFirst({
				where: {
					id: input.projectId,
					organizationId: input.organizationId,
					deletedAt: null,
				},
				select: { id: true },
			})) ||
				!(await hasProjectAccess(
					input.projectId,
					input.userId,
					input.organizationId,
					tx,
				)))
		) {
			throw new Error("Project report publication access was revoked");
		}
		const prior = await tx.templateInstanceArtifact.findFirst({
			where: {
				executionId: input.executionId,
				userId: input.userId,
				organizationId: input.organizationId,
				name: input.name,
				artifactType: input.artifactType,
			},
		});
		if (prior) {
			return prior;
		}
		const title = input.name.replace(/\.(md|html)$/i, "");
		const frame = await createFrame(
			{
				userId: input.userId,
				organizationId: input.organizationId,
				projectId: input.projectId,
				title,
				description: input.description,
				blocks: [
					{
						id: "report",
						type:
							input.artifactType === "HTML" ? "html" : "markdown",
						content:
							input.artifactType === "HTML"
								? sanitizeArtifactHtmlFragment(input.content)
								: input.content,
					},
				],
				theme: { mode: "light", ...(branding ? { branding } : {}) },
				surface: input.projectId ? "artifact" : "workspace",
				presentation: "DOCUMENT",
				sourceRunType: "REPORT_EXECUTION",
				sourceRunId: input.executionId,
				sourceNodeId: input.name,
			},
			tx,
		);
		const metadata =
			input.metadata &&
			typeof input.metadata === "object" &&
			!Array.isArray(input.metadata)
				? input.metadata
				: {};
		const content =
			input.artifactType === "HTML" && branding
				? `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_STATIC_CSP}"><style>${artifactBrandFontFaceCss(branding)}${artifactBrandPresentationCss(branding)}</style></head><body>${artifactBrandCoverHtml(branding, title)}${sanitizeArtifactHtmlFragment(input.content)}</body></html>`
				: input.content;
		const artifact = await tx.templateInstanceArtifact.create({
			data: {
				executionId: input.executionId,
				userId: input.userId,
				organizationId: input.organizationId,
				name: input.name,
				description: input.description,
				artifactType: input.artifactType,
				content,
				mimeType: input.mimeType,
				size: Buffer.byteLength(content, "utf8"),
				metadata: {
					...metadata,
					...(branding ? { branding } : {}),
					linkedFrameId: frame.id,
					linkedFrameUpdatedAt: frame.updatedAt.toISOString(),
				} as Prisma.InputJsonValue,
			},
		});
		await recordAuditTx(tx, {
			action: "frame.created",
			organizationId: input.organizationId,
			actor: { type: "user", userId: input.userId },
			resource: { type: "frame", id: frame.id },
			projectId: input.projectId,
			metadata: {
				sourceRunType: "REPORT_EXECUTION",
				sourceRunId: input.executionId,
				...(branding ? { brandSource: branding.source } : {}),
			},
		});
		return artifact;
	});
}
