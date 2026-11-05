import { createHash } from "node:crypto";
import {
	canReadOrganizationFrames,
	getAccessibleFrameById,
	getUserById,
	recordAuditDurable,
} from "@repo/database";
import { getSignedUrl } from "@repo/storage";
import { getTemporalClient } from "@repo/temporal/client";
import {
	FRAME_EXPORT_DOWNLOAD_SECONDS,
	FRAME_EXPORT_MAX_BYTES,
	FRAME_EXPORT_QUERY,
	FRAME_EXPORT_TTL_MS,
	type FrameExportState,
} from "@repo/temporal/frame-export-contract";
import { z } from "zod";
import { withCorrelationMemo } from "../../../lib/temporal-correlation";

export interface FrameExportActor {
	userId: string;
	organizationId: string;
	userEmail?: string;
}
export class FrameExportError extends Error {
	constructor(
		public readonly status: number,
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "FrameExportError";
	}
}
const identity = z.strictObject({
	frameId: z.string().min(1).max(200),
	exportId: z.string().min(1).max(200),
});
export const startFrameExportSchema = z.strictObject({
	frameId: z.string().min(1).max(200),
	expectedUpdatedAt: z.string().datetime({ offset: true }),
	orientation: z.enum(["portrait", "landscape"]).default("portrait"),
	requestId: z.uuid().transform((value) => value.toLowerCase()),
});
interface Admission {
	frameId: string;
	userId: string;
	organizationId: string;
	expectedUpdatedAt: string;
	orientation: string;
	requestHash: string;
	objectKey: string;
	expiresAt: string;
}
function hash(value: unknown) {
	return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function exportId(actor: FrameExportActor, requestId: string) {
	return `frame-export-v2-${hash([actor.organizationId, actor.userId]).slice(0, 32)}-${requestId}`;
}
function unavailable(): never {
	throw new FrameExportError(
		503,
		"UNAVAILABLE",
		"Export could not be confirmed. Retry using the same export request.",
	);
}
function absent(): never {
	throw new FrameExportError(
		404,
		"NOT_FOUND",
		"Export not found or access denied.",
	);
}
async function access(actor: FrameExportActor, frameId: string) {
	if (
		!actor.organizationId ||
		!actor.userId ||
		!(await canReadOrganizationFrames(actor.userId, actor.organizationId))
	) {
		absent();
	}
	const userEmail =
		actor.userEmail ?? (await getUserById(actor.userId))?.email;
	const frame = await getAccessibleFrameById({
		id: frameId,
		...actor,
		userEmail,
	});
	if (!frame) {
		absent();
	}
	return frame;
}
async function resolve(
	actor: FrameExportActor,
	input: { frameId: string; exportId: string },
) {
	if (!identity.safeParse(input).success) {
		throw new FrameExportError(
			400,
			"BAD_REQUEST",
			"Provide a valid page and export identity.",
		);
	}
	const frame = await access(actor, input.frameId);
	const suffix = input.exportId.slice(-36);
	if (
		!z.uuid().safeParse(suffix).success ||
		input.exportId !== exportId(actor, suffix)
	) {
		absent();
	}
	const client = await getTemporalClient();
	const handle = client.workflow.getHandle(input.exportId);
	let description;
	try {
		description = await handle.describe();
	} catch (error) {
		if (error instanceof Error && error.name === "WorkflowNotFoundError") {
			absent();
		}
		unavailable();
	}
	const memo = description.memo?.fabricFrameExport as Admission | undefined;
	if (
		!memo ||
		memo.frameId !== input.frameId ||
		memo.userId !== actor.userId ||
		memo.organizationId !== actor.organizationId ||
		description.type !== "exportFrameToPDF"
	) {
		absent();
	}
	return { frame, handle, description, memo };
}
function publicState(id: string, memo: Admission, state: FrameExportState) {
	return {
		exportId: id,
		status: state.status,
		expectedUpdatedAt: memo.expectedUpdatedAt,
		expiresAt: memo.expiresAt,
		...(state.status === "failed"
			? { error: "Export failed. Review the page and try a new export." }
			: {}),
	};
}
async function observed(
	resolved: Awaited<ReturnType<typeof resolve>>,
): Promise<FrameExportState> {
	if (Date.parse(resolved.memo.expiresAt) <= Date.now()) {
		return { status: "expired" };
	}
	const native = resolved.description.status.name;
	if (native === "CANCELLED" || native === "TERMINATED") {
		return { status: "cancelled" };
	}
	if (native === "FAILED" || native === "TIMED_OUT") {
		return { status: "failed" };
	}
	if (native === "COMPLETED") {
		return { status: "expired" };
	}
	try {
		const state =
			await resolved.handle.query<FrameExportState>(FRAME_EXPORT_QUERY);
		if (
			!state ||
			![
				"pending",
				"running",
				"completed",
				"failed",
				"cancelled",
				"expired",
			].includes(state.status)
		) {
			unavailable();
		}
		return state;
	} catch (error) {
		if (
			error instanceof Error &&
			error.name === "QueryNotRegisteredError"
		) {
			return { status: "pending" };
		}
		unavailable();
	}
}
export async function startFrameExport(
	actor: FrameExportActor,
	raw: z.input<typeof startFrameExportSchema>,
) {
	const parsed = startFrameExportSchema.safeParse(raw);
	if (!parsed.success) {
		throw new FrameExportError(
			400,
			"BAD_REQUEST",
			"Provide the reviewed revision, orientation and a unique request ID.",
		);
	}
	const input = parsed.data;
	const frame = await access(actor, input.frameId);
	const expectedUpdatedAt = new Date(input.expectedUpdatedAt).toISOString();
	if (frame.updatedAt.toISOString() !== expectedUpdatedAt) {
		throw new FrameExportError(
			409,
			"CONFLICT",
			"The page changed. Review it again before exporting.",
		);
	}
	if (
		Buffer.byteLength(JSON.stringify(frame.document), "utf8") >
		FRAME_EXPORT_MAX_BYTES
	) {
		throw new FrameExportError(
			400,
			"BAD_REQUEST",
			"This page is too large to export. Reduce its content first.",
		);
	}
	const id = exportId(actor, input.requestId);
	const requestHash = hash([
		input.frameId,
		expectedUpdatedAt,
		input.orientation,
	]);
	const memo: Admission = {
		frameId: input.frameId,
		userId: actor.userId,
		organizationId: actor.organizationId,
		expectedUpdatedAt,
		orientation: input.orientation,
		requestHash,
		objectKey: `exports/frames-managed/${hash(actor.organizationId).slice(0, 32)}/${id}.pdf`,
		expiresAt: new Date(Date.now() + FRAME_EXPORT_TTL_MS).toISOString(),
	};
	// Persist intent before dispatch. A lost acknowledgement is resolved by this identity,
	// never by generating a fresh business workflow automatically.
	await recordAuditDurable({
		action: "frame.export_started",
		organizationId: actor.organizationId,
		actor: { type: "user", userId: actor.userId },
		resource: { type: "frame", id: input.frameId },
		projectId: frame.projectId,
		metadata: {
			exportId: id,
			revision: expectedUpdatedAt,
			phase: "requested",
		},
	});
	try {
		const client = await getTemporalClient();
		await client.workflow.start(
			"exportFrameToPDF",
			withCorrelationMemo({
				workflowId: id,
				taskQueue: "fabric-worker",
				workflowExecutionTimeout: "26 hours",
				workflowIdReusePolicy: "REJECT_DUPLICATE",
				memo: { fabricFrameExport: memo },
				args: [
					{
						frameId: input.frameId,
						userId: actor.userId,
						organizationId: actor.organizationId,
						expectedUpdatedAt,
						orientation: input.orientation,
						managedExport: {
							objectKey: memo.objectKey,
							expiresAt: memo.expiresAt,
						},
					},
				],
			}),
		);
	} catch (error) {
		if (
			!(
				error instanceof Error &&
				error.name === "WorkflowExecutionAlreadyStartedError"
			)
		) {
			unavailable();
		}
	}
	const resolved = await resolve(actor, {
		frameId: input.frameId,
		exportId: id,
	});
	if (resolved.memo.requestHash !== requestHash) {
		throw new FrameExportError(
			409,
			"CONFLICT",
			"This request ID belongs to a different export. Use a new request ID.",
		);
	}
	// Initial workflow task may not yet have registered its query handler.
	return publicState(id, resolved.memo, { status: "pending" });
}
export async function getFrameExport(
	actor: FrameExportActor,
	input: { frameId: string; exportId: string },
) {
	const r = await resolve(actor, input);
	return publicState(input.exportId, r.memo, await observed(r));
}
export async function cancelFrameExport(
	actor: FrameExportActor,
	input: { frameId: string; exportId: string },
) {
	const r = await resolve(actor, input);
	const state = await observed(r);
	if (["cancelled", "expired", "failed"].includes(state.status)) {
		return publicState(input.exportId, r.memo, state);
	}
	await recordAuditDurable({
		action: "frame.export_cancelled",
		organizationId: actor.organizationId,
		actor: { type: "user", userId: actor.userId },
		resource: { type: "frame", id: input.frameId },
		projectId: r.frame.projectId,
		metadata: { exportId: input.exportId, phase: "requested" },
	});
	try {
		await r.handle.cancel();
	} catch {
		unavailable();
	}
	return getFrameExport(actor, input);
}
export async function downloadFrameExport(
	actor: FrameExportActor,
	input: { frameId: string; exportId: string },
) {
	const r = await resolve(actor, input);
	const state = await observed(r);
	if (state.status !== "completed") {
		throw new FrameExportError(
			409,
			"NOT_READY",
			"This export is not ready or has expired.",
		);
	}
	if (r.frame.updatedAt.toISOString() !== r.memo.expectedUpdatedAt) {
		throw new FrameExportError(
			409,
			"CONFLICT",
			"The page changed. Create an export of the latest revision.",
		);
	}
	if (state.storageKey !== r.memo.objectKey) {
		absent();
	}
	await recordAuditDurable({
		action: "frame.export_downloaded",
		organizationId: actor.organizationId,
		actor: { type: "user", userId: actor.userId },
		resource: { type: "frame", id: input.frameId },
		projectId: r.frame.projectId,
		metadata: {
			exportId: input.exportId,
			revision: r.memo.expectedUpdatedAt,
		},
	});
	const seconds = Math.min(
		FRAME_EXPORT_DOWNLOAD_SECONDS,
		Math.floor((Date.parse(r.memo.expiresAt) - Date.now()) / 1000),
	);
	if (seconds < 1) {
		throw new FrameExportError(
			409,
			"NOT_READY",
			"This export has expired.",
		);
	}
	const url = await getSignedUrl(r.memo.objectKey, {
		bucket: process.env.S3_BUCKET || "fabric-exports",
		expiresIn: seconds,
		responseContentType: "application/pdf",
		responseContentDisposition: 'attachment; filename="fabric-page.pdf"',
	});
	return {
		url,
		expiresAt: new Date(Date.now() + seconds * 1000).toISOString(),
	};
}
