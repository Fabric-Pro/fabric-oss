import { createHash } from "node:crypto";
import {
	type WorkspaceDocumentContentActor,
	WorkspaceDocumentContentError,
	type WorkspaceDocumentContentInput,
	type WorkspaceDocumentContentPage,
} from "@repo/database/src/workspace-document-content";
import {
	ContextReadError,
	type ProjectContextReadInput,
	type ProjectContextSnapshot,
} from "../context-quality/project-reader";
import {
	CONTEXT_SELECTION_MAX_PACKET_BYTES,
	CONTEXT_SELECTION_MAX_SOURCE_BYTES,
	ContextAssemblyError,
	type ContextAssemblyErrorCode,
	type ContextSelectionActor,
	type ContextSelectionReference,
	contextSelectionActorSchema,
	contextSelectionInputSchema,
	type SelectedContextPacket,
	type SelectedContextSource,
} from "./contracts";

export interface ContextAssemblyDependencies {
	authorizeProject: (actor: ContextSelectionActor) => Promise<void>;
	readProject: (
		input: ProjectContextReadInput,
	) => Promise<ProjectContextSnapshot>;
	readWorkspace: (
		actor: WorkspaceDocumentContentActor,
		input: WorkspaceDocumentContentInput,
	) => Promise<WorkspaceDocumentContentPage>;
}
const digest = (text: string) =>
	createHash("sha256").update(text, "utf8").digest("hex");
function mapped(error: unknown): ContextAssemblyError {
	if (error instanceof ContextAssemblyError) {
		return error;
	}
	if (
		error instanceof ContextReadError ||
		error instanceof WorkspaceDocumentContentError
	) {
		const code: ContextAssemblyErrorCode =
			error.code === "INVALID_SCOPE" ||
			error.code === "INVALID_REVISION" ||
			error.code === "REVISION_REQUIRED" ||
			error.code === "OUT_OF_RANGE"
				? "INVALID_INPUT"
				: error.code;
		return new ContextAssemblyError(code);
	}
	return new ContextAssemblyError("UNAVAILABLE");
}
function excerpt(text: string) {
	let content = "";
	let characters = 0;
	let bytes = 0;
	for (const point of text) {
		const size = Buffer.byteLength(point, "utf8");
		if (bytes + size > CONTEXT_SELECTION_MAX_SOURCE_BYTES) {
			break;
		}
		content += point;
		characters++;
		bytes += size;
	}
	return { content, characters, bytes };
}
function finish(packet: SelectedContextPacket): SelectedContextPacket {
	// Content and all metadata participate in the digest. Fixed construction order
	// plus parsed strict references make the effective packet deterministic.
	const { selectionHash: _hash, ...effective } = packet;
	packet.selectionHash = digest(JSON.stringify(effective));
	if (
		Buffer.byteLength(JSON.stringify(packet), "utf8") >
		CONTEXT_SELECTION_MAX_PACKET_BYTES
	) {
		throw new ContextAssemblyError("BUDGET_EXCEEDED");
	}
	return packet;
}
function pin(ref: ContextSelectionReference, revision: string) {
	// Inspection and reassembly with the resulting effective pin serialize identically.
	return ref.sourceKind === "project_context"
		? {
				sourceKind: ref.sourceKind,
				sourceId: ref.sourceId,
				expectedRevision: revision,
				required: ref.required,
			}
		: {
				sourceKind: ref.sourceKind,
				workspaceId: ref.workspaceId,
				documentId: ref.documentId,
				expectedRevision: revision,
				required: ref.required,
				offset: ref.offset,
			};
}
function validateIdentity(
	actor: ContextSelectionActor,
	ref: ContextSelectionReference,
	source: ProjectContextSnapshot | WorkspaceDocumentContentPage,
) {
	if (
		source.organizationId !== actor.organizationId ||
		!("revision" in source) ||
		!/^[a-f0-9]{64}$/.test(source.revision)
	) {
		throw new ContextAssemblyError("UNAVAILABLE");
	}
	if (ref.expectedRevision && ref.expectedRevision !== source.revision) {
		throw new ContextAssemblyError("STALE_REVISION");
	}
	if (ref.sourceKind === "project_context") {
		if (
			!("sourceId" in source) ||
			source.sourceId !== ref.sourceId ||
			source.projectId !== actor.projectId
		) {
			throw new ContextAssemblyError("UNAVAILABLE");
		}
	} else if (
		!("id" in source) ||
		source.id !== ref.documentId ||
		source.workspaceId !== ref.workspaceId ||
		source.offset !== ref.offset
	) {
		throw new ContextAssemblyError("UNAVAILABLE");
	}
}
/** Caller-only current-read packet. References and revisions never grant publication or historical access. */
export function createSelectedContextAssembler(
	dependencies: ContextAssemblyDependencies,
) {
	const authorize = async (actor: ContextSelectionActor) => {
		try {
			await dependencies.authorizeProject(actor);
		} catch (error) {
			throw mapped(error);
		}
	};
	const read = async (
		actor: ContextSelectionActor,
		ref: ContextSelectionReference,
	) => {
		const source =
			ref.sourceKind === "project_context"
				? await dependencies.readProject({
						...actor,
						sourceId: ref.sourceId,
						expectedRevision: ref.expectedRevision,
					})
				: await dependencies.readWorkspace(
						{
							userId: actor.userId,
							organizationId: actor.organizationId,
						},
						{
							workspaceId: ref.workspaceId,
							documentId: ref.documentId,
							expectedRevision: ref.expectedRevision,
							offset: ref.offset,
							limit: CONTEXT_SELECTION_MAX_SOURCE_BYTES,
						},
					);
		validateIdentity(actor, ref, source);
		const body = "content" in source ? source.content : source.text;
		// Existing Project reader promises a complete bounded body; enforce that exact identity here too.
		if ("content" in source && digest(body) !== source.revision) {
			throw new ContextAssemblyError("UNAVAILABLE");
		}
		const clipped = excerpt(body);
		const offset = ref.sourceKind === "workspace_document" ? ref.offset : 0;
		const totalCharacters =
			"content" in source
				? Array.from(body).length
				: source.totalCharacters;
		const totalNext = offset + clipped.characters;
		const sourceId =
			ref.sourceKind === "project_context"
				? ref.sourceId
				: ref.documentId;
		const href =
			ref.sourceKind === "project_context"
				? `/api/v1/projects/${encodeURIComponent(actor.projectId)}/context-quality/sources/${encodeURIComponent(sourceId)}`
				: `/api/v1/workspaces/${encodeURIComponent(ref.workspaceId)}/documents/${encodeURIComponent(sourceId)}/content`;
		// IDs are bounded at validation; keep the final encoded citation bounded too.
		if (href.length > 4096) {
			throw new ContextAssemblyError("UNAVAILABLE");
		}
		return {
			ref: pin(ref, source.revision),
			title: Array.from(
				"title" in source ? source.title : source.filename,
			)
				.slice(0, 240)
				.join(""),
			sourceRevision: source.revision,
			excerptHash: digest(clipped.content),
			content: clipped.content,
			byteLength: clipped.bytes,
			truncated: totalNext < totalCharacters,
			indexingExcluded:
				"indexingExcluded" in source ? source.indexingExcluded : false,
			contentRole: "reference_data" as const,
			readMode: "direct" as const,
			range: {
				offset,
				returnedCharacters: clipped.characters,
				nextOffset: totalNext < totalCharacters ? totalNext : null,
				offsetUnit: "unicode_code_points" as const,
			},
			citation: {
				href,
				sourceKind: ref.sourceKind,
				sourceId,
				revision: source.revision,
			},
		};
	};
	return async (
		rawActor: ContextSelectionActor,
		rawInput: unknown,
	): Promise<SelectedContextPacket> => {
		const actorResult = contextSelectionActorSchema.safeParse(rawActor);
		const inputResult = contextSelectionInputSchema.safeParse(rawInput);
		if (!actorResult.success || !inputResult.success) {
			throw new ContextAssemblyError("INVALID_INPUT");
		}
		const actor = actorResult.data;
		const input = inputResult.data;
		await authorize(actor);
		const packet: SelectedContextPacket = {
			version: 1,
			organizationId: actor.organizationId,
			projectId: actor.projectId,
			currentRead: true,
			snapshotConsistent: false,
			historicalVersionsAvailable: false,
			contentRole: "reference_data",
			selectionHash: "0".repeat(64),
			sources: [],
			omissions: [],
		};
		for (const [selectionIndex, ref] of input.selections.entries()) {
			let source: Omit<SelectedContextSource, "selectionIndex">;
			try {
				source = await read(actor, ref);
			} catch (error) {
				const refusal = mapped(error);
				if (ref.required || refusal.code === "UNAVAILABLE") {
					throw refusal;
				}
				packet.omissions.push({
					selectionIndex,
					ref,
					reason: "UNAVAILABLE",
				});
				continue;
			}
			packet.sources.push({ selectionIndex, ...source });
			try {
				finish(packet);
			} catch (error) {
				packet.sources.pop();
				if (ref.required) {
					throw error;
				}
				packet.omissions.push({
					selectionIndex,
					ref,
					reason: "BUDGET_EXCEEDED",
				});
			}
		}
		// Recheck accepted pins after all asynchronous source reads; no partial packet
		// escapes if an accepted optional source was revoked or changed in the meantime.
		for (const source of packet.sources) {
			try {
				const confirmed = await read(actor, source.ref);
				if (
					confirmed.excerptHash !== source.excerptHash ||
					JSON.stringify(confirmed.range) !==
						JSON.stringify(source.range)
				) {
					throw new ContextAssemblyError("STALE_REVISION");
				}
			} catch (error) {
				throw mapped(error);
			}
		}
		await authorize(actor);
		return finish(packet);
	};
}
