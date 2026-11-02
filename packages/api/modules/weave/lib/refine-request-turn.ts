/**
 * One Weave plan refinement, shared by `weave.plans.refine` and the agent
 * runtime's `weave-refine` engine: the project access check, the checks the
 * procedure's chain runs for a caller outside oRPC, the prompt and the model.
 */

import { ORPCError } from "@orpc/server";
import { getAIModelWithMetadata } from "@repo/ai";
import { db, hasProjectAccess } from "@repo/database";
import {
	type AuthorizedProject,
	runWithProjectBindingHolder,
} from "../../../lib/authorized-project-binding";
import {
	assertInputOrgMatchesAuthorizedProject,
	assertProjectPermission,
	Permissions,
	resolveOrganizationIdForCaller,
} from "../../../orpc/procedures";

/** The procedure's router path (`weave/router.ts`); its audit rows carry it. */
export const REFINE_PROCEDURE_PATH = ["weave", "plans", "refine"] as const;

export interface RefineHistoryEntry {
	role: "user" | "assistant";
	content: string;
}

/** The procedure's project check, in an organization the caller already resolved. */
export async function assertRefineProjectAccess(
	projectId: string,
	userId: string,
	organizationId: string | undefined,
): Promise<void> {
	if (!(await hasProjectAccess(projectId, userId, organizationId))) {
		throw new ORPCError("FORBIDDEN", {
			message: "You don't have access to this project",
		});
	}
}

/** What `authorizeRefineRun` admitted. */
export interface RefineRunAuthorization {
	/** The project the permission check authorized, for the turn's error row. */
	authorized: AuthorizedProject;
	/** The organization the turn runs and bills in. */
	organizationId: string | undefined;
}

/**
 * The checks `weave.plans.refine` runs, for a caller outside oRPC (the agent
 * runtime), in the procedure's order:
 * - `requireProjectPermission`'s body (`assertProjectPermission`,
 *   AGENT_EXECUTE);
 * - its input-organization match, on the returned project, so it holds
 *   with no binding in the async context;
 * - the organization resolver;
 * - the project access check.
 *
 * The fresh binding holder makes the resolver answer from the same project.
 * A refusal reaches `onRefusal` while that holder is still open, so its
 * error row is attributed as the procedure's error middleware attributes it:
 * to the authorized project, once the permission check returned one.
 */
export function authorizeRefineRun(args: {
	userId: string;
	organizationId: string;
	projectId: string;
	onRefusal: (error: unknown) => void;
}): Promise<RefineRunAuthorization> {
	return runWithProjectBindingHolder(async () => {
		try {
			const authorized = await assertProjectPermission(
				args.projectId,
				args.userId,
				Permissions.AGENT_EXECUTE,
			);
			assertInputOrgMatchesAuthorizedProject(
				args.organizationId,
				authorized,
			);
			const organizationId = await resolveOrganizationIdForCaller(
				args.organizationId,
				{ activeOrganizationId: args.organizationId },
				args.userId,
			);
			await assertRefineProjectAccess(
				args.projectId,
				args.userId,
				organizationId,
			);
			return { authorized, organizationId };
		} catch (error) {
			args.onRefusal(error);
			throw error;
		}
	});
}

/** The model's prompt: the project, the request, the exchanges so far and the latest input. */
export async function buildRefinePrompt(input: {
	projectId: string;
	currentMessage: string;
	refinementInput: string;
	history: ReadonlyArray<RefineHistoryEntry>;
}): Promise<string> {
	// Fetch project context for the LLM
	const project = await db.project.findUnique({
		where: { id: input.projectId },
		select: { name: true, description: true, techStack: true },
	});

	const projectContext = project
		? `Project: ${project.name}${project.techStack?.length ? `\nTech stack: ${project.techStack.join(", ")}` : ""}${project.description ? `\nDescription: ${project.description}` : ""}`
		: "";

	// Build the conversation for the LLM
	const conversationParts: string[] = [];
	if (projectContext) {
		conversationParts.push(
			`<project-context>\n${projectContext}\n</project-context>`,
		);
	}
	conversationParts.push(`Current plan request:\n${input.currentMessage}`);

	if (input.history.length > 0) {
		conversationParts.push(
			"\nPrevious refinement exchanges:",
			...input.history.map(
				(h) =>
					`${h.role === "user" ? "User" : "Assistant"}: ${h.content}`,
			),
		);
	}

	conversationParts.push(`\nUser's latest input: ${input.refinementInput}`);

	return conversationParts.join("\n\n");
}

/**
 * The SIMPLE model in the caller's organization, with no project. Interactive
 * plan routing follows the caller's context. The model writes its own usage row.
 */
export async function resolveRefineModel(args: {
	userId: string;
	organizationId: string | undefined;
}) {
	const { model, trackUsage } = await getAIModelWithMetadata(
		{ taskType: "SIMPLE" },
		{ userId: args.userId, organizationId: args.organizationId },
	);
	trackUsage();
	return model;
}
