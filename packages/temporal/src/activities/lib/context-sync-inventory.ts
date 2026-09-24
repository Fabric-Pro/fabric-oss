/**
 * The Living Memory sync's tree inventory (design 2026-09-23 §5.3.1 step 4,
 * Fizzy #2657): `git ls-tree -r -z <sha> -- <path>...` with the selected
 * paths as exact pathspecs, streamed and bounded.
 *
 * Not the coding-instructions sync's parser (`instruction-sync-tree.ts`):
 * that one is rooted at one folder and keeps regular files only, counting
 * everything else. This sync needs EVERY entry with its mode — a selected
 * path that is present only as a symlink or a submodule is present, not
 * missing, and a folder's `.contextignore` that is a symlink is a policy
 * failure, not an absent policy — and it lists several selected paths at
 * once.
 *
 * Not re-exported from the activities barrel.
 */
import {
	GIT_SAFE_CONFIG,
	GitCommandError,
	runBoundedProcess,
} from "./instruction-sync-git";

export type ContextInventoryEntry = {
	/**
	 * The repository path. A name that is not valid UTF-8 is decoded lossily
	 * (for matching it to its selected path only) and flagged `utf8: false`:
	 * it can never be a storage key.
	 */
	path: string;
	utf8: boolean;
	/** `100644`, `100755`, `120000` (symlink), `160000` (submodule), … */
	mode: string;
	/** `blob`, or `commit` for a submodule. */
	type: string;
	oid: string;
};

const RECORD = /^(\d{6}) (\w+) ([0-9a-f]{40}(?:[0-9a-f]{24})?)\t$/;
const OBJECT_ID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true });
const LOSSY_UTF8 = new TextDecoder("utf-8");

/**
 * One NUL-free record may hold a path of up to a few KiB; anything longer is
 * hostile, and buffering it would make every chunk a longer scan.
 */
const MAX_RECORD_BYTES = 65_536;

/**
 * A streaming parser: `ls-tree -z` ends every record with NUL and never
 * quotes paths, so a record is `<mode> SP <type> SP <oid> TAB <path>`. The
 * header is split off as bytes before the path is decoded, so a TAB or a
 * non-UTF-8 byte inside a path cannot shift the fields. `push` answers
 * `limit` once more than `maxEntries` records arrived, or one record grew
 * past the record bound.
 */
export function createContextInventoryParser(maxEntries: number): {
	push(chunk: Buffer): "ok" | "limit";
	finish(): ContextInventoryEntry[];
} {
	const entries: ContextInventoryEntry[] = [];
	let seen = 0;
	let pending: Buffer = Buffer.alloc(0);

	const consume = (record: Buffer): void => {
		const tab = record.indexOf(0x09);
		if (tab < 0) {
			return;
		}
		const header = RECORD.exec(
			record.subarray(0, tab + 1).toString("latin1"),
		);
		if (!header) {
			return;
		}
		seen++;
		const raw = record.subarray(tab + 1);
		let path: string;
		let utf8 = true;
		try {
			path = STRICT_UTF8.decode(raw);
		} catch {
			path = LOSSY_UTF8.decode(raw);
			utf8 = false;
		}
		const [, mode, type, oid] = header as unknown as [
			string,
			string,
			string,
			string,
		];
		entries.push({ path, utf8, mode, type, oid });
	};

	return {
		push(chunk) {
			// The NUL search starts where the previous chunk's scan ended, so a
			// long record costs one pass, not one per chunk.
			const previousLength = pending.length;
			pending =
				previousLength === 0 ? chunk : Buffer.concat([pending, chunk]);
			let nul = pending.indexOf(0, previousLength);
			while (nul >= 0) {
				consume(pending.subarray(0, nul));
				pending = pending.subarray(nul + 1);
				if (seen > maxEntries) {
					return "limit";
				}
				nul = pending.indexOf(0);
			}
			return pending.length > MAX_RECORD_BYTES ? "limit" : "ok";
		},
		finish() {
			if (pending.length > 0) {
				consume(pending);
				pending = Buffer.alloc(0);
			}
			return entries;
		},
	};
}

/**
 * Every entry of commit `sha` at or under the selected paths, recursively,
 * without sizes (`-l` would fetch every blob of a blobless clone). `[""]`
 * — the whole repository — lists everything, with no pathspec. The paths
 * follow `--` and git reads them literally (`GIT_LITERAL_PATHSPECS=1` is on
 * `buildGitEnv`'s environment), so none can be an option or a glob.
 * `{ ok: false }` when the tree holds more than `maxEntries` entries: the
 * command is stopped there.
 */
export async function listContextInventory(input: {
	dir: string;
	sha: string;
	paths: readonly string[];
	env: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	maxEntries: number;
}): Promise<{ ok: true; entries: ContextInventoryEntry[] } | { ok: false }> {
	if (!OBJECT_ID.test(input.sha)) {
		throw new GitCommandError("invalid_argument", null, "", "ls-tree");
	}
	const pathspecs = input.paths.includes("") ? [] : [...input.paths];
	const parser = createContextInventoryParser(input.maxEntries);
	let limited = false;
	// The credential rides on the child's environment only; redact it out of
	// any stderr the command leaves, as every git call of the sync does.
	const credential = input.env.FABRIC_GIT_CREDENTIAL;
	await runBoundedProcess({
		command: "git",
		cwd: input.dir,
		args: [
			...GIT_SAFE_CONFIG,
			"ls-tree",
			"-r",
			"-z",
			input.sha,
			...(pathspecs.length === 0 ? [] : ["--", ...pathspecs]),
		],
		env: input.env,
		signal: input.signal,
		label: "ls-tree",
		secrets: credential ? [credential] : [],
		onStdout: (chunk) => {
			if (parser.push(chunk) === "limit") {
				limited = true;
				return "stop";
			}
			return "continue";
		},
	});
	return limited ? { ok: false } : { ok: true, entries: parser.finish() };
}
