/**
 * The `logSource` field of `projects.update`: which application-log source a
 * project's recurring-error scan and bug analysis read.
 *
 * Only providers the settings UI can configure are accepted here, and a
 * malformed id never reaches the database. A binding that names the
 * deployment's shared telemetry workspace is refused with the same comparison
 * the worker's scan uses, so it is not saved only to fail every scan. Where the
 * runtime does not know the shared workspace id, that check passes and the
 * worker still refuses the binding at scan time.
 */
import { ORPCError } from "@orpc/client";
import type { ProjectLogSourceBinding } from "@repo/database";
import { namesSharedLogWorkspace } from "@repo/database/src/shared-log-workspace";
import { z } from "zod";

export const SHARED_LOG_WORKSPACE_MESSAGE =
	"This is the deployment's shared telemetry workspace, which a project cannot use. Choose your own workspace or clear the log source.";

export const projectLogSourceInputSchema = z
	.object({
		provider: z.literal("azure-monitor"),
		workspaceId: z.guid({
			message: "The workspace id must be a GUID.",
		}),
	})
	.nullable();

/**
 * Refuse a binding to the deployment's shared telemetry workspace. A handler
 * error rather than a schema refinement, so every client sees this message
 * instead of a generic input-validation failure.
 */
export function assertLogSourceIsUsable(input: ProjectLogSourceInput): void {
	if (input && namesSharedLogWorkspace(input.workspaceId)) {
		throw new ORPCError("BAD_REQUEST", {
			message: SHARED_LOG_WORKSPACE_MESSAGE,
		});
	}
}

export type ProjectLogSourceInput = z.infer<typeof projectLogSourceInputSchema>;

/** The stored binding for a validated input; `null` clears it. */
export function toProjectLogSourceBinding(
	input: ProjectLogSourceInput,
): ProjectLogSourceBinding | null {
	return input
		? {
				provider: input.provider,
				config: { workspaceId: input.workspaceId },
			}
		: null;
}
