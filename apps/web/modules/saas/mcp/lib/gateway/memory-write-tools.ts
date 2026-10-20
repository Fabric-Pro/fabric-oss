/**
 * Fabric MCP Gateway - Living Memory write tools (ADR-022, phase 3)
 *
 * Three tools that let a signed-in agent put plain files into a project's
 * Living Memory folders without a local clone:
 *
 *   - `fabric_memory_targets`      where files may go, and how they land;
 *   - `fabric_memory_write`        write or delete files in one folder;
 *   - `fabric_memory_write_status` read a write's receipt.
 *
 * The files reach the repository through Fabric: admission and the write
 * workflow are the ones the app and the CLI use (`submitMemoryWriteRequest`),
 * and the credential that commits never leaves the server. This module is the
 * tools' definitions and the gateway-side gating only.
 *
 * ## Scope
 *
 * All three require `memory:write`. The two reads are `kind: "read"`, so an
 * `mcp:read` key also lists the folders and reads receipts (the same facts the
 * Context tab shows a reader); `fabric_memory_write` is `kind: "write"`, which
 * `mcp:read` does not satisfy. `memory:write` is the one scope that can land
 * a commit without review (on a direct-push folder), so it is never in the
 * default grant (`OAUTH_DEFAULT_SCOPES`).
 *
 * ## Gating
 *
 * The session's credential reaches the project (`sessionMayReachProject` is
 * applied by `bindToolCall` before a handler runs, and the helpers below add the
 * organization binding and the trash check), then the caller's LIVE
 * permission on the project: `CONTEXT_CREATE` to write and `CONTEXT_READ` to
 * read. The helpers are the platform table's own and are handed in, because
 * they live in `platform-tools.ts`, which registers this module.
 */

import {
	defineFabricTools,
	TOOL_ANNOTATIONS,
} from "@repo/temporal/fabric-tool-definition";
import { errorResult, jsonResult } from "./tool-results";
import {
	type PlatformToolHandler,
	type ToolFamily,
	toolFamily,
} from "./tools/tool-family";
import type { GatewaySession, ToolCallResult } from "./types";

type MemoryToolPermission = "CONTEXT_READ" | "CONTEXT_CREATE";

type ProjectAccess =
	| { status: "allowed"; organizationId: string | null }
	| { status: "not-found" }
	| { status: "forbidden" };

/** The gateway's project gate, as `platform-tools.ts` implements it. */
export interface MemoryWriteToolAccess {
	resolveGatewayProjectWriteAccessWithHost(
		projectId: string,
		session: GatewaySession,
		permission: MemoryToolPermission,
	): Promise<ProjectAccess>;
}

const MAX_FILES = 50;
const MAX_INLINE_MIB = 3;

const MEMORY_WRITE_TOOL_DEFINITIONS = defineFabricTools([
	{
		name: "fabric_memory_targets",
		description:
			"Lists a project's Living Memory write folders: targetId, mode, indexMode, repository, branch, last synced commit. ingesting: true means landed files reach Living Memory at the next sync. PULL_REQUEST folders open a pull request; DIRECT_PUSH folders commit to the branch. STORE_ONLY files are readable but left out of all search and summaries; INDEXED ones are embedded.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
			},
			required: ["projectId"],
		},
		annotations: TOOL_ANNOTATIONS.read,
		scope: "memory:write",
	},
	{
		name: "fabric_memory_read",
		description:
			"Lists or reads files in a Living Memory folder, Store only ones included. No path: lists under prefix, paged by after/limit (nextCursor). With path: returns its text, paged by offset/maxBytes (default 12000, max 50000; nextOffset). E.g. prefix docs/ai/specs/<work-item-id>.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				targetId: {
					type: "string",
					description:
						"Implied by path/prefix, or by a single folder.",
				},
				prefix: { type: "string" },
				after: { type: "string" },
				limit: { type: "number" },
				path: { type: "string" },
				offset: { type: "number" },
				maxBytes: { type: "number" },
			},
			required: ["projectId"],
		},
		annotations: TOOL_ANNOTATIONS.read,
		scope: "memory:write",
	},
	{
		name: "fabric_memory_write",
		description: `Writes plain text files into a Living Memory folder (see fabric_memory_targets) as one commit; all land or none do. Per file: a repository-relative path inside the folder and its full content, or delete: true. A file without ifMatchOid is create-only (refused if the path exists); to replace or delete pass ifMatchOid, the git blob id at the path (fabric_memory_write_status reports it as currentOid when refused). Dot-prefixed path segments are not writable. At most ${MAX_FILES} files and ${MAX_INLINE_MIB} MiB. The outcome is in fabric_memory_write_status. DIRECT_PUSH commits to the branch (or opens a pull request if it is protected); PULL_REQUEST opens one, invisible to Living Memory until merged. Not for instruction files: use fabric_propose_project_instruction_change.`,
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				targetId: {
					type: "string",
					description: "Omit when the project has one folder.",
				},
				message: {
					type: "string",
					description:
						"Commit message (pull request title: first line).",
				},
				files: {
					type: "array",
					items: {
						type: "object",
						properties: {
							path: { type: "string" },
							content: { type: "string" },
							delete: { type: "boolean" },
							ifMatchOid: { type: "string" },
						},
						required: ["path"],
					},
				},
			},
			required: ["projectId", "message", "files"],
		},
		annotations: TOOL_ANNOTATIONS.idempotentWrite,
		scope: "memory:write",
	},
	{
		name: "fabric_memory_write_status",
		description:
			"Reads a Living Memory write receipt: PENDING, then COMMITTED, PULL_REQUEST (with its URL), CONFLICT or REFUSED (a verdict per path, currentOid for a changed path), or FAILED.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string" },
				writeId: {
					type: "string",
					description:
						"From fabric_memory_write, or the outbox of .fabric/memory.lock.",
				},
			},
			required: ["projectId", "writeId"],
		},
		annotations: TOOL_ANNOTATIONS.read,
		scope: "memory:write",
	},
]);

const PROJECT_DENIED = "Project not found or access denied";

/** The refusal for a project the caller cannot use, or null when `resolved` is a project to act on. */
function projectDenial(
	resolved: ProjectAccess,
	permission: MemoryToolPermission,
): ToolCallResult | null {
	if (resolved.status === "not-found") {
		return errorResult(PROJECT_DENIED);
	}
	if (resolved.status === "forbidden") {
		return errorResult(
			permission === "CONTEXT_CREATE"
				? "No permission to add context sources to this project"
				: "No permission to read context sources of this project",
		);
	}
	if (resolved.organizationId === null) {
		return errorResult(
			"Living Memory writes need a project that belongs to an organization",
		);
	}
	return null;
}

function projectIdOf(args: Record<string, unknown>): string | null {
	return typeof args.projectId === "string" && args.projectId.length > 0
		? args.projectId
		: null;
}

const viewsModule = () =>
	import("@repo/api/modules/projects/lib/memory-write/memory-write-views");

async function handleMemoryTargets(
	access: MemoryWriteToolAccess,
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const projectId = projectIdOf(args);
	if (projectId === null) {
		return errorResult("projectId is required");
	}
	const resolved = await access.resolveGatewayProjectWriteAccessWithHost(
		projectId,
		session,
		"CONTEXT_READ",
	);
	const denial = projectDenial(resolved, "CONTEXT_READ");
	if (denial || resolved.status !== "allowed" || !resolved.organizationId) {
		return denial ?? errorResult(PROJECT_DENIED);
	}
	const { getMemoryWriteTargetsView } = await viewsModule();
	return jsonResult(
		await getMemoryWriteTargetsView({
			projectId,
			organizationId: resolved.organizationId,
		}),
	);
}

async function handleMemoryRead(
	access: MemoryWriteToolAccess,
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const projectId = projectIdOf(args);
	if (projectId === null) {
		return errorResult("projectId is required");
	}
	const { z } = await import("zod");
	const parsed = z
		.object({
			targetId: z.string().min(1).max(128).optional(),
			prefix: z.string().min(1).max(512).optional(),
			after: z.string().max(1024).optional(),
			limit: z.number().int().min(1).optional(),
			path: z.string().min(1).max(1024).optional(),
			offset: z.number().int().min(0).optional(),
			maxBytes: z.number().int().min(1).optional(),
		})
		.safeParse(args);
	if (!parsed.success) {
		return errorResult(
			`Invalid arguments: ${parsed.error.issues
				.map(
					(issue) =>
						`${issue.path.join(".") || "arguments"}: ${issue.message}`,
				)
				.join("; ")}`,
		);
	}
	const resolved = await access.resolveGatewayProjectWriteAccessWithHost(
		projectId,
		session,
		"CONTEXT_READ",
	);
	const denial = projectDenial(resolved, "CONTEXT_READ");
	if (denial || resolved.status !== "allowed" || !resolved.organizationId) {
		return denial ?? errorResult(PROJECT_DENIED);
	}
	const organizationId = resolved.organizationId;
	const input = parsed.data;

	const views = await viewsModule();
	const targets = await views.getMemoryWriteTargetsView({
		projectId,
		organizationId,
	});
	const within = input.path ?? input.prefix;
	const holding = targets.targets.filter(
		(t) => within === t.folder || within?.startsWith(`${t.folder}/`),
	);
	const target = input.targetId
		? targets.targets.find((t) => t.id === input.targetId)
		: targets.targets.length === 1
			? targets.targets[0]
			: holding.length === 1
				? holding[0]
				: undefined;
	if (!target) {
		return errorResult(
			input.targetId
				? "Write folder not found"
				: targets.targets.length === 0
					? "This project has no Living Memory write folders. A project admin adds them in the Context tab."
					: "targetId, or a path or prefix inside one folder, is required: this project has several write folders.",
			targets.targets.length > 1 ? { targets: targets.targets } : {},
		);
	}

	if (input.path !== undefined) {
		const file = await views.getMemoryFolderTextView({
			projectId,
			organizationId,
			targetId: target.id,
			path: input.path,
			offset: input.offset,
			maxBytes: input.maxBytes,
		});
		return file ? jsonResult(file) : errorResult("File not found");
	}
	const listing = await views.getMemoryFolderFilesView({
		projectId,
		organizationId,
		targetId: target.id,
		prefix: input.prefix,
		after: input.after ?? null,
		limit: input.limit ?? 500,
	});
	return listing
		? jsonResult(listing)
		: errorResult(
				"Folder not found, or the prefix is outside the write folder",
			);
}

async function handleMemoryWriteStatus(
	access: MemoryWriteToolAccess,
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const projectId = projectIdOf(args);
	if (projectId === null) {
		return errorResult("projectId is required");
	}
	if (typeof args.writeId !== "string" || args.writeId.length === 0) {
		return errorResult("writeId is required");
	}
	const resolved = await access.resolveGatewayProjectWriteAccessWithHost(
		projectId,
		session,
		"CONTEXT_READ",
	);
	const denial = projectDenial(resolved, "CONTEXT_READ");
	if (denial || resolved.status !== "allowed" || !resolved.organizationId) {
		return denial ?? errorResult(PROJECT_DENIED);
	}
	const { getMemoryWriteView } = await viewsModule();
	const view = await getMemoryWriteView({
		writeId: args.writeId,
		projectId,
		organizationId: resolved.organizationId,
	});
	if (!view) {
		return errorResult("Write not found");
	}
	return jsonResult({ ...view, note: statusNote(view.outcome) });
}

async function handleMemoryWrite(
	access: MemoryWriteToolAccess,
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const projectId = projectIdOf(args);
	if (projectId === null) {
		return errorResult("projectId is required");
	}
	const resolved = await access.resolveGatewayProjectWriteAccessWithHost(
		projectId,
		session,
		"CONTEXT_CREATE",
	);
	const denial = projectDenial(resolved, "CONTEXT_CREATE");
	if (denial || resolved.status !== "allowed" || !resolved.organizationId) {
		return denial ?? errorResult(PROJECT_DENIED);
	}
	const { organizationId } = resolved;

	const { z } = await import("zod");
	const { memoryWriteSubmitFields } = await import(
		"@repo/api/modules/projects/lib/memory-write/memory-write-input"
	);
	const parsed = z
		.object({
			targetId: memoryWriteSubmitFields.targetId.optional(),
			message: memoryWriteSubmitFields.message,
			files: z
				.array(
					z
						.object({
							path: z.string(),
							content: z.string().optional(),
							delete: z.boolean().optional(),
							ifMatchOid: z.string().max(128).optional(),
						})
						.refine(
							(file) =>
								file.delete === true
									? file.content === undefined
									: file.content !== undefined,
							{
								message:
									"each file needs content, or delete: true and no content",
							},
						),
				)
				.min(1)
				.max(MAX_FILES),
		})
		.safeParse(args);
	if (!parsed.success) {
		return errorResult(
			`Invalid arguments: ${parsed.error.issues
				.map(
					(issue) =>
						`${issue.path.join(".") || "arguments"}: ${issue.message}`,
				)
				.join("; ")}`,
		);
	}

	const { getMemoryWriteTargetsView } = await viewsModule();
	const targets = await getMemoryWriteTargetsView({
		projectId,
		organizationId,
	});
	const target = parsed.data.targetId
		? targets.targets.find((t) => t.id === parsed.data.targetId)
		: targets.targets.length === 1
			? targets.targets[0]
			: undefined;
	if (!target) {
		return errorResult(
			parsed.data.targetId
				? "Write folder not found"
				: targets.targets.length === 0
					? "This project has no Living Memory write folders. A project admin adds them in the Context tab."
					: "targetId is required: this project has several write folders.",
			targets.targets.length > 1 ? { targets: targets.targets } : {},
		);
	}

	const { submitMemoryWriteRequest } = await import(
		"@repo/api/modules/projects/lib/memory-write/submit-memory-write-request"
	);
	const result = await submitMemoryWriteRequest({
		projectId,
		organizationId,
		userId: session.userId,
		via: "MCP",
		oauthClientId: session.oauthClientId ?? null,
		targetId: target.id,
		message: parsed.data.message,
		entries: parsed.data.files.map((file) =>
			file.delete === true
				? {
						path: file.path,
						op: "DELETE" as const,
						ifMatchOid: file.ifMatchOid,
					}
				: {
						path: file.path,
						op: "PUT" as const,
						ifMatchOid: file.ifMatchOid,
						content: file.content,
					},
		),
		audit: {
			user: {
				id: session.userId,
				email: session.email,
				name: session.userName,
			},
		},
	});
	switch (result.kind) {
		case "refused":
			return errorResult(
				"This write cannot be admitted. Nothing was written; every problem is in problems.",
				{ code: "MEMORY_WRITE_REFUSED", problems: result.problems },
			);
		case "too-many-pending":
			return errorResult(
				`At most ${result.limit} of your writes can be pending in a project. Wait for one to finish.`,
				{ code: "TOO_MANY_PENDING_WRITES" },
			);
		case "start-failed":
			return errorResult("The write could not be started. Try again.", {
				code: "WORKFLOW_START_FAILED",
			});
		case "accepted":
			return jsonResult({
				writeId: result.writeId,
				status: result.status,
				deduplicated: result.deduplicated,
				folder: target.folder,
				mode: target.mode,
				branch: targets.sync?.ref ?? null,
				note: landingNote(target.mode),
			});
		default: {
			const unreachable: never = result;
			return unreachable;
		}
	}
}

function landingNote(mode: "PULL_REQUEST" | "DIRECT_PUSH"): string {
	return mode === "DIRECT_PUSH"
		? "Accepted, not yet written. It will be committed to the synced branch (or, if the branch is protected, opened as a pull request); read fabric_memory_write_status for the outcome. A commit reaches Living Memory on the next sync."
		: "Accepted, not yet written. A pull request will be opened; read fabric_memory_write_status for its URL. The files are not in Living Memory until a person merges it.";
}

function statusNote(outcome: { status: string } | null): string {
	switch (outcome?.status) {
		case "COMMITTED":
			return "Committed to the synced branch. Living Memory reads it on the next sync.";
		case "PULL_REQUEST":
			return "A pull request is open. The files are not in Living Memory until it is merged.";
		case "CONFLICT":
			return "Nothing was written: a path changed under you. Resend with ifMatchOid set to each path's currentOid.";
		case "REFUSED":
			return "Nothing was written. See the code and per-path verdicts.";
		case "FAILED":
			return "The write did not complete. If retryable, send the same request again.";
		default:
			return "Still pending; check again shortly.";
	}
}

/** The Living Memory write tools, registered like every other family (see `./tools/frame-tools`). */
export function createMemoryWriteTools(
	access: MemoryWriteToolAccess,
): ToolFamily {
	return toolFamily(
		MEMORY_WRITE_TOOL_DEFINITIONS,
		new Map<string, PlatformToolHandler>([
			[
				"fabric_memory_targets",
				(args, session) => handleMemoryTargets(access, args, session),
			],
			[
				"fabric_memory_read",
				(args, session) => handleMemoryRead(access, args, session),
			],
			[
				"fabric_memory_write",
				(args, session) => handleMemoryWrite(access, args, session),
			],
			[
				"fabric_memory_write_status",
				(args, session) =>
					handleMemoryWriteStatus(access, args, session),
			],
		]),
	);
}
