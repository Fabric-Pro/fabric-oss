import { ORPCError } from "@orpc/client";
import { SNAPSHOT_LIMITS } from "@repo/instructions";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import { noteWithCommitMessage } from "./proposal-message-note";
import { commitShaSchema } from "./repository/commit-sha";
import { type NativeChange, submitGitIntentChange } from "./submit-git-intent";

/** Browser file actions retain the 5 MB file limit without deriving or uploading a full tree. */
export const submitGitInstructionChangeProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "POST",
		path: "/projects/:projectId/instructions/repository/change",
		tags: ["Projects", "Instructions"],
		summary: "Commit or propose a repository file action",
	})
	.input(
		z.object({
			projectId: z.string(),
			nativeBase: z.object({
				generation: z.number().int().positive(),
				commitSha: commitShaSchema,
			}),
			mode: z.literal("proposal"),
			message: z.string().max(10_000).optional(),
			note: z
				.object({
					title: z.string().optional(),
					body: z.string().optional(),
				})
				.optional(),
			changes: z
				.array(
					z.discriminatedUnion("op", [
						z.object({
							op: z.literal("put"),
							path: z.string().min(1).max(4096),
							content: z
								.string()
								.max(
									Math.ceil(
										SNAPSHOT_LIMITS.maxFileBytes / 3,
									) * 4,
								),
							encoding: z.literal("base64"),
						}),
						z.object({
							op: z.literal("delete"),
							path: z.string().min(1).max(4096),
						}),
					]),
				)
				.min(1)
				.max(2),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		let byteCount = 0;
		const changes: NativeChange[] = input.changes.map((change) => {
			if (change.op === "delete") return change;
			const bytes = Buffer.from(change.content, "base64");
			byteCount += bytes.length;
			if (
				bytes.toString("base64") !== change.content ||
				byteCount > SNAPSHOT_LIMITS.maxFileBytes
			) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"Invalid file bytes or file action exceeds the file size limit",
				});
			}
			return { op: "put", path: change.path, content: bytes };
		});
		const result = await submitGitIntentChange({
			...input,
			note: noteWithCommitMessage(input.note, input.message),
			changes,
			organizationId,
			userId: context.user.id,
			audit: context,
			via: "orpc",
		});
		return {
			kind: "native" as const,
			operationId: result.snapshotId,
			nativeBase: result.nativeBase,
			status: result.status,
		};
	});
