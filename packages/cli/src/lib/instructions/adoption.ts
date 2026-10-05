/**
 * What `init` does with the folder it runs in, for a project whose
 * instructions live in a git repository.
 *
 * The folder already is, or should become, a clone of that repository, with
 * its own `.git`: Fabric is an interface on top of it, not a second copy. So
 * `init` never downloads or writes instruction files for such a project.
 *
 *   matching   a clone of the repository, at the right folder: set up the hook
 *   empty      no git checkout and nothing in the folder: offer to clone
 *   anything   else: refuse, and say the one command that gets the person
 *              to a state this can set up
 *
 * Existing files are untouched by construction: nothing here, or in the
 * `matching` path, writes any file but the hook and `.git/info/exclude`.
 */
import path from "node:path";
import type { PublishedInstructionRepository } from "@fabricorg/sdk";
import { CliFailure } from "../command-boundary.js";
import {
	type CheckoutClassification,
	classLine,
	repositoryName,
	shellQuote,
} from "./checkout.js";
import { cloneableUrl } from "./git.js";
import { outcomeFailure } from "./outcome.js";
import { matches, parseRemoteUrl } from "./repository-identity.js";

export type Adoption =
	| { kind: "set-up" }
	| { kind: "empty-folder" }
	| { kind: "refused"; failure: CliFailure };

/** The folder `git clone` would make for the repository: its last path segment. */
export function defaultCloneDirectory(
	repository: Pick<PublishedInstructionRepository, "path">,
): string {
	const last =
		repository.path.split("/").filter(Boolean).at(-1) ?? "repository";
	return last.replace(/\.git$/i, "") || "repository";
}

/**
 * Where to clone the repository from, credential-free, or `null`. The
 * deployment says (`cloneUrl`), and only when that URL names the very
 * repository the person is shown (`provider`, `host`, `path`), on the default
 * port: a clone must never contact a host other than the one in the prompt. A
 * server that does not say, or that has only a legacy value that is not a URL
 * (`null`), is taken at its word for the two providers whose clone URL is just
 * host and path.
 */
export function cloneUrlFor(
	repository: Pick<
		PublishedInstructionRepository,
		"provider" | "host" | "path" | "cloneUrl"
	>,
): string | null {
	if (typeof repository.cloneUrl === "string") {
		const url = cloneableUrl(repository.cloneUrl);
		const parsed = url === null ? null : parseRemoteUrl(url);
		return url !== null &&
			parsed !== null &&
			matches(parsed, repository) === "match"
			? url
			: null;
	}
	if (repository.provider === "GITHUB" || repository.provider === "GITLAB") {
		return cloneableUrl(`https://${repository.host}/${repository.path}`);
	}
	return null;
}

/**
 * The command that gives git credentials for each provider's host.
 *
 * Azure DevOps has no sign-in command for git: `az devops login` only stores a
 * token for the `az devops` commands. Git Credential Manager signs git in the
 * first time a git command reaches the host from a terminal, so the advice is
 * to run `gitCommand` (the clone's `git ls-remote`, a checkout's fetch) there.
 */
export function providerLoginCommand(
	provider: PublishedInstructionRepository["provider"],
	gitCommand: string,
): string {
	switch (provider) {
		case "GITHUB":
			return "gh auth login";
		case "GITLAB":
			return "glab auth login";
		case "AZURE_DEVOPS":
			return gitCommand;
		default:
			return provider satisfies never;
	}
}

/**
 * A folder inside the one the run is about, spelled for a command a person
 * will type: relative to where they are, or, when they gave `--dest`, behind
 * that `--dest` exactly as they typed it. `relative` is relative to the run's
 * folder; a shell-quoted word comes back, `.` for the folder itself.
 */
export function folderForCommand(
	dest: string | undefined,
	relative: string,
): string {
	const inside = relative.split(path.sep).join("/") || ".";
	const typed = dest?.replace(/\\/g, "/").replace(/\/+$/, "");
	return shellQuote(
		typed === undefined || typed === ""
			? inside
			: inside === "."
				? typed
				: `${typed}/${inside}`,
	);
}

export function adoptionFor(input: {
	classification: CheckoutClassification;
	repository: PublishedInstructionRepository | null;
	/** The folder the run is about. */
	destination: string;
	folderEmpty: boolean;
	/**
	 * What a refusal tells the person to run: the project, the one `--tool`
	 * they named, and the `--dest` they typed, if any, which a folder in the
	 * line is spelled behind.
	 */
	rerun: { project: string; tool?: string; dest?: string };
}): Adoption {
	const { classification, repository } = input;
	if (classification.class === "matching") {
		return { kind: "set-up" };
	}
	if (classification.class === "not-git" && input.folderEmpty) {
		return { kind: "empty-folder" };
	}
	const repo =
		repository === null ? "its repository" : repositoryName(repository);
	switch (classification.class) {
		case "not-git":
		case "foreign": {
			const url = repository === null ? null : cloneUrlFor(repository);
			if (repository === null || url === null) {
				return {
					kind: "refused",
					failure: outcomeFailure("no-clone-url", { repo }),
				};
			}
			return {
				kind: "refused",
				failure: outcomeFailure("not-a-clone", {
					repo,
					project: input.rerun.project,
					tool: input.rerun.tool ?? null,
					dir: shellQuote(defaultCloneDirectory(repository)),
				}),
			};
		}
		case "unmapped":
			return {
				kind: "refused",
				failure: outcomeFailure("wrong-folder", {
					repo,
					where: folderForCommand(
						input.rerun.dest,
						path.relative(
							input.destination,
							path.join(
								classification.toplevel,
								classification.rootPath,
							),
						),
					),
				}),
			};
		case "ambiguous":
			return {
				kind: "refused",
				failure: outcomeFailure("several-remotes", {
					repo,
					remotes: classification.remotes,
				}),
			};
		case "unknown":
		case "unknown-identity":
		case "unsupported-provider":
			return {
				kind: "refused",
				failure: new CliFailure(
					classLine(classification, repository),
					7,
				),
			};
		default:
			return classification satisfies never;
	}
}
