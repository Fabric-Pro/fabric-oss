/**
 * The agent workspace layout (specs/2026-10-21-ai-artifacts-hub §5.7):
 *
 *   <workspace>/            the folder the coding tool runs in; instructions
 *                           come from the Fabric plugin
 *   └─ repos/<folder>/      the project's code repositories, one clone each
 *
 * `syncCodeRepositories` clones every code repository of the project that is
 * not in `repos/` yet and leaves existing clones alone. Clones use the
 * developer's own git sign-in (no credential passes through Fabric).
 *
 * `repos/` never belongs to an instructions repository: when the workspace
 * is itself a git checkout (the instructions repository cloned locally), the
 * folder is added to that checkout's `.git/info/exclude`, so nothing in it
 * can be committed there.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { FabricClient, ProjectCodeRepository } from "@fabricorg/sdk";
import { cloneInto, findWorkTree } from "../instructions/git.js";
import { cloneableUrl } from "../instructions/git-literals.js";

export const REPOS_FOLDER = "repos";
const WORKSPACE_FILE = ".fabric-workspace.json";
const CLONE_TIMEOUT_MS = 10 * 60_000;

export type RepoSyncOutcome =
	| { folder: string; name: string; status: "cloned" | "present" }
	| { folder: string; name: string; status: "failed"; hint: string };

/** The project a workspace's `repos/` was set up for, when it was. */
export async function readWorkspaceProject(
	workspace: string,
): Promise<string | null> {
	try {
		const parsed = JSON.parse(
			await readFile(
				path.join(workspace, REPOS_FOLDER, WORKSPACE_FILE),
				"utf8",
			),
		) as { projectId?: unknown };
		return typeof parsed.projectId === "string" ? parsed.projectId : null;
	} catch {
		return null;
	}
}

function loginHint(repository: ProjectCodeRepository): string {
	switch (repository.provider) {
		case "GITHUB":
			return "gh auth login";
		case "GITLAB":
			return "glab auth login";
		default:
			return `git ls-remote ${repository.cloneUrl}`;
	}
}

async function isEmptyOrMissing(dir: string): Promise<boolean> {
	try {
		return (await readdir(dir)).length === 0;
	} catch {
		return true;
	}
}

/** Adds `repos/` to the checkout's local exclude list when the workspace is a git checkout. */
async function excludeFromCheckout(workspace: string): Promise<void> {
	const tree = await findWorkTree(workspace, Date.now() + 15_000);
	if (tree.kind !== "ok") {
		return;
	}
	const relative = path
		.relative(tree.value.toplevel, path.join(workspace, REPOS_FOLDER))
		.split(path.sep)
		.join("/");
	if (relative.startsWith("..")) {
		return;
	}
	const gitDir = path.resolve(tree.value.toplevel, tree.value.gitDir);
	const file = path.join(gitDir, "info", "exclude");
	const line = `/${relative}/`;
	let current = "";
	try {
		current = await readFile(file, "utf8");
	} catch {
		await mkdir(path.dirname(file), { recursive: true });
	}
	if (current.split(/\r?\n/).includes(line)) {
		return;
	}
	const prefix = current === "" || current.endsWith("\n") ? "" : "\n";
	await writeFile(
		file,
		`${current}${prefix}# Fabric: the project's code repositories, never part of this one\n${line}\n`,
	);
}

export async function syncCodeRepositories(input: {
	client: Pick<FabricClient, "projects">;
	projectId: string;
	org?: string;
	workspace: string;
	onProgress?: (message: string) => void;
}): Promise<RepoSyncOutcome[]> {
	const { repositories } = await input.client.projects.listCodeRepositories(
		input.projectId,
		input.org ? { org: input.org } : {},
	);
	const root = path.join(input.workspace, REPOS_FOLDER);
	await mkdir(root, { recursive: true });
	await writeFile(
		path.join(root, WORKSPACE_FILE),
		`${JSON.stringify({ projectId: input.projectId }, null, 2)}\n`,
	);
	await excludeFromCheckout(input.workspace);

	const outcomes: RepoSyncOutcome[] = [];
	for (const repository of repositories) {
		const dir = path.join(root, repository.folder);
		if (!(await isEmptyOrMissing(dir))) {
			outcomes.push({
				folder: repository.folder,
				name: repository.name,
				status: "present",
			});
			continue;
		}
		const url = cloneableUrl(repository.cloneUrl);
		if (url === null) {
			outcomes.push({
				folder: repository.folder,
				name: repository.name,
				status: "failed",
				hint: "its address cannot be cloned",
			});
			continue;
		}
		input.onProgress?.(
			`Cloning ${repository.name} into ${REPOS_FOLDER}/${repository.folder}…`,
		);
		await mkdir(dir, { recursive: true });
		const result = await cloneInto(
			dir,
			url,
			repository.defaultBranch,
			Date.now() + CLONE_TIMEOUT_MS,
		);
		outcomes.push(
			result.kind === "cloned"
				? {
						folder: repository.folder,
						name: repository.name,
						status: "cloned",
					}
				: {
						folder: repository.folder,
						name: repository.name,
						status: "failed",
						hint: `sign git in to ${repository.provider === "GITHUB" ? "GitHub" : "the provider"} (${loginHint(repository)}) and run \`fabric repos sync\` again`,
					},
		);
	}
	return outcomes;
}

export function describeOutcomes(outcomes: readonly RepoSyncOutcome[]): string {
	if (outcomes.length === 0) {
		return "The project has no code repositories connected besides its instructions.";
	}
	return outcomes
		.map((o) =>
			o.status === "failed"
				? `✗ ${REPOS_FOLDER}/${o.folder} (${o.name}): not cloned — ${o.hint}`
				: `✓ ${REPOS_FOLDER}/${o.folder} (${o.name})${o.status === "present" ? " already here" : ""}`,
		)
		.join("\n");
}
