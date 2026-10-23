/**
 * The `logSource` field of `projects.update`: which application-log source a
 * project's recurring-error scan and bug analysis read.
 *
 * Only providers the settings UI can configure are accepted here. The
 * registry in the worker decides whether a stored binding is usable (it
 * refuses the deployment's shared workspace); this schema only proves the
 * shape, so a malformed id never reaches the database.
 */
import type { ProjectLogSourceBinding } from "@repo/database";
import { z } from "zod";

export const projectLogSourceInputSchema = z
	.object({
		provider: z.literal("azure-monitor"),
		workspaceId: z.guid({
			message: "The workspace id must be a GUID.",
		}),
	})
	.nullable();

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
