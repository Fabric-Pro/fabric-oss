/**
 * What `fabric memory` needs to run for real: a client that never exits the
 * process, the canonical root, and git behind the `MirrorGit` the engine
 * uses.
 *
 * `getClient` calls `printError`, which exits with code 3 when nobody is
 * signed in, correct for every other command and fatal to the hook contract (a
 * hook must never fail the session it runs in). So the sign-in is checked
 * first and a missing one is an error the command can turn into a line.
 */
import path from "node:path";
import type { FabricClient } from "@fabricorg/sdk";
import { getClient } from "../client.js";
import { CliFailure } from "../command-boundary.js";
import { getApiKey, getBaseUrl } from "../config.js";
import * as git from "../instructions/git.js";
import { excludeLocalFiles } from "../instructions/git-exclude.js";
import { isIdentifier } from "../instructions/identifiers.js";
import { resolveExistingRoot } from "../instructions/safe-write.js";
import { DEFAULT_ORIGIN, normalizeOrigin } from "../origin.js";
import type { MirrorContext, MirrorGit } from "./context.js";
import {
	findProjectRoot,
	gitToplevelIsTheProjects,
	type ProjectMarker,
} from "./project-root.js";

/** Milliseconds git may take across one run. */
const GIT_BUDGET_MS = 8_000;

export interface MemoryOptions {
	project?: string;
	baseUrl?: string;
	/** The folder files are mirrored under (default: the working directory). */
	dest?: string;
	hook?: boolean;
}

class MemoryNotSignedIn extends CliFailure {
	constructor(origin: string) {
		super(
			`not signed in to ${origin}. Run: fabric auth login --base-url ${origin}`,
			3,
		);
		this.name = "MemoryNotSignedIn";
	}
}

function originOf(baseUrl: string | undefined): string {
	const origin = normalizeOrigin(baseUrl ?? getBaseUrl() ?? DEFAULT_ORIGIN);
	if (origin === null) {
		throw new CliFailure("--base-url is not a URL", 2);
	}
	return origin;
}

/**
 * Git behind the mirror. With a `marker`, the work tree found at the root must
 * be the one `init` recorded: any other repository (the folder was moved under
 * one, or sits inside an unrelated checkout) is refused before a path in it is
 * listed or an exclude is written.
 */
export function gitFor(root: string, marker?: ProjectMarker): MirrorGit {
	const deadline = () => Date.now() + GIT_BUDGET_MS;
	let toplevel: Promise<string | null> | undefined;
	const find = () => {
		toplevel ??= git.findWorkTree(root, deadline()).then((tree) => {
			if (tree.kind !== "ok") {
				return null;
			}
			if (
				marker !== undefined &&
				!gitToplevelIsTheProjects(marker, root, tree.value.toplevel)
			) {
				throw new CliFailure(
					`${root} is inside the git repository at ${tree.value.toplevel}, which is not the one this project was set up in. Nothing was touched; run \`fabric instructions init --plugin\` here again.`,
					7,
				);
			}
			return tree.value.toplevel;
		});
		return toplevel;
	};
	return {
		async tracked(folders) {
			if ((await find()) === null) {
				return new Set();
			}
			const tracked = await git.trackedPaths(root, folders, deadline());
			return tracked.kind === "ok" ? new Set(tracked.value) : null;
		},
		async exclude(paths) {
			const top = await find();
			if (top === null) {
				return;
			}
			await excludeLocalFiles({
				toplevel: top,
				directory: root,
				files: paths,
				deadline: deadline(),
			});
		},
	};
}

export interface MemoryRuntime {
	context: MirrorContext;
	origin: string;
}

/**
 * The mirror works inside one folder: the nearest one at or above the working
 * directory that `init` marked. A folder under no such marker is refused, and
 * so is a `--project` other than the marked one.
 */
export async function createRuntime(
	options: MemoryOptions,
	signal?: AbortSignal,
): Promise<MemoryRuntime> {
	const origin = originOf(options.baseUrl);
	const start = await resolveExistingRoot(
		path.resolve(options.dest ?? process.cwd()),
	);
	const found = await findProjectRoot(start);
	if (found === null) {
		throw new CliFailure(
			`${start} is not inside a project set up for memory. Run \`fabric instructions init --plugin\` in the project's folder first.`,
			2,
		);
	}
	const { root, marker } = found;
	const projectId = options.project ?? marker.projectId;
	if (projectId !== marker.projectId) {
		throw new CliFailure(
			`${root} was set up for another project than ${projectId}. Run this from that project's own folder.`,
			2,
		);
	}
	if (!isIdentifier(projectId)) {
		throw new CliFailure("--project is not a project id", 2);
	}
	if (!getApiKey(origin, projectId)) {
		throw new MemoryNotSignedIn(origin);
	}
	const client: FabricClient = getClient({
		baseUrl: options.baseUrl,
		project: projectId,
		...(options.hook
			? { timeoutMs: 6_000, retry: { maxRetries: 0 } }
			: { timeoutMs: 30_000 }),
	}).withoutContext();
	return {
		origin,
		context: {
			client,
			projectId,
			root,
			git: gitFor(root, marker),
			signal,
		},
	};
}
