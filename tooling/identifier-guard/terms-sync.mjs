#!/usr/bin/env node
/**
 * Keeps a developer's local term list current.
 *
 * The list itself cannot live in git — it names real organizations. So it is
 * distributed out of band as `.blocked-terms` at the repo root, and the copy on
 * any given machine silently rots the moment someone extends the shared list.
 * A stale list is worse than an obviously missing one: the hooks still run, so
 * they look like protection while checking against terms that have moved on.
 *
 * The version signal is free. A repository secret's VALUE cannot be read back,
 * but its metadata can, and `updated_at` moves every time the list is changed:
 *
 *   gh api repos/OWNER/REPO/actions/secrets/FABRIC_BLOCKED_TERMS
 *   {"name":"...","created_at":"...","updated_at":"2026-08-03T13:19:11Z"}
 *
 * That timestamp is recorded in `.blocked-terms.stamp` at each sync and
 * compared on the next push. Nothing needs committing when the list grows, and
 * there is no hand-maintained version to forget to bump.
 *
 * Fetching the CONTENT needs a readable source, which the secret is not. Set
 * `FABRIC_TERMS_SOURCE` to one of:
 *
 *   variable:NAME                        a repository Actions variable
 *   repo:OWNER/REPO:path/to/file[@ref]   a file in a private repo
 *
 * With no source configured, staleness is still DETECTED. Detection is the part
 * that matters; the fetch is an ergonomic upgrade that can land whenever the
 * shared source does.
 *
 * Usage:
 *   terms-sync.mjs              sync if needed
 *   terms-sync.mjs --check      report only, write nothing
 *   terms-sync.mjs --accept     record a hand-placed list as current
 *   terms-sync.mjs --bootstrap  install a missing list; never fails
 *
 * Exit codes: 0 current, synced, or unreachable; 3 behind and unfetchable.
 * Never exits non-zero because the network is down — a push must not depend on
 * GitHub being reachable.
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	readFileSync,
	realpathSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = process.env.FABRIC_REPO_ROOT ?? process.cwd();
const TERMS_FILE = resolve(ROOT, ".blocked-terms");
const STAMP_FILE = resolve(ROOT, ".blocked-terms.stamp");
const SECRET_NAME = process.env.FABRIC_TERMS_SECRET ?? "FABRIC_BLOCKED_TERMS";

/**
 * `absent`   no local list — an external contributor or a fresh clone.
 * `fresh`    the copy is at least as new as the shared list.
 * `stale`    the copy is behind and must be replaced before pushing.
 * `unknown`  the shared list could not be reached at all.
 *
 * Staleness is established two ways, recorded in `evidence`. A `stamp` is
 * exact: we know which version was fetched. An `mtime` comparison is the
 * fallback for a list handed over out of band and never synced — a file written
 * before the shared list last changed cannot contain those changes. Re-saving
 * an old list defeats it, which is why `--accept` exists, but it catches the
 * case that actually happens: a copy taken months ago and never touched since.
 *
 * @typedef {"absent" | "fresh" | "stale" | "unknown"} Freshness
 * @typedef {{ state: Freshness, remote?: string, local?: string,
 *   evidence?: "stamp" | "mtime", reason?: string }} State
 */

/**
 * Shell out to `gh`. Returns null on ANY failure — no auth, no network, no gh
 * installed, no access to the repo. Every one of those is indistinguishable
 * from an external contributor, and none of them may block a push.
 *
 * @param {string[]} args
 * @returns {string | null}
 */
function gh(args) {
	try {
		const out = execFileSync("gh", args, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
			timeout: 10_000,
		}).trim();
		return out || null;
	} catch {
		return null;
	}
}

/** @returns {string | null} `owner/repo` of the origin remote */
export function originSlug() {
	let url = "";
	try {
		url = execFileSync("git", ["remote", "get-url", "origin"], {
			cwd: ROOT,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	} catch {
		return null;
	}
	// git@host:owner/repo.git and https://host/owner/repo(.git) both land here.
	const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
	return match ? match[1] : null;
}

/** @returns {string | null} the shared list's last-changed timestamp */
export function remoteStamp() {
	const slug = originSlug();
	if (!slug) {
		return null;
	}
	return gh([
		"api",
		`repos/${slug}/actions/secrets/${SECRET_NAME}`,
		"--jq",
		".updated_at",
	]);
}

/** @returns {string | null} */
export function readStamp() {
	if (!existsSync(STAMP_FILE)) {
		return null;
	}
	return readFileSync(STAMP_FILE, "utf8").trim() || null;
}

/**
 * Decide where the local copy stands, without touching anything.
 *
 * "No list" is checked first and wins outright: presence of the file is what
 * marks a checkout as internal, so its absence is a silent no-op, never a nag.
 *
 * @param {{ remoteStamp?: () => string | null }} [deps] injection seam for tests
 * @returns {State}
 */
export function resolveState(deps = {}) {
	if (!existsSync(TERMS_FILE)) {
		return { state: "absent", reason: "no local term list" };
	}

	const remote = (deps.remoteStamp ?? remoteStamp)();
	if (!remote) {
		return { state: "unknown", reason: "could not reach the shared list" };
	}

	const local = readStamp();
	if (local) {
		return local === remote
			? { state: "fresh", remote, local, evidence: "stamp" }
			: {
					state: "stale",
					remote,
					local,
					evidence: "stamp",
					reason: "the shared list has changed since you synced",
				};
	}

	// No stamp — the ordinary case for a list that was handed over out of band.
	// Fall back to when the file was last written: a copy written before the
	// shared list last changed cannot contain those changes. Weaker than a stamp
	// (re-saving an old list looks current) but it is real evidence, and it is
	// the only evidence available for a machine that has never synced.
	const writtenAt = statSync(TERMS_FILE).mtime;
	if (writtenAt.getTime() < Date.parse(remote)) {
		return {
			state: "stale",
			remote,
			local: writtenAt.toISOString(),
			evidence: "mtime",
			reason: "your copy predates the current list",
		};
	}
	return {
		state: "fresh",
		remote,
		local: writtenAt.toISOString(),
		evidence: "mtime",
	};
}

/**
 * @typedef {{ kind: "variable", name: string }
 *   | { kind: "repo", slug: string, path: string, ref?: string }} Source
 */

/**
 * @param {string | undefined} raw
 * @returns {Source | null}
 */
export function parseSource(raw) {
	if (!raw) {
		return null;
	}
	const variable = raw.match(/^variable:(.+)$/);
	if (variable) {
		return { kind: "variable", name: variable[1].trim() };
	}
	// repo:owner/name:path/to/file@ref — the ref is optional and is split off
	// first so a path containing '@' cannot be mistaken for one.
	const repo = raw.match(/^repo:([^/]+\/[^:]+):([^@]+)(?:@(.+))?$/);
	if (repo) {
		return {
			kind: "repo",
			slug: repo[1].trim(),
			path: repo[2].trim(),
			ref: repo[3]?.trim(),
		};
	}
	return null;
}

/**
 * @param {Source} source
 * @param {{ gh?: (args: string[]) => string | null, slug?: string | null }} [deps]
 * @returns {string | null} the list content
 */
export function fetchList(source, deps = {}) {
	const run = deps.gh ?? gh;
	if (source.kind === "variable") {
		const slug = deps.slug !== undefined ? deps.slug : originSlug();
		return slug
			? run([
					"api",
					`repos/${slug}/actions/variables/${source.name}`,
					"--jq",
					".value",
				])
			: null;
	}
	const query = source.ref ? `?ref=${encodeURIComponent(source.ref)}` : "";
	const encoded = run([
		"api",
		`repos/${source.slug}/contents/${source.path}${query}`,
		"--jq",
		".content",
	]);
	if (!encoded) {
		return null;
	}
	try {
		return Buffer.from(encoded.replace(/\s+/g, ""), "base64").toString(
			"utf8",
		);
	} catch {
		return null;
	}
}

/**
 * Bring the local copy up to date. Writes the stamp only alongside a list it
 * actually wrote, so a failed fetch can never mark a stale list as current.
 *
 * @param {State} state
 * @param {{ fetchList?: typeof fetchList, source?: string }} [deps]
 * @returns {{ synced: boolean, reason?: string }}
 */
export function sync(state, deps = {}) {
	if (!state.remote || state.state !== "stale") {
		return { synced: false };
	}

	const source = parseSource(deps.source ?? process.env.FABRIC_TERMS_SOURCE);
	if (!source) {
		return {
			synced: false,
			reason: "no FABRIC_TERMS_SOURCE is configured",
		};
	}

	const content = (deps.fetchList ?? fetchList)(source);
	if (!content?.trim()) {
		return { synced: false, reason: "the list could not be fetched" };
	}

	writeFileSync(
		TERMS_FILE,
		content.endsWith("\n") ? content : `${content}\n`,
	);
	writeFileSync(STAMP_FILE, `${state.remote}\n`);
	return { synced: true };
}

/**
 * `pnpm install` path. Fetches the list when the machine has none, so a new
 * developer is protected from their first commit without anyone remembering to
 * send them a file. Always returns 0: an install must never fail over this, and
 * on a machine with no access every step below no-ops.
 *
 * @returns {0}
 */
function bootstrap() {
	if (process.env.CI) {
		return 0; // CI reads the secret from the environment; it needs no local file.
	}
	// Installing a MISSING list is the whole job here, so check that before
	// reaching for the network: on the common path the file is already there and
	// every install would otherwise pay for an API call that changes nothing.
	// Keeping an existing list current is the pre-push hook's business.
	if (existsSync(TERMS_FILE)) {
		return 0;
	}
	const remote = remoteStamp();
	if (!remote) {
		return 0;
	}

	const state = /** @type {State} */ ({
		state: "stale",
		remote,
		reason: "not present",
	});
	if (sync(state).synced) {
		console.error("identifier guard — term list installed.");
	}
	return 0;
}

/**
 * Record the current shared version against a list the developer has just put
 * in place by hand. This is what makes the guard useful before any automated
 * source exists: copy the new list in, accept it once, and every later change
 * to the shared list is detected from then on.
 *
 * @returns {0 | 3}
 */
function accept() {
	if (!existsSync(TERMS_FILE)) {
		console.error(
			"identifier guard — no .blocked-terms to accept; put the list in place first.",
		);
		return 3;
	}
	const remote = remoteStamp();
	if (!remote) {
		console.error(
			"identifier guard — could not reach the shared list; nothing recorded.",
		);
		return 3;
	}
	writeFileSync(STAMP_FILE, `${remote}\n`);
	console.error(
		`identifier guard — local list accepted as current (${remote}).`,
	);
	return 0;
}

export function main() {
	if (process.argv.includes("--bootstrap")) {
		return bootstrap();
	}
	if (process.argv.includes("--accept")) {
		return accept();
	}

	const checkOnly = process.argv.includes("--check");
	const state = resolveState();

	if (state.state === "absent" || state.state === "fresh") {
		return 0;
	}

	if (state.state === "unknown") {
		console.error(
			`info: identifier guard — ${state.reason}; using the local list.`,
		);
		return 0;
	}

	if (checkOnly) {
		console.error(
			`identifier guard — term list is out of date: ${state.reason}.`,
		);
		return 3;
	}

	const result = sync(state);
	if (result.synced) {
		console.error("identifier guard — term list updated.");
		return 0;
	}

	console.error("");
	console.error(
		`BLOCKED: your blocked-term list is out of date — ${state.reason}.`,
	);
	console.error(`  It could not be updated automatically: ${result.reason}.`);
	console.error("");
	// Replacing the file is the whole fix: writing it makes it newer than the
	// shared list. Naming a command here previously implied an extra step that
	// does not exist.
	console.error("  Get the current list and replace .blocked-terms.");
	if (parseSource(process.env.FABRIC_TERMS_SOURCE)) {
		console.error("  Or fetch it:            pnpm terms:sync");
	}
	console.error(
		"  Already have it current? pnpm terms:sync --accept   (records the exact version)",
	);
	console.error("  Urgent, deal with it after: git push --no-verify");
	console.error("");
	return 3;
}

// Guarded: this runs at import time, so a throw here would take down every
// caller that only wants the exported functions.
function invokedDirectly() {
	try {
		return (
			!!process.argv[1] &&
			realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
		);
	} catch {
		return false;
	}
}

if (invokedDirectly()) {
	process.exit(main());
}
