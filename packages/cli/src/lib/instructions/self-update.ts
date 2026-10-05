/**
 * The kept copy of the served build brings itself up to date.
 *
 * `init` keeps a copy of the build a deployment serves where the session hook
 * can run it (`hook-launcher.ts`), and until now that copy changed only when
 * somebody ran `init` again, so after a deployment shipped a newer CLI every
 * machine kept running the old one and nothing said so. At the end of a hook
 * run, once the hook's own output is written, this asks the deployment the
 * hook is bound to which CLI it serves now, and when that is a different build
 * from the one running, replaces the copy with it. The new copy runs from the
 * next session.
 *
 * It only ever touches the file it is running from, and only when that file is
 * exactly the copy `init` keeps for this deployment. It trusts what the npx
 * line already trusts (this deployment's code) and nothing beyond it: the
 * deployment's own origin, over https (plain http only for the loopback host a
 * developer runs a deployment on), no redirects, the manifest's integrity hash
 * checked before a byte is unpacked, and nothing executed. Every failure
 * leaves the earlier copy in place. The step is bounded by a budget of its own
 * inside what is left of the hook's deadline (`hook-timing.ts`), runs at most
 * once a day per copy, and is off under `CI` and `FABRIC_CLI_NO_SELF_UPDATE`.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { withDeadline } from "../command-boundary.js";
import { isFlagSet, runningInCi } from "../environment.js";
import { isBundleTarballPath } from "../launcher.js";
import { cliUserAgent } from "../user-agent.js";
import { readBounded } from "./bundle.js";
import { bundleCopyPath, samePath, writeCopy } from "./hook-launcher.js";
import { readPackedFile, TarballError } from "./npm-tarball.js";

/** Set to anything but a way of saying no to leave the kept copy alone. */
export const SELF_UPDATE_OPT_OUT = "FABRIC_CLI_NO_SELF_UPDATE";

/** A copy asks the deployment at most this often. */
export const SELF_UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Beside the copy; says when it last asked and which tarball it was told about. */
const STATE_FILE = "update-check.json";

const MANIFEST_PATH = "/.well-known/fabric-cli.json";
const SPEC = 1;
/** Where `npm pack` puts the staged bundle (`scripts/pack-deployment.mjs`). */
const BUNDLE_ENTRY = "package/fabric.js";
const BUNDLE_BANNER = "#!/usr/bin/env node";
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const TARBALL_NAME = /^\/cli\/fabric-(\d+\.\d+\.\d+)-[0-9a-f]{10}\.tgz$/;

/** A manifest is a few hundred bytes; a tarball of the served build, a few hundred kilobytes. */
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_TARBALL_BYTES = 8 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 24 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 16 * 1024 * 1024;

const LOOPBACK_HOST = /^(localhost|127(?:\.\d{1,3}){3}|\[::1\])$/;

interface SelfUpdateTiming {
	/** The whole step: the manifest, the download and the replacement. */
	budgetMs: number;
	/** What must still be left of the hook's deadline after the budget. */
	marginMs: number;
}

export interface SelfUpdateInput {
	/** The deployment the hook is bound to, as an origin. */
	origin: string;
	/** The file this process runs. */
	script: string;
	/** The CLI's config folder, where `init` keeps the copy. */
	configDirectory: string;
	/** Where the running build says it is served; `undefined` when it is not the served build. */
	runningTarball: string | undefined;
	env: NodeJS.ProcessEnv;
	/** When the hook must be finished, in epoch milliseconds. */
	deadlineAt: number;
	timing: SelfUpdateTiming;
}

export interface SelfUpdateDeps {
	fetchImpl?: typeof fetch;
	now?: () => number;
	/** Writes the new copy; `false` when it could not replace the earlier one. */
	replace?: (bytes: Uint8Array, destination: string) => Promise<boolean>;
}

type SelfUpdateSkip =
	| "opted-out"
	| "ci"
	| "not-a-kept-copy"
	| "insecure-origin"
	| "no-time"
	| "checked-recently"
	| "state-unwritable";

export type SelfUpdateOutcome =
	| { kind: "skipped"; reason: SelfUpdateSkip }
	| { kind: "current" }
	| { kind: "updated"; version: string; tarball: string }
	| { kind: "failed"; reason: string; cause?: unknown };

/** A reason this CLI wrote, short enough for one line. */
class SelfUpdateFailure extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "SelfUpdateFailure";
	}
}

interface UpdateState {
	checkedAt: number;
	tarball: string;
}

interface ServedCli {
	tarball: string;
	integrity: string;
}

function skipped(reason: SelfUpdateSkip): SelfUpdateOutcome {
	return { kind: "skipped", reason };
}

/** Https, or plain http to the machine's own loopback. */
function transportIsSafe(origin: string): boolean {
	const url = new URL(origin);
	return (
		url.protocol === "https:" ||
		(url.protocol === "http:" &&
			(LOOPBACK_HOST.test(url.hostname) ||
				url.hostname.endsWith(".localhost")))
	);
}

/** Why no request should be made at all, or `null` when one may be. */
function reasonToStayQuiet(
	input: SelfUpdateInput,
	now: number,
): SelfUpdateSkip | null {
	if (isFlagSet(input.env[SELF_UPDATE_OPT_OUT])) {
		return "opted-out";
	}
	if (runningInCi(input.env)) {
		return "ci";
	}
	if (!transportIsSafe(input.origin)) {
		return "insecure-origin";
	}
	if (
		input.deadlineAt - now <
		input.timing.budgetMs + input.timing.marginMs
	) {
		return "no-time";
	}
	return null;
}

/** Is `script` the very file `init` keeps for this deployment? */
async function isKeptCopy(script: string, copy: string): Promise<boolean> {
	const actual = await realpath(copy).catch(() => null);
	if (actual === null) {
		return false;
	}
	const running = await realpath(script).catch(() => path.resolve(script));
	return samePath(running, actual);
}

async function readState(file: string): Promise<UpdateState | null> {
	try {
		const parsed = JSON.parse(await readFile(file, "utf8")) as Partial<
			Record<keyof UpdateState, unknown>
		>;
		return typeof parsed.checkedAt === "number" &&
			Number.isFinite(parsed.checkedAt) &&
			typeof parsed.tarball === "string"
			? { checkedAt: parsed.checkedAt, tarball: parsed.tarball }
			: null;
	} catch {
		return null;
	}
}

async function writeState(file: string, state: UpdateState): Promise<boolean> {
	try {
		await mkdir(path.dirname(file), { recursive: true });
		await writeFile(file, `${JSON.stringify(state)}\n`);
		return true;
	} catch {
		return false;
	}
}

/** A clock set backwards must not hold the check off for ever. */
function askedRecently(state: UpdateState, now: number): boolean {
	const elapsed = now - state.checkedAt;
	return elapsed >= 0 && elapsed < SELF_UPDATE_INTERVAL_MS;
}

async function download(
	url: string,
	maxBytes: number,
	signal: AbortSignal,
	fetchImpl: typeof fetch,
): Promise<Uint8Array> {
	let response: Response;
	try {
		response = await fetchImpl(url, {
			signal,
			redirect: "error",
			headers: { "user-agent": cliUserAgent() },
		});
	} catch (error) {
		throw new SelfUpdateFailure("the deployment could not be reached", {
			cause: error,
		});
	}
	if (!response.ok) {
		throw new SelfUpdateFailure(
			`the deployment answered HTTP ${response.status}`,
		);
	}
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new SelfUpdateFailure("the download is larger than allowed");
	}
	return readBounded(
		response,
		maxBytes,
		() => new SelfUpdateFailure("the download is larger than allowed"),
	);
}

/**
 * Which build the deployment serves. The document says where as a full URL
 * (`discoveryDocumentFor`); only its path is read, and it is asked for on the
 * origin the hook is bound to, never on a host the document names.
 */
function parseServedCli(document: unknown, origin: string): ServedCli {
	const record =
		typeof document === "object" && document !== null
			? (document as Record<string, unknown>)
			: {};
	if (record.spec !== SPEC) {
		throw new SelfUpdateFailure(
			"the deployment describes its CLI in a form this one does not read",
		);
	}
	const { tarball, integrity } = record;
	let served: string | null = null;
	if (typeof tarball === "string") {
		try {
			served = new URL(tarball, origin).pathname;
		} catch {
			served = null;
		}
	}
	if (
		served === null ||
		!isBundleTarballPath(served) ||
		typeof integrity !== "string" ||
		!INTEGRITY.test(integrity)
	) {
		throw new SelfUpdateFailure(
			"the deployment's CLI description is not one this CLI reads",
		);
	}
	return { tarball: served, integrity };
}

function unpackBundle(tarball: Uint8Array): Uint8Array {
	let bundle: Uint8Array;
	try {
		bundle = readPackedFile(tarball, BUNDLE_ENTRY, {
			maxUnpackedBytes: MAX_UNPACKED_BYTES,
			maxFileBytes: MAX_BUNDLE_BYTES,
		});
	} catch (error) {
		if (error instanceof TarballError) {
			throw new SelfUpdateFailure(
				error.kind === "missing"
					? "the download does not hold the CLI where it should"
					: error.kind === "too-large"
						? "the download unpacks to more than allowed"
						: "the download is not a package this CLI can read",
				{ cause: error },
			);
		}
		throw error;
	}
	if (
		!Buffer.from(bundle.subarray(0, BUNDLE_BANNER.length))
			.toString("latin1")
			.startsWith(BUNDLE_BANNER)
	) {
		throw new SelfUpdateFailure("the download is not a runnable CLI");
	}
	return bundle;
}

interface Attempt {
	input: SelfUpdateInput;
	copy: string;
	stateFile: string;
	now: () => number;
	fetchImpl: typeof fetch;
	replace: (bytes: Uint8Array, destination: string) => Promise<boolean>;
	signal: AbortSignal;
	running: string;
}

async function attempt({
	input,
	copy,
	stateFile,
	now,
	fetchImpl,
	replace,
	signal,
	running,
}: Attempt): Promise<SelfUpdateOutcome> {
	const manifest = await download(
		`${input.origin}${MANIFEST_PATH}`,
		MAX_MANIFEST_BYTES,
		signal,
		fetchImpl,
	);
	let document: unknown;
	try {
		document = JSON.parse(Buffer.from(manifest).toString("utf8"));
	} catch {
		throw new SelfUpdateFailure(
			"the deployment's CLI description is not JSON",
		);
	}
	const served = parseServedCli(document, input.origin);
	await writeState(stateFile, { checkedAt: now(), tarball: served.tarball });
	if (served.tarball === running) {
		return { kind: "current" };
	}

	const tarball = await download(
		`${input.origin}${served.tarball}`,
		MAX_TARBALL_BYTES,
		signal,
		fetchImpl,
	);
	const digest = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
	if (digest !== served.integrity) {
		throw new SelfUpdateFailure(
			"the download does not match the integrity hash the deployment published",
		);
	}
	const bundle = unpackBundle(tarball);
	signal.throwIfAborted();
	if (!(await replace(bundle, copy))) {
		throw new SelfUpdateFailure("the copy is in use");
	}
	return {
		kind: "updated",
		version: TARBALL_NAME.exec(served.tarball)?.[1] ?? "a newer build",
		tarball: served.tarball,
	};
}

/**
 * Ask the hook's deployment whether it serves a newer build than the one
 * running, and replace the kept copy when it does. Never throws and never
 * writes to stdout: the answer is for the caller to turn into at most one line
 * on stderr (`selfUpdateLine`).
 */
export async function refreshKeptCopy(
	input: SelfUpdateInput,
	deps: SelfUpdateDeps = {},
): Promise<SelfUpdateOutcome> {
	const now = deps.now ?? Date.now;
	const quiet = reasonToStayQuiet(input, now());
	if (quiet !== null) {
		return skipped(quiet);
	}
	const running = input.runningTarball;
	if (running === undefined) {
		return skipped("not-a-kept-copy");
	}
	const copy = bundleCopyPath(input.configDirectory, input.origin);
	if (!(await isKeptCopy(input.script, copy))) {
		return skipped("not-a-kept-copy");
	}

	// The slot is claimed before anything is asked, so two sessions that start
	// together do not both download, and a deployment that is slow or down is
	// asked once a day rather than at every session start.
	const stateFile = path.join(path.dirname(copy), STATE_FILE);
	const previous = await readState(stateFile);
	if (previous !== null && askedRecently(previous, now())) {
		return skipped("checked-recently");
	}
	if (
		!(await writeState(stateFile, { checkedAt: now(), tarball: running }))
	) {
		return skipped("state-unwritable");
	}

	let signal: AbortSignal | undefined;
	let outcome: SelfUpdateOutcome = { kind: "current" };
	try {
		await withDeadline(input.timing.budgetMs, async (deadline) => {
			signal = deadline;
			outcome = await attempt({
				input,
				copy,
				stateFile,
				now,
				fetchImpl: deps.fetchImpl ?? fetch,
				replace: deps.replace ?? writeCopy,
				signal: deadline,
				running,
			});
		});
	} catch (error) {
		if (signal?.aborted) {
			return {
				kind: "failed",
				reason: "it ran out of time",
				cause: error,
			};
		}
		return error instanceof SelfUpdateFailure
			? { kind: "failed", reason: error.message, cause: error.cause }
			: {
					kind: "failed",
					reason: "it failed unexpectedly",
					cause: error,
				};
	}
	return outcome;
}

/** The one line on stderr that says what happened, or `null` when nothing is worth saying. */
export function selfUpdateLine(outcome: SelfUpdateOutcome): string | null {
	switch (outcome.kind) {
		case "skipped":
		case "current":
			return null;
		case "updated":
			return `fabric: this CLI copy was updated to ${outcome.version}; it runs from the next session`;
		case "failed":
			return `fabric: this CLI copy was not updated (${outcome.reason}); the earlier copy was kept`;
		default: {
			const unreachable: never = outcome;
			return unreachable;
		}
	}
}
