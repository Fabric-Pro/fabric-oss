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
			"Lists a project's Living Memory write folders: the folders in its repository that agents may write files into, each with its targetId and mode, the repository (provider, owner, name) and branch, and the commit the last sync applied. PULL_REQUEST folders open a pull request; DIRECT_PUSH folders commit to the branch itself. Returns no folders if none are configured.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string", description: "The project." },
			},
			required: ["projectId"],
		},
		annotations: TOOL_ANNOTATIONS.read,
		scope: "memory:write",
	},
	{
		name: "fabric_memory_write",
		description: `Writes plain text files into one of a project's Living Memory folders (see fabric_memory_targets) as a single commit; all files land or none do. Give each file a repository-relative path inside the folder and its full content, or delete: true. A file without ifMatchOid is create-only and the write is refused if the path exists; to replace or delete a file pass ifMatchOid, the git blob id now at the path (a refused write reports it as currentOid in fabric_memory_write_status). Paths with a dot-prefixed segment are never writable. At most ${MAX_FILES} files and ${MAX_INLINE_MIB} MiB of text. Answers a receipt at once; the outcome is in fabric_memory_write_status. On a DIRECT_PUSH folder the commit lands on the branch (or, if the branch is protected, in a pull request); on a PULL_REQUEST folder a pull request is opened. A pull request is invisible to Living Memory until a person merges it; a commit reaches Living Memory on the next sync. Coding-instruction files are not written here: use fabric_propose_project_instruction_change.`,
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string", description: "The project." },
				targetId: {
					type: "string",
					description:
						"The write folder. May be omitted when the project has exactly one.",
				},
				message: {
					type: "string",
					description:
						"The commit message (and pull request title: its first line).",
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
			"Reads the receipt of a Living Memory write: PENDING until it settles, then COMMITTED, PULL_REQUEST (with the pull request URL), CONFLICT or REFUSED (with a verdict per path, and currentOid for a path that changed), or FAILED. Poll it after fabric_memory_write.",
		inputSchema: {
			type: "object",
			properties: {
				projectId: { type: "string", description: "The project." },
				writeId: {
					type: "string",
					description: "From fabric_memory_write.",
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
