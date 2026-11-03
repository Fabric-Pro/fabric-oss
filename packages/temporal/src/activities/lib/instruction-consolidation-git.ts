/**
 * Git steps of an instructions consolidation (specs/2026-10-21-ai-artifacts-hub
 * §5.2, P4): copy the confirmed AI files from the code repository into the
 * instructions repository Fabric created, and remove them from the code
 * repository in a pull request.
 *
 * Every command runs through the sync's bounded runner, safe config, askpass
 * env and redaction (`instruction-sync-git.ts`). Each repository gets its own
 * workspace and its own credential env, so neither token reaches the other
 * host's remote.
 *
 * Both steps are idempotent. The copy recognises a tree it already wrote on
 * the target branch; the cleanup pushes a create-only branch and, when it
 * already exists, looks the pull request up instead of opening another.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import path from "node:path";
import { getProjectRepoIntegration } from "@repo/database";
import { type ConsolidationItem, scopeHeader } from "@repo/instructions";
import { resolveFreshRepoToken } from "@repo/integrations";
import {
	adapterFor,
	InstructionPullRequestError,
	repositoryIdentity,
	type Target,
} from "@repo/integrations/instruction-pull-requests";
import { logger } from "@repo/logs";
import { initBranchWorkspace } from "./instruction-branch-git";
import {
	assertObjectId,
	buildGitEnv,
	commitTree,
	credentialFreeUrl,
	GitCommandError,
	gitUsernameFor,
	listTreeRaw,
	MAX_INVENTORY_ENTRIES,
	porcelainFlag,
	readBaseTree,
	readBlobCapped,
	revParseHead,
	runGit,
	runPush,
	writeProposalTree,
	writeResolvedTree,
} from "./instruction-sync-git";
import { createSyncRunDir, removeSyncRunDir } from "./instruction-sync-temp";

export type ConsolidationFile = Pick<
	ConsolidationItem,
	"from" | "to" | "transform"
>;

export type CommitIdentity = { name: string; email: string };

/** The largest single file copied; instruction files are text. */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/** The cleanup branch; one per consolidation run. */
export function cleanupBranchName(consolidationId: string): string {
	const suffix = consolidationId
		.toLowerCase()
		.replace(/[^a-z0-9]/g, "")
		.slice(-8);
	return `fabric/move-ai-instructions-${suffix}`;
}

/** The push's own answer, redacted by the runner: what to read when a push is refused. */
function logPushOutcome(
	ref: string,
	line: { flag: string; summary: string } | null,
	error: GitCommandError | null,
): void {
	if (error === null && line !== null && line.flag !== "!") {
		return;
	}
	logger.warn("[instruction-consolidation] push refused", {
		ref,
		flag: line?.flag ?? null,
		summary: line?.summary ?? null,
		stderr: error?.stderrTail.slice(-1500) ?? null,
	});
}

export class ConsolidationStepError extends Error {
	constructor(
		readonly code:
			| "REPOSITORY_UNAVAILABLE"
			| "AUTHENTICATION_FAILED"
			| "PUSH_REFUSED"
			| "NOTHING_TO_COPY"
			| "PULL_REQUEST_FAILED",
		message: string,
	) {
		super(message);
		this.name = "ConsolidationStepError";
	}
}

type Workspace = {
	url: string;
	env: NodeJS.ProcessEnv;
	dir: string;
	defaultBranch: string;
	target: Target;
};

/** Clones one integration's default branch, blobless, into `runDir/<name>`. */
async function openWorkspace(input: {
	integrationId: string;
	projectId: string;
	userId: string;
	organizationId: string | null;
	runDir: string;
	name: string;
	signal: AbortSignal;
}): Promise<Workspace> {
	const integration = await getProjectRepoIntegration(
		input.integrationId,
		input.projectId,
	);
	if (!integration) {
		throw new ConsolidationStepError(
			"REPOSITORY_UNAVAILABLE",
			"The repository is no longer connected to the project.",
		);
	}
	const url = credentialFreeUrl(integration.repositoryUrl);
	const identity = repositoryIdentity(
		integration.provider,
		integration.repositoryUrl,
	);
	if (url === null || identity === null) {
		throw new ConsolidationStepError(
			"REPOSITORY_UNAVAILABLE",
			"The repository address cannot be used.",
		);
	}
	const resolved = await resolveFreshRepoToken({
		integrationId: input.integrationId,
		projectId: input.projectId,
		userId: input.userId,
		organizationId: input.organizationId,
		signal: input.signal,
	});
	if (!resolved.token) {
		throw new ConsolidationStepError(
			"AUTHENTICATION_FAILED",
			"The repository's credential is missing or expired. Reconnect it in the project's integrations.",
		);
	}
	const env = buildGitEnv({
		home: input.runDir,
		username: gitUsernameFor(integration.provider),
		credential: resolved.token,
		host: new URL(url).host,
	});
	const dir = path.join(input.runDir, input.name);
	await initBranchWorkspace({
		url,
		targetRef: integration.defaultBranch,
		dir,
		env,
		signal: input.signal,
	});
	return {
		url,
		env,
		dir,
		defaultBranch: integration.defaultBranch,
		target: {
			auth: {
				token: resolved.token,
				authMethod:
					(resolved.authMethod ?? integration.authMethod) === "PAT"
						? "PAT"
						: "OAUTH",
			},
			repository: identity,
			signal: input.signal,
		},
	};
}

async function treeOf(ws: Workspace, sha: string, signal: AbortSignal) {
	const listed = await listTreeRaw({
		dir: ws.dir,
		env: ws.env,
		signal,
		sha,
		rootPath: "",
		maxEntries: MAX_INVENTORY_ENTRIES,
	});
	if (!listed.ok) {
		throw new ConsolidationStepError(
			"REPOSITORY_UNAVAILABLE",
			"The repository has too many files to read.",
		);
	}
	const byPath = new Map<string, { oid: string; mode: string }>();
	for (const entry of listed.entries) {
		if (entry.path !== null && entry.type === "blob") {
			byPath.set(entry.path, { oid: entry.oid, mode: entry.mode });
		}
	}
	return byPath;
}

async function headTree(ws: Workspace, signal: AbortSignal): Promise<string> {
	const { stdout } = await runGit({
		cwd: ws.dir,
		args: ["rev-parse", "--verify", "HEAD^{tree}"],
		env: ws.env,
		signal,
		label: "rev-parse",
		maxStdoutBytes: 256,
	});
	return stdout.toString("utf8").trim();
}

/** Fast-forwards `branch` on origin from `expected` to `sha`; true when it already points at `sha`. */
async function pushFastForward(
	ws: Workspace,
	input: { sha: string; expected: string; branch: string },
	signal: AbortSignal,
): Promise<void> {
	assertObjectId(input.sha, "push");
	assertObjectId(input.expected, "push");
	const ref = `refs/heads/${input.branch}`;
	const { stdout, error } = await runPush({
		cwd: ws.dir,
		env: ws.env,
		signal,
		label: "push",
		args: [
			"push",
			"--porcelain",
			"--no-follow-tags",
			`--force-with-lease=${ref}:${input.expected}`,
			"origin",
			`${input.sha}:${ref}`,
		],
	});
	const line = porcelainFlag(stdout, ref);
	logPushOutcome(ref, line, error);
	if (error === null && (line?.flag === " " || line?.flag === "=")) {
		return;
	}
	throw new ConsolidationStepError(
		"PUSH_REFUSED",
		"The instructions repository refused the commit. Check that the credential may push to its default branch.",
	);
}

/** Pushes `sha` to a new branch; `exists` when the branch is already there. */
async function pushNewBranch(
	ws: Workspace,
	input: { sha: string; branch: string },
	signal: AbortSignal,
): Promise<"created" | "exists"> {
	assertObjectId(input.sha, "push");
	const ref = `refs/heads/${input.branch}`;
	const { stdout, error } = await runPush({
		cwd: ws.dir,
		env: ws.env,
		signal,
		label: "push",
		args: [
			"push",
			"--porcelain",
			"--no-follow-tags",
			`--force-with-lease=${ref}:`,
			"origin",
			`${input.sha}:${ref}`,
		],
	});
	const line = porcelainFlag(stdout, ref);
	logPushOutcome(ref, line, error);
	if (line?.flag === "*" && error === null) {
		return "created";
	}
	if (
		line?.flag === "=" ||
		(line?.flag === "!" &&
			/already exists|stale info|fetch first/.test(line.summary))
	) {
		return "exists";
	}
	throw new ConsolidationStepError(
		"PUSH_REFUSED",
		"The code repository refused the cleanup branch. Check that the credential may push branches.",
	);
}

function readmeFor(sourceRepository: string): Buffer {
	return Buffer.from(
		[
			"# AI instructions",
			"",
			`The coding instructions, skills, agents and tool settings for \`${sourceRepository}\`.`,
			"",
			"This repository is managed by Fabric. Coding tools receive its content through the Fabric plugin and MCP server, so none of it lives in the code repository. Change it through Fabric (the plugin's change-instructions skill, or the Coding Instructions tab), not by editing the plugin's copy.",
			"",
			"Layout: `AGENTS.md` and `CLAUDE.md` (always on), `rules/`, `skills/<name>/`, `agents/`, `commands/`, and `tools/<tool>/` for settings and hooks that are kept but not delivered as instructions.",
			"",
			"Agent workspace: the coding tool runs in a folder that has the project's code repositories cloned in `repos/<name>/` (`fabric repos sync`). Instructions refer to code by that path. `repos/` is ignored here.",
			"",
		].join("\n"),
		"utf8",
	);
}

export type CopyResult = { sourceCommitSha: string; copiedCommitSha: string };

/**
 * Copies `files` from the source repository's default-branch head into the
 * target repository's default branch as one commit. A file that no longer
 * exists in the source is skipped; when none is left the step fails.
 */
export async function runConsolidationCopy(input: {
	projectId: string;
	userId: string;
	organizationId: string | null;
	sourceIntegrationId: string;
	targetIntegrationId: string;
	files: readonly ConsolidationFile[];
	author: CommitIdentity;
	committer: CommitIdentity;
	date: string;
	signal: AbortSignal;
}): Promise<CopyResult> {
	const runDir = await createSyncRunDir();
	try {
		const common = {
			projectId: input.projectId,
			userId: input.userId,
			organizationId: input.organizationId,
			runDir,
			signal: input.signal,
		};
		const source = await openWorkspace({
			...common,
			integrationId: input.sourceIntegrationId,
			name: "source",
		});
		const target = await openWorkspace({
			...common,
			integrationId: input.targetIntegrationId,
			name: "target",
		});
		const sourceSha = await revParseHead({
			dir: source.dir,
			env: source.env,
			signal: input.signal,
		});
		const targetSha = await revParseHead({
			dir: target.dir,
			env: target.env,
			signal: input.signal,
		});
		const sourceTree = await treeOf(source, sourceSha, input.signal);

		const delta: {
			path: string;
			mode: "100644" | "100755";
			bytes: Buffer;
		}[] = [];
		for (const file of input.files) {
			if (file.to === null) {
				continue;
			}
			const entry = sourceTree.get(file.from);
			if (
				!entry ||
				(entry.mode !== "100644" && entry.mode !== "100755")
			) {
				continue;
			}
			const bytes = await readBlobCapped({
				dir: source.dir,
				env: source.env,
				signal: input.signal,
				oid: entry.oid,
				maxBytes: MAX_FILE_BYTES,
			});
			if (bytes === null) {
				continue;
			}
			delta.push({
				path: file.to,
				mode: entry.mode,
				bytes:
					file.transform === "scope-header"
						? Buffer.concat([
								Buffer.from(scopeHeader(file.from), "utf8"),
								bytes,
							])
						: bytes,
			});
		}
		if (delta.length === 0) {
			throw new ConsolidationStepError(
				"NOTHING_TO_COPY",
				"None of the selected files exist on the code repository's default branch any more.",
			);
		}
		const sourceName = `${source.target.repository.provider === "GITHUB" ? `${source.target.repository.owner}/${source.target.repository.repo}` : source.url}`;
		delta.push({
			path: "README.md",
			mode: "100644",
			bytes: readmeFor(sourceName),
		});
		// The agent workspace keeps the code in `repos/`: never part of this repository.
		delta.push({
			path: ".gitignore",
			mode: "100644",
			bytes: Buffer.from(
				"# The agent workspace's code repositories (fabric repos sync): never committed here.\n/repos/\n",
				"utf8",
			),
		});

		const indexFile = path.join(runDir, "target.index");
		await readBaseTree({
			dir: target.dir,
			env: target.env,
			signal: input.signal,
			sha: targetSha,
			indexFile,
		});
		const { tree } = await writeProposalTree({
			dir: target.dir,
			env: target.env,
			signal: input.signal,
			indexFile,
			delta,
		});
		// A retry after a lost answer: the branch already carries this tree.
		if (tree === (await headTree(target, input.signal))) {
			return { sourceCommitSha: sourceSha, copiedCommitSha: targetSha };
		}
		const sha = await commitTree({
			dir: target.dir,
			env: target.env,
			signal: input.signal,
			tree,
			parent: targetSha,
			author: input.author,
			committer: input.committer,
			date: input.date,
			message: `Move AI instructions from ${sourceName}\n\n${delta.length - 2} files consolidated from ${sourceName}@${sourceSha.slice(0, 12)}.`,
		});
		await pushFastForward(
			target,
			{ sha, expected: targetSha, branch: target.defaultBranch },
			input.signal,
		);
		return { sourceCommitSha: sourceSha, copiedCommitSha: sha };
	} finally {
		await removeSyncRunDir(runDir).catch(() => {});
	}
}

/**
 * Removes `files` from the source repository in one commit on a new branch,
 * and opens (or finds) its pull request into the default branch.
 */
export async function runConsolidationCleanup(input: {
	consolidationId: string;
	projectId: string;
	userId: string;
	organizationId: string | null;
	sourceIntegrationId: string;
	targetRepositoryUrl: string;
	files: readonly ConsolidationFile[];
	author: CommitIdentity;
	committer: CommitIdentity;
	date: string;
	signal: AbortSignal;
}): Promise<{ pullRequestUrl: string | null }> {
	const runDir = await createSyncRunDir();
	try {
		const source = await openWorkspace({
			projectId: input.projectId,
			userId: input.userId,
			organizationId: input.organizationId,
			runDir,
			signal: input.signal,
			integrationId: input.sourceIntegrationId,
			name: "source",
		});
		const adapter = adapterFor(source.target.repository.provider);
		const branch = cleanupBranchName(input.consolidationId);
		const existing = await adapter.findOperation({
			...source.target,
			sourceRef: branch,
		});
		if (existing.kind === "FOUND") {
			return { pullRequestUrl: existing.value.url };
		}

		const sha = await revParseHead({
			dir: source.dir,
			env: source.env,
			signal: input.signal,
		});
		const tree = await treeOf(source, sha, input.signal);
		const removals = input.files
			.filter((file) => tree.has(file.from))
			.map((file) => ({ rawPath: file.from, after: null }));
		if (removals.length === 0) {
			return { pullRequestUrl: null };
		}
		const indexFile = path.join(runDir, "source.index");
		await readBaseTree({
			dir: source.dir,
			env: source.env,
			signal: input.signal,
			sha,
			indexFile,
		});
		const newTree = await writeResolvedTree({
			dir: source.dir,
			env: source.env,
			signal: input.signal,
			indexFile,
			entries: removals,
		});
		const message = [
			"Move AI instructions out of the code repository",
			"",
			`The AI tool files now live in ${input.targetRepositoryUrl} and reach coding tools through the Fabric plugin and MCP server.`,
		].join("\n");
		const commit = await commitTree({
			dir: source.dir,
			env: source.env,
			signal: input.signal,
			tree: newTree,
			parent: sha,
			author: input.author,
			committer: input.committer,
			date: input.date,
			message,
		});
		await pushNewBranch(source, { sha: commit, branch }, input.signal);

		const body = [
			`This removes ${removals.length} AI tool files (instructions, rules, skills, agents, commands and tool settings) from the code repository.`,
			"",
			`They were copied to ${input.targetRepositoryUrl}, which Fabric delivers to coding tools through its plugin and MCP server. After merging, connect your coding tool to Fabric to keep working with them.`,
			"",
			"Files removed:",
			"",
			...removals.slice(0, 200).map((r) => `- \`${r.rawPath}\``),
			...(removals.length > 200
				? [`- ... and ${removals.length - 200} more`]
				: []),
		].join("\n");
		try {
			const opened = await adapter.open({
				...source.target,
				sourceRef: branch,
				targetRef: source.defaultBranch,
				title: "Move AI instructions out of the code repository",
				body,
			});
			return { pullRequestUrl: opened.url };
		} catch (error) {
			if (
				error instanceof InstructionPullRequestError &&
				error.duplicate
			) {
				const found = await adapter.findOperation({
					...source.target,
					sourceRef: branch,
				});
				if (found.kind === "FOUND") {
					return { pullRequestUrl: found.value.url };
				}
			}
			if (error instanceof InstructionPullRequestError) {
				throw new ConsolidationStepError(
					error.code === "AUTHENTICATION_FAILED"
						? "AUTHENTICATION_FAILED"
						: "PULL_REQUEST_FAILED",
					"The cleanup branch was pushed, but its pull request could not be opened. Open it from the branch in the code repository.",
				);
			}
			throw error;
		}
	} finally {
		await removeSyncRunDir(runDir).catch(() => {});
	}
}

export function isRetryableGitFailure(error: unknown): boolean {
	return (
		error instanceof GitCommandError && error.kind !== "invalid_argument"
	);
}
