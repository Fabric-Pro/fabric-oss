import {
	addWorkspaceLinkSchema,
	readWorkspaceLinkSchema,
	WorkspaceLinkError,
	workspaceLinkIdSchema,
	workspaceLinkPageSchema,
} from "@repo/api/modules/projects/lib/workspace-document-links/contracts";
import type { FabricToolDefinition } from "@repo/temporal/fabric-tool-definition";
import { z } from "zod";
import { sessionMayReachProject } from "../project-binding";
import { errorResult, jsonResult } from "../tool-results";
import type { GatewaySession } from "../types";
import { type PlatformToolHandler, toolFamily } from "./tool-family";

const scope = { projectId: z.string().trim().min(1).max(128) };
export function createWorkspaceDocumentLinkTools(
	authorize: (
		projectId: string,
		session: GatewaySession,
	) => Promise<{ organizationId: string | null } | null>,
) {
	const handlers = new Map<string, PlatformToolHandler>();
	const definitions: FabricToolDefinition[] = [];
	function add<S extends z.ZodType<{ projectId: string }>>(
		name: string,
		schema: S,
		operation: "list" | "read" | "add" | "remove",
		description?: string,
	) {
		const write = operation === "add" || operation === "remove";
		if (write) {
			const { $schema: _, ...inputSchema } = z.toJSONSchema(schema);
			definitions.push({
				name,
				description: description ?? "",
				inputSchema,
				annotations: { readOnlyHint: false, idempotentHint: true },
				scope: "projects:write",
				confirm: "always",
			});
		}
		handlers.set(name, async (args, session) => {
			const parsed = schema.safeParse(args);
			if (!parsed.success) {
				return errorResult(
					"Use the declared bounded project document-link schema.",
					{ code: "INVALID_INPUT" },
				);
			}
			const { projectId, ...input } = parsed.data;
			if (!sessionMayReachProject(session, projectId)) {
				return errorResult("Project not found or access denied.", {
					code: "NOT_FOUND",
				});
			}
			if (
				operation !== "remove" &&
				session.credential !== "session" &&
				!session.scopes.includes("workspaces:read") &&
				!session.scopes.includes("*")
			) {
				return errorResult(
					"Linked document access requires explicit workspaces:read scope and current Workspace permission.",
					{ code: "INSUFFICIENT_SCOPE" },
				);
			}
			if (write && session.credential === "service") {
				return errorResult(
					"Document-link changes require an explicit user or external-agent connection.",
					{ code: "FORBIDDEN" },
				);
			}
			try {
				const access = await authorize(projectId, session);
				if (!access?.organizationId) {
					return errorResult("Project not found or access denied.", {
						code: "NOT_FOUND",
					});
				}
				const { workspaceDocumentLinkCommands } = await import(
					"@repo/api/modules/projects/lib/workspace-document-links"
				);
				const commands = await workspaceDocumentLinkCommands();
				const actor = {
					userId: session.userId,
					organizationId: access.organizationId,
					projectId,
				};
				return jsonResult(
					operation === "add" || operation === "remove"
						? await commands[operation](
								actor,
								input,
								session.credential === "session"
									? "user"
									: session.credential === "oauth"
										? "agent"
										: "api_key",
							)
						: await commands[operation](actor, input),
				);
			} catch (error) {
				return error instanceof WorkspaceLinkError
					? errorResult(error.message, { code: error.code })
					: errorResult(
							"Project document links could not be confirmed.",
							{ code: "UNAVAILABLE" },
						);
			}
		});
	}
	add(
		"fabric_list_project_workspace_documents",
		workspaceLinkPageSchema.extend(scope),
		"list",
	);
	add(
		"fabric_read_project_workspace_document",
		readWorkspaceLinkSchema.extend(scope),
		"read",
	);
	add(
		"fabric_link_workspace_document",
		addWorkspaceLinkSchema.extend(scope),
		"add",
		"Links an inspected Workspace document to project context; expectedRevision must match current content. Needs projects:write and workspaces:read; no content copy or sharing grant.",
	);
	add(
		"fabric_unlink_workspace_document",
		workspaceLinkIdSchema.extend(scope),
		"remove",
		"Unlinks a Workspace document reference from project context; keeps the original document. Needs projects:write; unavailable links need no source access.",
	);
	const writeHandlers = new Map(
		[...handlers].filter(
			([name]) =>
				name === "fabric_link_workspace_document" ||
				name === "fabric_unlink_workspace_document",
		),
	);
	return {
		readHandlers: new Map(
			[...handlers].filter(([name]) => !writeHandlers.has(name)),
		),
		writes: toolFamily(definitions, writeHandlers),
	};
}
