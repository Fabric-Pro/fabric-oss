import { z } from "zod";

export const CONTEXT_SELECTION_MAX_SOURCES = 12;
export const CONTEXT_SELECTION_MAX_SOURCE_BYTES = 16 * 1024;
export const CONTEXT_SELECTION_MAX_PACKET_BYTES = 96 * 1024;
const id = z.string().trim().min(1).max(128);
const documentId = z.string().trim().min(1).max(200);
const revision = z.string().regex(/^[a-f0-9]{64}$/);
export const contextSelectionActorSchema = z.strictObject({
	userId: id,
	organizationId: id,
	projectId: id,
});
const shared = {
	expectedRevision: revision.optional(),
	required: z.boolean().default(true),
};
export const contextSelectionSourceSchema = z.discriminatedUnion("sourceKind", [
	z.strictObject({
		sourceKind: z.literal("project_context"),
		sourceId: id,
		...shared,
	}),
	z.strictObject({
		sourceKind: z.literal("workspace_document"),
		workspaceId: documentId,
		documentId,
		...shared,
		offset: z.number().int().min(0).max(2147483646).default(0),
	}),
]);
export const contextSelectionInputSchema = z
	.strictObject({
		selections: z
			.array(contextSelectionSourceSchema)
			.min(1)
			.max(CONTEXT_SELECTION_MAX_SOURCES),
	})
	.superRefine((input, ctx) => {
		const seen = new Set<string>();
		for (const [index, ref] of input.selections.entries()) {
			const key =
				ref.sourceKind === "project_context"
					? JSON.stringify([ref.sourceKind, ref.sourceId])
					: JSON.stringify([
							ref.sourceKind,
							ref.workspaceId,
							ref.documentId,
						]);
			if (seen.has(key)) {
				ctx.addIssue({
					code: "custom",
					path: ["selections", index],
					message: "Select each source once.",
				});
			}
			seen.add(key);
			if (
				ref.sourceKind === "workspace_document" &&
				ref.offset > 0 &&
				!ref.expectedRevision
			) {
				ctx.addIssue({
					code: "custom",
					path: ["selections", index, "expectedRevision"],
					message:
						"Continuation requires the current source revision.",
				});
			}
		}
	});
export type ContextSelectionActor = z.infer<typeof contextSelectionActorSchema>;
export type ContextSelectionInput = z.input<typeof contextSelectionInputSchema>;
export type ContextSelectionReference = z.output<
	typeof contextSelectionSourceSchema
>;
export type EffectiveContextReference =
	| (Omit<
			Extract<
				ContextSelectionReference,
				{ sourceKind: "project_context" }
			>,
			"expectedRevision"
	  > & { expectedRevision: string })
	| (Omit<
			Extract<
				ContextSelectionReference,
				{ sourceKind: "workspace_document" }
			>,
			"expectedRevision"
	  > & { expectedRevision: string });
export interface SelectedContextSource {
	selectionIndex: number;
	ref: EffectiveContextReference;
	title: string;
	sourceRevision: string;
	excerptHash: string;
	content: string;
	byteLength: number;
	truncated: boolean;
	indexingExcluded: boolean;
	contentRole: "reference_data";
	readMode: "direct";
	range: {
		offset: number;
		returnedCharacters: number;
		nextOffset: number | null;
		offsetUnit: "unicode_code_points";
	};
	citation: {
		href: string;
		sourceKind: "project_context" | "workspace_document";
		sourceId: string;
		revision: string;
	};
}
export interface SelectedContextOmission {
	selectionIndex: number;
	ref: ContextSelectionReference;
	reason: "UNAVAILABLE" | "BUDGET_EXCEEDED";
}
export interface SelectedContextPacket {
	version: 1;
	organizationId: string;
	projectId: string;
	currentRead: true;
	snapshotConsistent: false;
	historicalVersionsAvailable: false;
	contentRole: "reference_data";
	selectionHash: string;
	sources: SelectedContextSource[];
	omissions: SelectedContextOmission[];
}
export type ContextAssemblyErrorCode =
	| "INVALID_INPUT"
	| "NOT_FOUND"
	| "FORBIDDEN"
	| "NOT_READY"
	| "STALE_REVISION"
	| "TOO_LARGE"
	| "BUDGET_EXCEEDED"
	| "UNAVAILABLE";
const errors: Record<
	ContextAssemblyErrorCode,
	{ status: 400 | 403 | 404 | 409 | 413 | 503; message: string }
> = {
	INVALID_INPUT: {
		status: 400,
		message:
			"Select valid distinct sources, current revisions and bounded ranges in one project.",
	},
	NOT_FOUND: {
		status: 404,
		message: "Selected context not found or access denied.",
	},
	FORBIDDEN: {
		status: 403,
		message: "Current permission to read selected context is required.",
	},
	NOT_READY: {
		status: 409,
		message:
			"Required context is not ready. Inspect its current processing state.",
	},
	STALE_REVISION: {
		status: 409,
		message:
			"Selected context changed. Inspect and select its current revision again.",
	},
	TOO_LARGE: {
		status: 413,
		message:
			"Required context exceeds the supported direct-read size. Choose another source.",
	},
	BUDGET_EXCEEDED: {
		status: 413,
		message:
			"Selected context exceeds the packet size budget. Select fewer or smaller excerpts.",
	},
	UNAVAILABLE: {
		status: 503,
		message:
			"Selected context could not be read. Retry this selection when its sources are available.",
	},
};
export class ContextAssemblyError extends Error {
	readonly status: 400 | 403 | 404 | 409 | 413 | 503;
	constructor(readonly code: ContextAssemblyErrorCode) {
		super(errors[code].message);
		this.name = "ContextAssemblyError";
		this.status = errors[code].status;
	}
}
