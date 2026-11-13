/**
 * A project's code repositories (specs/2026-10-21-ai-artifacts-hub §5.7,
 * workspace layout): every repository connected to the project except the one
 * Coding Instructions read from, each with the `repos/<folder>` it is cloned
 * into in the agent workspace. Fabric only names them; the developer clones
 * and works on them with plain git and their own sign-in. The external API
 * (`fabric repos sync`) and the MCP tool (`fabric_list_code_repositories`)
 * both list them from here, so the folders agree.
 *
 * Addresses only, never a credential. The caller checks project access.
 */

import { db } from "@repo/database";
import { credentialFreeUrl } from "@repo/integrations/instruction-pull-requests";

export const CODE_REPOSITORIES_FOLDER = "repos";

export interface ProjectCodeRepository {
	id: string;
	provider: string;
	name: string;
	cloneUrl: string;
	defaultBranch: string | null;
	roleTag: string | null;
	folder: string;
}

/** The `repos/<folder>` name: the repository name, made safe for every OS. */
function workspaceFolderFor(name: string): string {
	const safe = name.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "");
	return safe === "" ? "repository" : safe;
}

export async function listProjectCodeRepositories(
	projectId: string,
): Promise<ProjectCodeRepository[]> {
	const [rows, sync] = await Promise.all([
		db.projectRepositoryIntegration.findMany({
			where: { projectId, status: { not: "DISCONNECTED" } },
			select: {
				id: true,
				provider: true,
				repositoryUrl: true,
				repositoryOwner: true,
				repositoryName: true,
				defaultBranch: true,
				roleTag: true,
			},
			orderBy: { createdAt: "asc" },
		}),
		// Every repository a set's instructions are read from (several sets
		// may share one), never only the first.
		db.projectInstructionRepositorySync.findMany({
			where: { projectId },
			select: { repositoryIntegrationId: true },
		}),
	]);
	const sources = new Set(sync.map((s) => s.repositoryIntegrationId));
	const used = new Set<string>();
	return rows
		.filter((row) => !sources.has(row.id))
		.flatMap((row) => {
			const url = credentialFreeUrl(row.repositoryUrl);
			if (!url) {
				return [];
			}
			let folder = workspaceFolderFor(row.repositoryName);
			for (let n = 2; used.has(folder.toLowerCase()); n++) {
				folder = `${workspaceFolderFor(row.repositoryName)}-${n}`;
			}
			used.add(folder.toLowerCase());
			return [
				{
					id: row.id,
					provider: row.provider,
					name: `${row.repositoryOwner}/${row.repositoryName}`,
					cloneUrl: url,
					defaultBranch: row.defaultBranch,
					roleTag: row.roleTag,
					folder,
				},
			];
		});
}
