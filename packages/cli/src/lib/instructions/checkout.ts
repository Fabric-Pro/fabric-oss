/**
 * What kind of directory a repository-sourced project's hook is running in,
 * and what it should say there (Fizzy #2708).
 *
 * A project whose coding instructions come from a git repository publishes a
 * snapshot from one commit on one branch. In a checkout of that repository
 * the files already arrive with `git pull`, so the hook's job there is to
 * REPORT — "the published commit is not in your history yet" — and never to
 * write: no download, no lock, no git command that changes anything.
 * Automatic fast-forwarding is separate work and not part of this module.
 *
 * Elsewhere — a directory that is not a git checkout at all — the project's
 * published snapshot is the only way to read its instructions, so the upload
 * behaviour applies unchanged. Everything in between (a checkout of some
 * other repository, one this cannot read, one with two remotes for the same
 * repository, the right repository in the wrong directory) gets one line
 * saying which case it is, and nothing is written.
 *
 * `classifyCheckout` decides which case; `inspectMatchingCheckout` gathers the
 * facts for the matching one; `matchingReportLine` and `classLine` are the
 * pure halves that turn those into the one line a session reads.
 */
import { realpath } from "node:fs/promises";
import path from "node:path";
import type {
	PublishedInstructionRepository,
	PublishedInstructionSnapshot,
} from "@fabricorg/sdk";
import { sanitizeDisplayText } from "./checks.js";
import type { CheckoutTraits, GitDeadline, GitOperation } from "./git.js";
import * as git from "./git.js";
import { matches, parseRemoteUrl } from "./repository-identity.js";

type CheckoutClass =
	| "not-git"
	| "unknown"
	| "unknown-identity"
	| "unsupported-provider"
	| "foreign"
	| "ambiguous"
	| "unmapped"
	| "matching";

export type CheckoutClassification =
	| { class: "not-git" }
	| { class: "unknown"; reason: string }
	| { class: "unknown-identity" }
	| { class: "unsupported-provider"; provider: string }
	| { class: "foreign" }
	| { class: "ambiguous"; remotes: string[] }
	| { class: "unmapped"; rootPath: string }
	| {
			class: "matching";
			remote: string;
			toplevel: string;
			traits: CheckoutTraits;
	  };

/** Everything the matching report reads from the checkout. */
export interface CheckoutState {
	/** The checked-out branch, or `null` for a detached HEAD. */
	branch: string | null;
	head: string | null;
	clean: boolean;
	operation: GitOperation | null;
	traits: CheckoutTraits;
}

/** `check --format json`'s `checkout` block. */
export interface CheckoutJson {
	class: CheckoutClass;
	remote?: string;
	branch?: string | null;
	head?: string | null;
	clean?: boolean;
	operation?: GitOperation | null;
	/**
	 * Whether the published commit is in HEAD's history: `null` when git
	 * could not say (normally, it has not been fetched yet). Absent when
	 * there was no repository-built, current snapshot to look for.
	 */
	contains?: boolean | null;
	traits: Array<keyof CheckoutTraits>;
	/** The line printed for this checkout, or `null` when it is current. */
	line: string | null;
}

export interface CheckoutReport {
	classification: CheckoutClassification;
	/** Only in the matching class. */
	state: CheckoutState | null;
	contains: boolean | null | undefined;
	line: string | null;
	json: CheckoutJson;
}

const PREFIX = "fabric: coding instructions";

/** Display bounds for every interpolated identifier. */
const MAX = { host: 253, path: 300, ref: 200, remote: 100, reason: 200 };

/**
 * Classes in which the upload behaviour (download and lock) still applies:
 * a directory that is not a git checkout at all, and — only when a person
 * runs `sync` by hand, deliberately — a checkout of some OTHER repository.
 * Everything else fails closed in every mode: a checkout of the repository
 * itself (git keeps it current), and every case where this cannot tell
 * whether it is one (unknown, unknown repository, unsupported provider,
 * ambiguous, unmapped).
 */
export function downloadsIn(
	classification: CheckoutClassification,
	manual: boolean,
): boolean {
	if (classification.class === "not-git") {
		return true;
	}
	return manual && classification.class === "foreign";
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function isSafeRootPath(rootPath: string): boolean {
	if (
		path.posix.isAbsolute(rootPath) ||
		path.win32.isAbsolute(rootPath) ||
		rootPath.startsWith("~")
	) {
		return false;
	}
	return !rootPath.split(/[\\/]/).some((segment) => segment === "..");
}

async function sameDirectory(a: string, b: string): Promise<boolean> {
	const [left, right] = await Promise.all([
		realpath(a).catch(() => null),
		realpath(b).catch(() => null),
	]);
	return left !== null && left === right;
}

/**
 * Which of the eight cases `destination` is, for this project's CURRENT
 * repository configuration. Never throws for anything git or the filesystem
 * can do; an unexpected failure is `unknown`.
 */
export async function classifyCheckout(input: {
	destination: string;
	repository: PublishedInstructionRepository | null | undefined;
	deadline: GitDeadline;
}): Promise<CheckoutClassification> {
	try {
		return await classify(input);
	} catch {
		return { class: "unknown", reason: "the checkout could not be read" };
	}
}

async function classify({
	destination,
	repository,
	deadline,
}: {
	destination: string;
	repository: PublishedInstructionRepository | null | undefined;
	deadline: GitDeadline;
}): Promise<CheckoutClassification> {
	const tree = await git.findWorkTree(destination, deadline);
	if (tree.kind === "absent") {
		return { class: "not-git" };
	}
	if (tree.kind === "unavailable") {
		return { class: "unknown", reason: tree.reason };
	}
	if (!repository) {
		return { class: "unknown-identity" };
	}
	if (repository.provider !== "GITHUB" && repository.provider !== "GITLAB") {
		return {
			class: "unsupported-provider",
			provider: String(repository.provider),
		};
	}
	const root = tree.value.toplevel;
	if (!isSafeRootPath(repository.rootPath)) {
		return {
			class: "unknown",
			reason: "the project's instruction folder is not a path inside the repository",
		};
	}
	const refOk = await git.checkRefFormat(root, repository.ref, deadline);
	if (refOk.kind !== "ok") {
		return {
			class: "unknown",
			reason:
				refOk.kind === "absent" ? "not a git checkout" : refOk.reason,
		};
	}
	if (!refOk.value) {
		return {
			class: "unknown",
			reason: "the project's branch name is not one this hook will use",
		};
	}

	const names = await git.remotes(root, deadline);
	if (names.kind !== "ok") {
		return {
			class: "unknown",
			reason:
				names.kind === "absent" ? "not a git checkout" : names.reason,
		};
	}
	const matching: string[] = [];
	for (const name of names.value) {
		const url = await git.effectiveFetchUrl(root, name, deadline);
		if (url.kind !== "ok") {
			return {
				class: "unknown",
				reason:
					url.kind === "absent" ? "not a git checkout" : url.reason,
			};
		}
		if (url.value === null) {
			continue;
		}
		const parsed = parseRemoteUrl(url.value);
		if (parsed && matches(parsed, repository) === "match") {
			matching.push(name);
		}
	}
	if (matching.length === 0) {
		return { class: "foreign" };
	}
	if (matching.length > 1) {
		return { class: "ambiguous", remotes: matching };
	}

	const mapped = path.join(root, repository.rootPath);
	if (!(await sameDirectory(destination, mapped))) {
		return { class: "unmapped", rootPath: repository.rootPath };
	}
	const traits = await git.checkoutTraits(root, deadline);
	if (traits.kind !== "ok") {
		return {
			class: "unknown",
			reason:
				traits.kind === "absent" ? "not a git checkout" : traits.reason,
		};
	}
	return {
		class: "matching",
		remote: matching[0] as string,
		toplevel: root,
		traits: traits.value,
	};
}

// ---------------------------------------------------------------------------
// The matching class: facts, then the line
// ---------------------------------------------------------------------------

/**
 * Read the checkout and decide the line. `snapshot` is the published one;
 * its `source` says which commit it was built from, when it was built from
 * the repository at all.
 */
async function inspectMatchingCheckout(input: {
	classification: Extract<CheckoutClassification, { class: "matching" }>;
	repository: PublishedInstructionRepository;
	snapshot: PublishedInstructionSnapshot | undefined;
	deadline: GitDeadline;
}): Promise<CheckoutReport> {
	const { classification, repository, snapshot, deadline } = input;
	const root = classification.toplevel;
	const unknown = (reason: string): CheckoutReport =>
		reportFor(repository, { class: "unknown", reason });

	const branch = await git.currentBranch(root, deadline);
	if (branch.kind !== "ok") {
		return unknown(
			branch.kind === "absent" ? "not a git checkout" : branch.reason,
		);
	}
	const head = await git.headSha(root, deadline);
	if (head.kind !== "ok") {
		return unknown(
			head.kind === "absent" ? "not a git checkout" : head.reason,
		);
	}
	const clean = await git.isClean(root, deadline);
	if (clean.kind !== "ok") {
		return unknown(
			clean.kind === "absent" ? "not a git checkout" : clean.reason,
		);
	}
	const operation = await git.operationInProgress(root, deadline);
	if (operation.kind !== "ok") {
		return unknown(
			operation.kind === "absent"
				? "not a git checkout"
				: operation.reason,
		);
	}
	const state: CheckoutState = {
		branch: branch.value,
		head: head.value,
		clean: clean.value,
		operation: operation.value,
		traits: classification.traits,
	};

	const source = snapshot?.source;
	let contains: boolean | null | undefined;
	if (
		snapshot &&
		source?.kind === "REPOSITORY" &&
		source.current &&
		git.isCommitSha(source.commitSha)
	) {
		if (state.head === null) {
			contains = null;
		} else {
			const answer = await git.isAncestor(
				root,
				source.commitSha,
				state.head,
				deadline,
			);
			contains = answer.kind === "ok" ? answer.value : null;
		}
	}

	const line = matchingReportLine({
		repository,
		remote: classification.remote,
		snapshot: snapshot
			? { version: snapshot.version, source: snapshot.source }
			: null,
		state,
		contains,
	});
	return {
		classification,
		state,
		contains,
		line,
		json: {
			class: "matching",
			remote: classification.remote,
			branch: state.branch,
			head: state.head,
			clean: state.clean,
			operation: state.operation,
			...(contains !== undefined ? { contains } : {}),
			traits: traitNames(state.traits),
			line,
		},
	};
}

/** The report for a class that is not `matching`: its line, nothing read. */
export function reportFor(
	repository: PublishedInstructionRepository | null | undefined,
	classification: Exclude<CheckoutClassification, { class: "matching" }>,
): CheckoutReport {
	const line =
		classification.class === "not-git"
			? null
			: classLine(classification, repository ?? null);
	return {
		classification,
		state: null,
		contains: undefined,
		line,
		json: { class: classification.class, traits: [], line },
	};
}

function traitNames(traits: CheckoutTraits): Array<keyof CheckoutTraits> {
	return (["shallow", "sparse", "superproject"] as const).filter(
		(trait) => traits[trait],
	);
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX single-quoting, the rule doctor's generated commands use. */
function shellQuote(value: string): string {
	if (value.length > 0 && SHELL_SAFE.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function show(value: string, max: number): string {
	return sanitizeDisplayText(value, max);
}

function repositoryName(repository: { host: string; path: string }): string {
	return `${show(repository.host, MAX.host)}/${show(repository.path, MAX.path)}`;
}

/**
 * The one line for the matching class, or `null` when the checkout already
 * holds the published commit. The decision table, over plain data.
 */
export function matchingReportLine(input: {
	repository: Pick<PublishedInstructionRepository, "host" | "path" | "ref">;
	remote: string;
	snapshot: {
		version: number;
		source?: PublishedInstructionSnapshot["source"];
	} | null;
	state: CheckoutState;
	/** `undefined` when not evaluated; `null` when git could not say. */
	contains: boolean | null | undefined;
}): string | null {
	const { repository, remote, snapshot, state, contains } = input;
	const name = repositoryName(repository);
	const ref = show(repository.ref, MAX.ref);
	const source = snapshot?.source;

	if (!snapshot || source?.kind !== "REPOSITORY") {
		return `${PREFIX}: the project is repository-sourced but nothing has been published from ${name} yet`;
	}
	const version = Number(snapshot.version);
	if (!source.current) {
		return `${PREFIX} v${version} was published from ${show(source.ref, MAX.ref)}; the project now syncs ${ref} of ${name} — pull ${ref} to pick up the next publication`;
	}
	if (contains === true) {
		return null;
	}

	const sha7 = show(source.commitSha.slice(0, 7), 7);
	const behind =
		contains === false
			? "this checkout is behind"
			: "this checkout has not fetched it yet";
	const base = `${PREFIX} v${version} (${sha7}) is published on ${ref} of ${name}; ${behind}`;

	let advice: string;
	if (state.operation !== null) {
		// Before the branch: a rebase detaches HEAD, and "check out the
		// branch" is the wrong advice in the middle of one.
		advice = `; a ${state.operation} is in progress`;
	} else if (state.branch === null) {
		advice = `; HEAD is detached — check out ${ref} and pull`;
	} else if (state.branch !== repository.ref) {
		advice = `; you are on ${show(state.branch, MAX.ref)} — pull ${ref} when you switch to it`;
	} else if (!state.clean) {
		advice = "; your working tree has changes — pull when it is clean";
	} else {
		const pull = [
			"git",
			"pull",
			"--ff-only",
			shellQuote(show(remote, MAX.remote)),
			shellQuote(ref),
		].join(" ");
		advice = ` — run: ${pull}`;
	}

	const traits = traitNames(state.traits).map(
		(trait) =>
			({
				shallow: " (shallow clone)",
				sparse: " (sparse checkout)",
				superproject: " (inside a superproject)",
			})[trait],
	);
	return `${base}${advice}${traits.join("")}`;
}

/** The one line for every class that is neither `matching` nor `not-git`. */
export function classLine(
	classification: Exclude<
		CheckoutClassification,
		{ class: "matching" } | { class: "not-git" }
	>,
	repository: Pick<PublishedInstructionRepository, "host" | "path"> | null,
): string {
	const name = repository ? repositoryName(repository) : "its repository";
	const tail = "nothing was checked or changed";
	switch (classification.class) {
		case "foreign":
			return `${PREFIX}: no remote of this checkout fetches from ${name} (foreign checkout); ${tail}`;
		case "ambiguous":
			return `${PREFIX}: remotes ${classification.remotes
				.map((remote) => show(remote, MAX.remote))
				.join(
					", ",
				)} all fetch from ${name} (ambiguous checkout); ${tail}`;
		case "unmapped": {
			const where =
				classification.rootPath === ""
					? "the repository root"
					: show(classification.rootPath, MAX.path);
			return `${PREFIX}: this checkout is ${name}, but the project's instructions are at ${where}, not this directory (unmapped checkout); ${tail}`;
		}
		case "unknown":
			return `${PREFIX}: this git checkout could not be read (${show(classification.reason, MAX.reason)}; unknown checkout); ${tail}`;
		case "unknown-identity":
			return `${PREFIX}: the project is repository-sourced but reports no repository to compare with (unknown repository); ${tail}`;
		case "unsupported-provider":
			return `${PREFIX}: ${show(classification.provider, 32)} repositories are not compared yet (unsupported provider); ${tail}`;
	}
}

/**
 * Classify, then — in the matching class — read the checkout. The one entry
 * point `check`, `sync` and doctor share, so all three say the same thing.
 */
export async function inspectCheckout(input: {
	destination: string;
	repository: PublishedInstructionRepository | null | undefined;
	snapshot: PublishedInstructionSnapshot | undefined;
	deadline: GitDeadline;
}): Promise<CheckoutReport> {
	const classification = await classifyCheckout(input);
	return reportForClassification({ ...input, classification });
}

/** The report for a classification already made. */
export async function reportForClassification(input: {
	classification: CheckoutClassification;
	repository: PublishedInstructionRepository | null | undefined;
	snapshot: PublishedInstructionSnapshot | undefined;
	deadline: GitDeadline;
}): Promise<CheckoutReport> {
	const { classification, repository } = input;
	if (classification.class !== "matching") {
		return reportFor(repository, classification);
	}
	if (!repository) {
		return reportFor(repository, { class: "unknown-identity" });
	}
	try {
		return await inspectMatchingCheckout({
			...input,
			classification,
			repository,
		});
	} catch {
		return reportFor(repository, {
			class: "unknown",
			reason: "the checkout could not be read",
		});
	}
}

/**
 * What a person running `sync` by hand reads when the matching checkout
 * already holds the published commit — the case the hook stays silent for.
 */
export function currentLine(
	repository: Pick<PublishedInstructionRepository, "host" | "path" | "ref">,
	snapshot: Pick<PublishedInstructionSnapshot, "version" | "source">,
): string {
	const source = snapshot.source;
	const sha7 =
		source?.kind === "REPOSITORY"
			? ` (${show(source.commitSha.slice(0, 7), 7)})`
			: "";
	return `${PREFIX} v${Number(snapshot.version)}${sha7} from ${show(repository.ref, MAX.ref)} of ${repositoryName(repository)} is already in this checkout's history; nothing to sync`;
}

/**
 * `init`'s line for a checkout of the repository: the hook it wrote reports
 * and never changes anything.
 */
export function installedLine(
	repository: Pick<PublishedInstructionRepository, "host" | "path" | "ref">,
	apply: boolean,
): string {
	const base = `installed; this checkout is ${repositoryName(repository)}: the hook reports when ${show(repository.ref, MAX.ref)} has newer instructions and never changes the checkout`;
	return apply
		? `${base} — automatic updates are not available for repository checkouts yet; the hook reports and you (or your agent) run the pull`
		: base;
}

/** `init`'s note when nothing has been published from the repository yet. */
export function nothingPublishedLine(
	repository: Pick<PublishedInstructionRepository, "host" | "path">,
): string {
	return `Nothing has been published from ${repositoryName(repository)} yet; the hook reports once it is.`;
}
