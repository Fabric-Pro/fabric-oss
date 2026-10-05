/**
 * Which project a checkout belongs to, found from the checkout itself.
 *
 * `fabric instructions check|sync|init|doctor|push` take `--project` as an
 * override. Without it the answer comes from where the command runs: the
 * work tree, its remotes, the URL each one actually fetches from (after
 * `insteadOf`), the credential-free HTTPS spellings of those, and the
 * deployment's resolver. Several projects can sit on one repository, each
 * with its own folder in it, so the folder the command runs in narrows the
 * answer before anybody is asked.
 *
 * The outcomes are fixed lines (`outcome.ts`); nothing here prints.
 */
import path from "node:path";
import type {
	InstructionCheckoutMatch,
	ResolvedInstructionCheckouts,
} from "@fabricorg/sdk";
import type { CliFailure } from "../command-boundary.js";
import { sameDirectory } from "./checkout.js";
import { sanitizeDisplayText } from "./checks.js";
import * as git from "./git.js";
import { isIdentifier } from "./identifiers.js";
import { outcomeFailure, type ProjectChoice } from "./outcome.js";
import {
	canonicalRemoteCandidates,
	parseRemoteUrl,
} from "./repository-identity.js";

/** What the deployment's resolver accepts in one request: up to 10 URLs of up to 512 characters. */
const MAX_CANDIDATES = 8;
const MAX_CANDIDATE_CHARS = 512;
const MAX_LABEL_CHARS = 80;

interface ResolveDependencies {
	resolveCheckout(
		candidates: string[],
	): Promise<ResolvedInstructionCheckouts>;
	/**
	 * Asks the person which project they mean. Absent when nobody can be
	 * asked (no terminal), which makes several projects a refusal that lists
	 * the `--project` choices.
	 */
	choose?: (projects: ProjectChoice[]) => Promise<number | null>;
}

export interface ResolveInput {
	destination: string;
	/** The verb being run, for the line that says to pass `--project`. */
	verb: string;
	/** Look at this remote only. */
	remote?: string;
	deadline: git.GitDeadline;
	deps: ResolveDependencies;
}

function labelOf(match: InstructionCheckoutMatch): string {
	const where = match.rootPath === "" ? "" : ` (${match.rootPath})`;
	return `${sanitizeDisplayText(match.organizationSlug ?? "personal", MAX_LABEL_CHARS)}/${sanitizeDisplayText(match.projectName, MAX_LABEL_CHARS)}${where}`;
}

function unreadable(
	result: Exclude<git.GitResult<unknown>, { kind: "ok" }>,
): CliFailure {
	return outcomeFailure("unreadable-checkout", {
		reason: result.kind === "absent" ? "not a git checkout" : result.reason,
	});
}

/** The project this checkout's repository is connected to. Throws a `CliFailure` that already says what to do. */
export async function resolveProjectFromCheckout(
	input: ResolveInput,
): Promise<InstructionCheckoutMatch> {
	const { destination, deadline, deps } = input;

	const tree = await git.findWorkTree(destination, deadline);
	if (tree.kind === "absent") {
		throw outcomeFailure("needs-project", { verb: input.verb });
	}
	if (tree.kind !== "ok") {
		throw unreadable(tree);
	}
	const toplevel = tree.value.toplevel;

	const remotes = await git.remotes(toplevel, deadline);
	if (remotes.kind !== "ok") {
		throw unreadable(remotes);
	}
	if (remotes.value.length === 0) {
		throw outcomeFailure("no-remote", { verb: input.verb });
	}
	const names =
		input.remote === undefined
			? remotes.value
			: remotes.value.filter((name) => name === input.remote);
	if (names.length === 0) {
		throw outcomeFailure("remote-missing", {
			remote: sanitizeDisplayText(input.remote ?? "", 100),
		});
	}

	const candidates: string[] = [];
	let identity: string | null = null;
	for (const name of names) {
		const url = await git.effectiveFetchUrl(toplevel, name, deadline);
		if (url.kind !== "ok") {
			throw unreadable(url);
		}
		if (url.value === null) {
			continue;
		}
		const parsed = parseRemoteUrl(url.value);
		if (parsed !== null && identity === null) {
			identity = `${sanitizeDisplayText(parsed.host, 253)}/${sanitizeDisplayText(parsed.path, 300)}`;
		}
		for (const candidate of canonicalRemoteCandidates(url.value)) {
			if (
				candidate.length <= MAX_CANDIDATE_CHARS &&
				!candidates.includes(candidate)
			) {
				candidates.push(candidate);
			}
		}
	}
	if (candidates.length === 0) {
		throw outcomeFailure("not-connected", { identity });
	}

	const { matches } = await deps.resolveCheckout(
		candidates.slice(0, MAX_CANDIDATES),
	);
	// The answer is the deployment's, not ours: an id that is not a plain
	// identifier is refused before it can reach a command line or a line of
	// output, and so is the whole answer it came in.
	if (
		matches.length === 0 ||
		matches.some((match) => !isIdentifier(match.projectId))
	) {
		throw outcomeFailure("not-connected", { identity });
	}

	const here: InstructionCheckoutMatch[] = [];
	for (const match of matches) {
		if (
			await sameDirectory(
				destination,
				path.join(toplevel, match.rootPath),
			)
		) {
			here.push(match);
		}
	}
	const pool = here.length > 0 ? here : matches;
	const only = pool.length === 1 ? pool[0] : undefined;
	if (only !== undefined) {
		return only;
	}

	const choices = pool.map((match) => ({
		id: match.projectId,
		label: labelOf(match),
	}));
	const picked = deps.choose ? await deps.choose(choices) : null;
	const chosen = picked === null ? undefined : pool[picked];
	if (chosen === undefined) {
		throw outcomeFailure("several-projects", { projects: choices });
	}
	return chosen;
}
