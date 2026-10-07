import { ORPCError } from "@orpc/client";
import { instructionChangeBaseSchema } from "@repo/api/modules/projects/procedures/instructions/change-base";
import type { InlineInstructionChange } from "@repo/api/modules/projects/procedures/instructions/submit-change";
import { listDirectRepositoryFilesForApi } from "@repo/api/modules/v1/instruction-direct-repository";
import { resolveGatewayDirectInstructionRead } from "./instruction-direct-repository";
import { lessonPath, renderLesson } from "./instruction-lessons";
import type { GatewaySession } from "./types";

export async function proposeNativeInstructionChange(input: {
	projectId: string;
	session: GatewaySession;
	nativeBase: unknown;
	changes: InlineInstructionChange[];
	note?: { title?: string; body?: string };
	ensureInstructionRead: () => Promise<boolean>;
}) {
	if (!(await input.ensureInstructionRead()))
		throw new ORPCError("NOT_FOUND", {
			message: "Project not found or access denied",
		});
	const base = instructionChangeBaseSchema.parse({
		nativeBase: input.nativeBase,
	});
	const { submitInstructionChange } = await import(
		"@repo/api/modules/projects/procedures/instructions/submit-change"
	);
	const result = await submitInstructionChange({
		...base,
		projectId: input.projectId,
		userId: input.session.userId,
		changes: input.changes,
		note: input.note,
		mode: "proposal",
		via: "mcp-gateway",
		audit: {
			user: {
				id: input.session.userId,
				email: input.session.email,
				name: input.session.userName,
			},
			session: {
				id: input.session.sessionId,
				activeOrganizationId: input.session.organizationId,
			},
		},
	});
	if (!("nativeBase" in result))
		throw new Error("Native proposal returned a snapshot result");
	if (!(await input.ensureInstructionRead()))
		throw new ORPCError("NOT_FOUND", {
			message: "Project not found or access denied",
		});
	return {
		proposal: {
			operationId: result.snapshotId,
			nativeBase: result.nativeBase,
			status: result.proposalStatus,
			operationStatus: result.status,
			changedFiles: result.putCount,
			deletedFiles: result.deleteCount,
		},
		message:
			"The change was submitted as a repository pull-request suggestion. It has not been applied to the target branch.",
	};
}

export async function proposeNativeInstructionLesson(input: {
	projectId: string;
	session: GatewaySession;
	ensureInstructionRead: () => Promise<boolean>;
	title: string;
	body: string;
	relatedPaths?: string[];
	note?: { title?: string; body?: string };
}) {
	const direct = await resolveGatewayDirectInstructionRead({
		projectId: input.projectId,
		userId: input.session.userId,
		ensureInstructionRead: input.ensureInstructionRead,
	});
	if (direct.kind === "legacy") return null;
	if (direct.kind === "denied")
		throw new ORPCError("NOT_FOUND", {
			message: "Project not found or access denied",
		});
	if (direct.kind !== "repository")
		throw new ORPCError("PRECONDITION_FAILED", {
			message:
				"Repository instructions are not available. Reconnect the repository in Coding Instructions.",
		});
	const nativeBase = {
		generation: direct.state.generation,
		commitSha: direct.state.currentCommitSha,
	};
	const files = await listDirectRepositoryFilesForApi({
		projectId: input.projectId,
		userId: input.session.userId,
		...nativeBase,
	});
	if (files.incomplete || files.refusal !== null)
		throw new ORPCError("PRECONDITION_FAILED", {
			message:
				"Repository listing is incomplete. Try again before adding a lesson.",
		});
	const date = new Date();
	const path = lessonPath(
		input.title,
		date,
		new Set(files.files.map((file) => file.path)),
	);
	const result = await proposeNativeInstructionChange({
		...input,
		nativeBase,
		changes: [
			{
				op: "put",
				path,
				content: renderLesson({
					title: input.title,
					body: input.body,
					date,
					relatedPaths: input.relatedPaths ?? [],
				}),
				encoding: "utf8",
			},
		],
	});
	return { ...result, lesson: { path } };
}
