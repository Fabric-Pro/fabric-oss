/**
 * `fabric_list_code_repositories` (specs/2026-10-21-ai-artifacts-hub §5.7):
 * the project's code repositories, for a coding tool working through the
 * Coding Instructions plugin. The plugin runs in the agent workspace, and the
 * agent clones each repository into `repos/<folder>/` there with plain git and
 * the developer's own sign-in. Fabric names the repositories and nothing
 * more: it does not clone, sync or watch them.
 *
 * Same list as the external API (`fabric repos sync`) and the same gate:
 * `instructions:read`, the scope the plugin's sign-in carries, and the
 * caller's live `CONTEXT_READ` on the project.
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

type ProjectAccess =
	| { status: "allowed"; organizationId: string | null }
	| { status: "not-found" }
	| { status: "forbidden" };

/** The gateway's project gate, as `platform-tools.ts` implements it. */
export interface CodeRepositoriesToolAccess {
	resolveGatewayProjectWriteAccessWithHost(
		projectId: string,
		session: GatewaySession,
		permission: "CONTEXT_READ",
	): Promise<ProjectAccess>;
}

const CODE_REPOSITORIES_TOOL_DEFINITIONS = defineFabricTools([
	{
		name: "fabric_list_code_repositories",
		description:
			"The project's code repositories: clone URL and repos/<folder> path for git clone.",
		inputSchema: {
			type: "object",
			properties: { projectId: { type: "string" } },
			required: ["projectId"],
		},
		annotations: TOOL_ANNOTATIONS.read,
		scope: "instructions:read",
	},
]);

async function handleListCodeRepositories(
	access: CodeRepositoriesToolAccess,
	args: Record<string, unknown>,
	session: GatewaySession,
): Promise<ToolCallResult> {
	const projectId = args.projectId;
	if (typeof projectId !== "string" || projectId === "") {
		return errorResult("projectId is required");
	}
	const gate = await access.resolveGatewayProjectWriteAccessWithHost(
		projectId,
		session,
		"CONTEXT_READ",
	);
	if (gate.status === "not-found") {
		return errorResult("Project not found or access denied");
	}
	if (gate.status === "forbidden") {
		return errorResult("No permission to read this project");
	}
	const { CODE_REPOSITORIES_FOLDER, listProjectCodeRepositories } =
		await import("@repo/api/modules/projects/lib/code-repositories");
	const repositories = await listProjectCodeRepositories(projectId);
	return jsonResult({
		repositories: repositories.map((repo) => ({
			name: repo.name,
			provider: repo.provider,
			cloneUrl: repo.cloneUrl,
			defaultBranch: repo.defaultBranch,
			roleTag: repo.roleTag,
			path: `${CODE_REPOSITORIES_FOLDER}/${repo.folder}`,
		})),
		message:
			repositories.length === 0
				? "This project has no code repositories connected in Fabric."
				: `Clone each missing one with \`git clone <cloneUrl> <path>\` from the workspace root (the folder holding ${CODE_REPOSITORIES_FOLDER}/); leave existing clones alone. When the workspace is a git checkout, keep /${CODE_REPOSITORIES_FOLDER}/ out of it through .git/info/exclude. Fabric does not sync these clones: use git in each.`,
	});
}

export function createCodeRepositoriesTools(
	access: CodeRepositoriesToolAccess,
): ToolFamily {
	return toolFamily(
		CODE_REPOSITORIES_TOOL_DEFINITIONS,
		new Map<string, PlatformToolHandler>([
			[
				"fabric_list_code_repositories",
				(a, s) => handleListCodeRepositories(access, a, s),
			],
		]),
	);
}
