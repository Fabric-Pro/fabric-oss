import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import { logger } from "@repo/logs";
import { getSignedUrl } from "@repo/storage";
import { getTemporalClient } from "@repo/temporal";
import {
	PROPOSAL_EXPORT_FAILURE_CODES,
	PROPOSAL_EXPORT_FORMATS,
	PROPOSAL_EXPORT_ID_PATTERN,
	PROPOSAL_EXPORT_MEMO_KEY,
	PROPOSAL_EXPORT_RETENTION_MS,
	PROPOSAL_EXPORT_WARNING_CODES,
	PROPOSAL_EXPORT_WORKFLOW_TYPE,
	type ProposalExportFailureCode,
	type ProposalExportMemo,
	proposalExportProjectPrefix,
} from "@repo/temporal/proposal-export-types";
import { buildContentDisposition } from "@repo/utils/attachment";
import { z } from "zod";
import { withTimeout } from "../../../../lib/temporal-describe";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { loadProposalClientDocument } from "../../lib/proposal-artifact-access";

/** How long a download link lives. Minted again on every status read. */
export const PROPOSAL_EXPORT_URL_TTL_SECONDS = 5 * 60;

/** The longest one Temporal call of the status read may take. */
const TEMPORAL_CALL_TIMEOUT_MS = 5_000;

/** The status read's own failure code: the export is past its retention. */
const EXPORT_EXPIRED = "EXPORT_EXPIRED";

const memoSchema = z.object({
	userId: z.string(),
	organizationId: z.string(),
	projectId: z.string(),
	documentId: z.string(),
	format: z.enum(PROPOSAL_EXPORT_FORMATS),
}) satisfies z.ZodType<ProposalExportMemo>;

const warningsSchema = z
	.array(
		z.object({
			code: z.enum(PROPOSAL_EXPORT_WARNING_CODES),
			count: z.number().int().nonnegative(),
		}),
	)
	.max(PROPOSAL_EXPORT_WARNING_CODES.length);

const resultSchema = z.object({
	key: z.string(),
	fileName: z.string().min(1).max(255),
	contentType: z.string(),
	byteSize: z.number().int().nonnegative(),
	warnings: warningsSchema,
});

const statusSchema = z.discriminatedUnion("status", [
	z.object({ status: z.literal("RUNNING") }),
	z.object({
		status: z.literal("READY"),
		url: z.string(),
		expiresAt: z.string(),
		fileName: z.string(),
		warnings: warningsSchema,
	}),
	z.object({
		status: z.literal("FAILED"),
		code: z.enum([...PROPOSAL_EXPORT_FAILURE_CODES, EXPORT_EXPIRED]),
	}),
]);

type ProposalExportStatus = z.infer<typeof statusSchema>;

function exportNotFound(): ORPCError<"NOT_FOUND", unknown> {
	return new ORPCError("NOT_FOUND", { message: "Export not found" });
}

const FAILURE_CODES: ReadonlySet<string> = new Set(
	PROPOSAL_EXPORT_FAILURE_CODES,
);

/**
 * The export failure code down a failed workflow's cause chain (workflow
 * failure, then activity failure, then the activity's typed failure), or
 * `EXPORT_FAILED` when none carries one.
 */
function failureCodeOf(error: unknown): ProposalExportFailureCode {
	let current: unknown = error;
	for (let depth = 0; current && depth < 8; depth++) {
		const type = (current as { type?: unknown }).type;
		if (typeof type === "string" && FAILURE_CODES.has(type)) {
			return type as ProposalExportFailureCode;
		}
		current = (current as { cause?: unknown }).cause;
	}
	return "EXPORT_FAILED";
}

/**
 * The status of an export this caller started (Fizzy #2946): RUNNING, READY
 * with a freshly signed download link, or FAILED with a code.
 *
 * Every read checks again, in order: the id's shape (before Temporal is
 * asked anything, so the id cannot name another workflow), the workflow's
 * type, the memo's binding to this caller, project and an organization, and
 * then the gate, the document's place in the project and the caller's reach,
 * exactly as the theme does. Any failure, a missing workflow included, is
 * the same NOT_FOUND. The link lives minutes, carries an attachment
 * disposition, and is never stored: not in the workflow, not in a log.
 */
export const getProposalExportStatusProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.DOCUMENT_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/proposal-artifact/exports/{exportId}",
		tags: ["Projects", "Proposal artifact"],
		summary: "Get a Proposal export's status",
		description:
			"Returns whether an export you started is still running, ready with a short-lived download link, or failed.",
	})
	.input(z.object({ projectId: z.string(), exportId: z.string() }))
	.output(statusSchema)
	.handler(async ({ input, context }): Promise<ProposalExportStatus> => {
		if (!PROPOSAL_EXPORT_ID_PATTERN.test(input.exportId)) {
			throw exportNotFound();
		}

		const client = await getTemporalClient();
		const handle = client.workflow.getHandle(input.exportId);
		let description: Awaited<ReturnType<typeof handle.describe>>;
		try {
			description = await withTimeout(
				handle.describe(),
				TEMPORAL_CALL_TIMEOUT_MS,
			);
		} catch (error) {
			if (
				error instanceof Error &&
				error.name === "WorkflowNotFoundError"
			) {
				throw exportNotFound();
			}
			throw error;
		}
		if (description.type !== PROPOSAL_EXPORT_WORKFLOW_TYPE) {
			throw exportNotFound();
		}
		const memo = memoSchema.safeParse(
			description.memo?.[PROPOSAL_EXPORT_MEMO_KEY],
		);
		if (
			!memo.success ||
			memo.data.userId !== context.user.id ||
			memo.data.projectId !== input.projectId
		) {
			throw exportNotFound();
		}

		const { organizationId } = await loadProposalClientDocument({
			projectId: input.projectId,
			documentId: memo.data.documentId,
			userId: context.user.id,
		});
		if (organizationId !== memo.data.organizationId) {
			throw exportNotFound();
		}

		switch (description.status.name) {
			case "RUNNING":
				return { status: "RUNNING" };
			case "COMPLETED":
				break;
			case "TIMED_OUT":
				return { status: "FAILED", code: "EXPORT_TIMED_OUT" };
			case "FAILED": {
				try {
					await withTimeout(
						handle.result(),
						TEMPORAL_CALL_TIMEOUT_MS,
					);
				} catch (error) {
					return { status: "FAILED", code: failureCodeOf(error) };
				}
				return { status: "FAILED", code: "EXPORT_FAILED" };
			}
			default:
				return { status: "FAILED", code: "EXPORT_FAILED" };
		}

		const closedAt = description.closeTime?.getTime() ?? Date.now();
		if (Date.now() - closedAt > PROPOSAL_EXPORT_RETENTION_MS) {
			return { status: "FAILED", code: EXPORT_EXPIRED };
		}

		const result = resultSchema.safeParse(
			await withTimeout(handle.result(), TEMPORAL_CALL_TIMEOUT_MS),
		);
		if (
			!result.success ||
			!result.data.key.startsWith(
				proposalExportProjectPrefix(input.projectId),
			)
		) {
			logger.error(
				{
					event: "proposal_export.result_invalid",
					projectId: input.projectId,
					exportId: input.exportId,
				},
				"A finished Proposal export returned an unusable result",
			);
			return { status: "FAILED", code: "EXPORT_FAILED" };
		}

		const url = await getSignedUrl(result.data.key, {
			bucket: config.storage.bucketNames.projectContexts,
			expiresIn: PROPOSAL_EXPORT_URL_TTL_SECONDS,
			responseContentDisposition: buildContentDisposition(
				result.data.fileName,
			),
			responseContentType: result.data.contentType,
		});
		return {
			status: "READY",
			url,
			expiresAt: new Date(
				Date.now() + PROPOSAL_EXPORT_URL_TTL_SECONDS * 1000,
			).toISOString(),
			fileName: result.data.fileName,
			warnings: result.data.warnings,
		};
	});
