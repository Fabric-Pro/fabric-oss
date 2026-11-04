import type { Prisma } from "@repo/database";
import type {
	WorkspaceDocumentContentInput,
	WorkspaceDocumentContentPage,
} from "@repo/database/src/workspace-document-content";
import { WorkspaceDocumentContentError } from "@repo/database/src/workspace-document-content";
import type { z } from "zod";
import {
	addWorkspaceLinkSchema,
	readWorkspaceLinkSchema,
	type WorkspaceLinkActor,
	WorkspaceLinkError,
	type WorkspaceLinkRecord,
	type WorkspaceLinkView,
	workspaceLinkActorSchema,
	workspaceLinkIdSchema,
	workspaceLinkPageSchema,
} from "./contracts";

export interface LinkedDocumentMetadata {
	id: string;
	workspaceId: string;
	organizationId: string | null;
	filename: string;
	workspaceName: string;
	status: string;
	revision: string | null;
	updatedAt: Date;
}
export interface WorkspaceLinkDependencies {
	authorizeProject(
		actor: WorkspaceLinkActor,
		operation: "read" | "link" | "unlink",
		client?: Prisma.TransactionClient,
	): Promise<void>;
	authorizeWorkspace(
		actor: WorkspaceLinkActor,
		workspaceId: string,
		client?: Prisma.TransactionClient,
	): Promise<void>;
	documents(
		actor: WorkspaceLinkActor,
		ids: string[],
		client?: Prisma.TransactionClient,
	): Promise<LinkedDocumentMetadata[]>;
	list(
		actor: WorkspaceLinkActor,
		page: { limit: number; offset: number },
	): Promise<WorkspaceLinkRecord[]>;
	get(
		actor: WorkspaceLinkActor,
		linkId: string,
	): Promise<WorkspaceLinkRecord | null>;
	read(
		actor: WorkspaceLinkActor,
		input: WorkspaceDocumentContentInput,
		client?: Prisma.TransactionClient,
	): Promise<WorkspaceDocumentContentPage>;
	add(
		actor: WorkspaceLinkActor,
		input: z.output<typeof addWorkspaceLinkSchema>,
		validate: (client: Prisma.TransactionClient) => Promise<void>,
		via: "user" | "api_key" | "agent",
	): Promise<{ linkId: string; created: boolean }>;
	remove(
		actor: WorkspaceLinkActor,
		linkId: string,
		validate: (client: Prisma.TransactionClient) => Promise<void>,
		via: "user" | "api_key" | "agent",
	): Promise<{ removed: boolean }>;
}
function parse<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
	const parsed = schema.safeParse(value);
	if (!parsed.success) {
		throw new WorkspaceLinkError("INVALID_INPUT");
	}
	return parsed.data;
}
function safeError(error: unknown): never {
	if (error instanceof WorkspaceLinkError) {
		throw error;
	}
	if (error instanceof WorkspaceDocumentContentError) {
		if (
			error.code === "FORBIDDEN" ||
			error.code === "NOT_FOUND" ||
			error.code === "NOT_READY" ||
			error.code === "STALE_REVISION"
		) {
			throw new WorkspaceLinkError(error.code);
		}
		throw new WorkspaceLinkError("INVALID_INPUT");
	}
	throw new WorkspaceLinkError("UNAVAILABLE");
}
function unavailable(link: WorkspaceLinkRecord): WorkspaceLinkView {
	return {
		id: link.id,
		availability: "UNAVAILABLE",
		sourceKind: "workspace_document",
		contentRole: "reference_data",
		sharingGranted: false,
		indexedForProject: false,
	};
}
function knownDenied(error: unknown) {
	return (
		(error instanceof WorkspaceDocumentContentError ||
			error instanceof WorkspaceLinkError) &&
		["NOT_FOUND", "FORBIDDEN"].includes(error.code)
	);
}
/** One current-access contract used by Portal, API, CLI and MCP. No document copies or sharing grants. */
export function createWorkspaceDocumentLinkCommands(
	deps: WorkspaceLinkDependencies,
) {
	async function validateSource(
		actor: WorkspaceLinkActor,
		input: z.output<typeof addWorkspaceLinkSchema>,
		client?: Prisma.TransactionClient,
	) {
		await deps.authorizeProject(actor, "link", client);
		const docs = await deps.documents(actor, [input.documentId], client);
		const doc = docs[0];
		if (
			!doc ||
			doc.organizationId !== actor.organizationId ||
			doc.workspaceId !== input.workspaceId
		) {
			throw new WorkspaceLinkError("NOT_FOUND");
		}
		await deps.authorizeWorkspace(actor, doc.workspaceId, client);
		await deps.read(
			actor,
			{
				workspaceId: doc.workspaceId,
				documentId: doc.id,
				expectedRevision: input.expectedRevision,
				limit: 1,
				offset: 0,
			},
			client,
		);
	}
	return {
		async list(rawActor: WorkspaceLinkActor, raw: unknown = {}) {
			try {
				const actor = parse(workspaceLinkActorSchema, rawActor);
				const page = parse(workspaceLinkPageSchema, raw);
				await deps.authorizeProject(actor, "read");
				const rows = await deps.list(actor, {
					...page,
					limit: page.limit + 1,
				});
				const visibleRows = rows.slice(0, page.limit);
				const docs = await deps.documents(
					actor,
					visibleRows.map((row) => row.documentId),
				);
				const byId = new Map(docs.map((doc) => [doc.id, doc]));
				const allowedWorkspaces = new Set<string>();
				const deniedWorkspaces = new Set<string>();
				const links: WorkspaceLinkView[] = [];
				for (const row of visibleRows) {
					const doc = byId.get(row.documentId);
					if (!doc || doc.organizationId !== actor.organizationId) {
						links.push(unavailable(row));
						continue;
					}
					if (
						!allowedWorkspaces.has(doc.workspaceId) &&
						!deniedWorkspaces.has(doc.workspaceId)
					) {
						try {
							await deps.authorizeWorkspace(
								actor,
								doc.workspaceId,
							);
							allowedWorkspaces.add(doc.workspaceId);
						} catch (error) {
							if (!knownDenied(error)) {
								throw error;
							}
							deniedWorkspaces.add(doc.workspaceId);
						}
					}
					if (deniedWorkspaces.has(doc.workspaceId)) {
						links.push(unavailable(row));
						continue;
					}
					links.push({
						id: row.id,
						sourceKind: "workspace_document",
						contentRole: "reference_data",
						sharingGranted: false,
						indexedForProject: false,
						availability:
							doc.status === "READY" && doc.revision
								? doc.revision === row.sourceRevisionAtLink
									? "CURRENT"
									: "UPDATED"
								: doc.status === "FAILED" ||
										doc.status === "READY"
									? "NEEDS_ATTENTION"
									: "PROCESSING",
						documentId: doc.id,
						workspaceId: doc.workspaceId,
						filename: Array.from(doc.filename)
							.slice(0, 240)
							.join(""),
						workspaceName: Array.from(doc.workspaceName)
							.slice(0, 240)
							.join(""),
						...(doc.status === "READY" && doc.revision
							? { sourceRevision: doc.revision }
							: {}),
						sourceRevisionAtLink: row.sourceRevisionAtLink,
						sourceUpdatedAt: doc.updatedAt.toISOString(),
						addedAt: row.createdAt.toISOString(),
					});
				}
				// Permission revocation while later sources load invalidates all metadata; never return stale grants.
				for (const workspaceId of allowedWorkspaces) {
					await deps.authorizeWorkspace(actor, workspaceId);
				}
				let canAdd = false;
				let canRemove = false;
				try {
					await deps.authorizeProject(actor, "link");
					canAdd = true;
				} catch (error) {
					if (
						!(error instanceof WorkspaceLinkError) ||
						!["FORBIDDEN", "NOT_FOUND"].includes(error.code)
					) {
						throw error;
					}
				}
				try {
					await deps.authorizeProject(actor, "unlink");
					canRemove = true;
				} catch (error) {
					if (
						!(error instanceof WorkspaceLinkError) ||
						!["FORBIDDEN", "NOT_FOUND"].includes(error.code)
					) {
						throw error;
					}
				}
				await deps.authorizeProject(actor, "read");

				const finalDocs = new Map(
					(
						await deps.documents(
							actor,
							visibleRows.map((row) => row.documentId),
						)
					).map((doc) => [doc.id, doc]),
				);
				for (const link of links) {
					if (link.availability === "UNAVAILABLE") {
						continue;
					}
					const final = finalDocs.get(link.documentId ?? "");
					const observed = byId.get(link.documentId ?? "");
					if (
						!final ||
						!observed ||
						final.organizationId !== actor.organizationId ||
						final.workspaceId !== observed.workspaceId ||
						final.revision !== observed.revision ||
						final.status !== observed.status ||
						final.filename !== observed.filename ||
						final.workspaceName !== observed.workspaceName
					) {
						throw new WorkspaceLinkError("STALE_REVISION");
					}
				}

				return {
					permissions: { canAdd, canRemove },
					links,
					hasMore: rows.length > page.limit,
					nextOffset:
						rows.length > page.limit
							? page.offset + page.limit
							: null,
					currentRead: true as const,
					snapshotConsistent: false as const,
				};
			} catch (error) {
				safeError(error);
			}
		},
		async add(
			rawActor: WorkspaceLinkActor,
			raw: unknown,
			via: "user" | "api_key" | "agent" = "user",
		) {
			try {
				const actor = parse(workspaceLinkActorSchema, rawActor);
				const input = parse(addWorkspaceLinkSchema, raw);
				await validateSource(actor, input);
				return await deps.add(
					actor,
					input,
					(client) => validateSource(actor, input, client),
					via,
				);
			} catch (error) {
				safeError(error);
			}
		},
		async remove(
			rawActor: WorkspaceLinkActor,
			raw: unknown,
			via: "user" | "api_key" | "agent" = "user",
		) {
			try {
				const actor = parse(workspaceLinkActorSchema, rawActor);
				const input = parse(workspaceLinkIdSchema, raw);
				await deps.authorizeProject(actor, "unlink");
				return await deps.remove(
					actor,
					input.linkId,
					(client) => deps.authorizeProject(actor, "unlink", client),
					via,
				);
			} catch (error) {
				safeError(error);
			}
		},
		async read(rawActor: WorkspaceLinkActor, raw: unknown) {
			try {
				const actor = parse(workspaceLinkActorSchema, rawActor);
				const input = parse(readWorkspaceLinkSchema, raw);
				await deps.authorizeProject(actor, "read");
				const link = await deps.get(actor, input.linkId);
				if (!link) {
					throw new WorkspaceLinkError("NOT_FOUND");
				}
				const doc = (await deps.documents(actor, [link.documentId]))[0];
				if (!doc || doc.organizationId !== actor.organizationId) {
					throw new WorkspaceLinkError("NOT_FOUND");
				}
				const page = await deps.read(actor, {
					workspaceId: doc.workspaceId,
					documentId: doc.id,
					offset: input.offset,
					limit: input.limit,
					expectedRevision: input.expectedRevision,
				});
				const current = await deps.get(actor, input.linkId);
				if (!current || current.documentId !== link.documentId) {
					throw new WorkspaceLinkError("NOT_FOUND");
				}
				await deps.authorizeWorkspace(actor, doc.workspaceId);
				await deps.authorizeProject(actor, "read");

				const final = (
					await deps.documents(actor, [link.documentId])
				)[0];
				if (
					!final ||
					final.organizationId !== actor.organizationId ||
					final.workspaceId !== doc.workspaceId ||
					final.status !== "READY" ||
					final.revision !== page.revision
				) {
					throw new WorkspaceLinkError("STALE_REVISION");
				}

				return {
					...page,
					projectId: actor.projectId,
					linkId: link.id,
					sourceRevisionAtLink: link.sourceRevisionAtLink,
					contentRole: "reference_data" as const,
					sharingGranted: false as const,
				};
			} catch (error) {
				safeError(error);
			}
		},
	};
}
