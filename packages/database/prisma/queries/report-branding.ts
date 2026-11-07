import { artifactBrandSelectionSchema } from "@repo/utils/artifact-brand-snapshot";
import { z } from "zod";
import { db, type Prisma } from "../client";
import {
	ArtifactBrandingError,
	getArtifactBrandingChoices,
	lockArtifactBrandSelection,
} from "./artifact-branding";
import { recordAuditTx } from "./audit-log";
import { canAccessReportInstance } from "./lib/report-access";
import {
	assertReportBrandingOutputFormat,
	readReportEvidenceConfig,
} from "./lib/report-evidence";
import { ReportInstanceConflictError, updateTemplateInstance } from "./reports";

export const reportInstanceBrandingUpdateSchema = z.strictObject({
	expectedInstanceVersion: z.number().int().positive(),
	expectedUpdatedAt: z.iso.datetime({ offset: true }),
	branding: artifactBrandSelectionSchema.nullable(),
});
export type ReportInstanceBrandingUpdate = z.infer<
	typeof reportInstanceBrandingUpdateSchema
>;
export class ReportBrandingCommandError extends Error {
	constructor(
		readonly code: "NOT_FOUND" | "FORBIDDEN" | "BAD_REQUEST" | "CONFLICT",
		message: string,
	) {
		super(message);
		this.name = "ReportBrandingCommandError";
	}
}
interface Actor {
	userId: string;
	organizationId: string;
	boundProjectId?: string;
}
async function load(
	actor: Actor,
	id: string,
	client: Prisma.TransactionClient = db,
	write = false,
) {
	const row = await client.templateInstance.findFirst({
		where: {
			id,
			organizationId: actor.organizationId,
		},
		include: { template: { select: { outputFormat: true } } },
	});
	if (
		!row ||
		(actor.boundProjectId &&
			readReportEvidenceConfig(row.fabricConfig)?.projectId !==
				actor.boundProjectId) ||
		!(await canAccessReportInstance(row, actor, undefined, write))
	) {
		throw new ReportBrandingCommandError(
			"NOT_FOUND",
			"Report not found or access denied.",
		);
	}
	return row;
}
/** Read version tokens from the same report audience; callers cannot supply a different project. */
export async function getReportInstanceBranding(actor: Actor, id: string) {
	const row = await load(actor, id);
	const reporting = readReportEvidenceConfig(row.fabricConfig);
	const choices = await getArtifactBrandingChoices({
		...actor,
		projectId: reporting?.projectId,
	});
	let supported = true;
	try {
		assertReportBrandingOutputFormat(row.template.outputFormat);
	} catch {
		supported = false;
	}
	return {
		...choices,
		instanceId: row.id,
		instanceVersion: row.version,
		updatedAt: row.updatedAt.toISOString(),
		projectId: reporting?.projectId ?? null,
		current: reporting?.branding ?? null,
		canApply:
			!!reporting &&
			supported &&
			(await canAccessReportInstance(row, actor, undefined, true)),
	};
}
/** Change only reviewed branding. Existing period, audience, scheduling and generator settings are retained. */
export async function applyReportInstanceBranding(
	actor: Actor,
	id: string,
	input: ReportInstanceBrandingUpdate,
) {
	const parsed = reportInstanceBrandingUpdateSchema.parse(input);
	try {
		return await db.$transaction(async (tx) => {
			// Follow the canonical writer's lock order: selected brand, then instance.
			// Re-read both authority and CAS after the instance lock. A queued brand
			// writer must never be blocked by a row this operation already holds.
			const initial = await load(actor, id, tx, true);
			const initialReporting = readReportEvidenceConfig(
				initial.fabricConfig,
			);
			if (parsed.branding && initialReporting) {
				await lockArtifactBrandSelection(
					{
						...actor,
						projectId: initialReporting.projectId,
						...parsed.branding,
					},
					tx,
				);
			}
			// Row locking also serializes this operation with ordinary report UPDATEs.
			await tx.$queryRaw`SELECT id FROM template_instance WHERE id = ${id} AND "organizationId" = ${actor.organizationId} FOR UPDATE`;
			const row = await load(actor, id, tx, true);
			if (
				row.version !== parsed.expectedInstanceVersion ||
				row.updatedAt.getTime() !==
					new Date(parsed.expectedUpdatedAt).getTime()
			) {
				throw new ReportInstanceConflictError();
			}
			const reporting = readReportEvidenceConfig(row.fabricConfig);
			if (!reporting) {
				throw new ReportBrandingCommandError(
					"BAD_REQUEST",
					"Configure the report period and audience before selecting branding.",
				);
			}
			if (parsed.branding) {
				try {
					assertReportBrandingOutputFormat(row.template.outputFormat);
				} catch {
					throw new ReportBrandingCommandError(
						"BAD_REQUEST",
						"Choose a document report format (Markdown, HTML, PDF or multi-format) to apply branding.",
					);
				}
			}

			const { branding: _old, ...unchanged } = reporting;
			const updated = await updateTemplateInstance(
				{
					id,
					expectedVersion: parsed.expectedInstanceVersion,
					expectedUpdatedAt: new Date(parsed.expectedUpdatedAt),
					fabricConfig: {
						...(row.fabricConfig as Prisma.InputJsonObject),
						reporting: {
							...unchanged,
							...(parsed.branding
								? { branding: parsed.branding }
								: {}),
						},
					},
				},
				tx,
			);
			await recordAuditTx(tx, {
				action: "org.settings.updated",
				organizationId: actor.organizationId,
				actor: { type: "user", userId: actor.userId },
				resource: { type: "report_instance", id },
				projectId: reporting.projectId,
				metadata: {
					operation: "report.branding.updated",
					instanceVersion: row.version,
					brandSource: parsed.branding?.source ?? null,
					brandVersion: parsed.branding?.expectedBrandVersion ?? null,
				},
			});
			return {
				instanceId: updated.id,
				instanceVersion: updated.version,
				updatedAt: updated.updatedAt.toISOString(),
				projectId: reporting.projectId ?? null,
				branding: parsed.branding,
			};
		});
	} catch (error) {
		if (error instanceof ReportInstanceConflictError) {
			throw new ReportBrandingCommandError("CONFLICT", error.message);
		}
		if (error instanceof ArtifactBrandingError) {
			throw new ReportBrandingCommandError(
				error.code === "NOT_FOUND" ? "NOT_FOUND" : "CONFLICT",
				error.message,
			);
		}
		throw error;
	}
}
