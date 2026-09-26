/**
 * What `fabric instructions push` would send, decided against the LOCAL TREE
 * and the lock together.
 *
 * ## What a push owns
 *
 * Exactly what `sync` owns: the paths in `.fabric/instructions.lock`. That is
 * not a simplification, it is the only defensible rule available here. `sync`
 * has no include/exclude vocabulary of its own — it writes what the manifest
 * names and remembers it in the ledger (`plan.ts`), and the exclusion rules
 * that decide what a snapshot may hold live server-side in
 * `@repo/instructions`, a package this published CLI cannot depend on. So a
 * tree walk would have to invent a rule about which of a checkout's files are
 * instruction files, and getting that wrong means uploading somebody's source
 * tree into their project's coding instructions.
 *
 * Three outcomes per locked path, and nothing else is ever sent:
 *
 *   put      local bytes differ from the hash the lock recorded
 *   delete   the lock names it and nothing is there any more
 *   (skip)   local bytes still equal the lock — there is nothing to say
 *
 * ## Adding a file the lock does not name
 *
 * By `--add <path>`, explicitly, one flag per file. A new file is the one case
 * the ledger cannot discover, and naming it is both unambiguous and honest
 * about what the tool knows. The path goes through the same refusals a locked
 * one does — no traversal, no reserved root, no symlinked component — and must
 * actually be a regular file.
 *
 * ## What an open proposal already carries is not sent again
 *
 * The lock names the PUBLISHED version, and a proposal does not change what
 * is published. So the diff above cannot tell an edit this checkout already
 * proposed from a new one: a second session pushing an unrelated edit would
 * send the first session's change again, and its proposal (or pull request)
 * would carry it twice (Fizzy #2739). `setAsideProposed` takes those out of
 * the plan, by the rule on `carryingProposals`; `--include-proposed` skips it.
 *
 * ## Reads are guarded exactly as writes are
 *
 * Every read goes through `readFileSafely`, the same per-segment walk `sync`
 * writes through: nothing resolving outside the destination, no symlinked
 * component anywhere on the way down, a regular file or nothing at all at the
 * end. A push reads files and sends their contents to a server, so a symlink
 * standing where an instruction file belongs is a way to exfiltrate whatever
 * it points at — the one thing this command must not do.
 */
import { createHash } from "node:crypto";
import type {
	InstructionChange,
	InstructionManifestEntry,
	OpenInstructionProposal,
	ProposalPullRequestState,
} from "@fabricorg/sdk";
import type { InstructionsLock } from "./lock.js";
import {
	checkRelativePath,
	describeRejection,
	findCollision,
	isReservedPath,
} from "./paths.js";
import { readFileSafely } from "./safe-write.js";

/** The server's own cap on one change set (`MAX_CHANGES`), mirrored so the refusal happens before the request. */
export const MAX_PUSH_CHANGES = 50;

type PushChangeAction = "put" | "delete";

interface PushPlanEntry {
	path: string;
	action: PushChangeAction;
	/** Present on a `put`: the size of the bytes to send. */
	size?: number;
	/** Present on a `put`: the sha256 of the bytes to send, hex. */
	sha256?: string;
}

export interface PushPlan {
	entries: PushPlanEntry[];
	/** The change set exactly as the request carries it. */
	changes: InstructionChange[];
	/** Locked paths whose bytes still match the ledger. Reported, never sent. */
	unchanged: string[];
}

/**
 * Whether a path is one this tool will read or name at all.
 *
 * The same two refusals `plan.ts` applies to a lock's ledger, for the same
 * reason: the lock is an unauthenticated file in the checkout, and `.git/**`,
 * `.fabric/**` and the tool's own Claude settings file are exactly the paths a
 * tampered one would most want to name — here so it could read them out.
 */
function assertPushablePath(candidate: string, source: string): void {
	const check = checkRelativePath(candidate);
	if (!check.ok) {
		throw new Error(
			`Refusing to push: ${describeRejection(check)}. ${source}`,
		);
	}
	if (isReservedPath(candidate)) {
		throw new Error(
			`Refusing to push: ${describeRejection({
				ok: false,
				reason: "reserved_path",
				detail: candidate,
			})}. ${source}`,
		);
	}
}

/**
 * How a file's bytes travel in the request.
 *
 * UTF-8 when the bytes are valid UTF-8 and survive the round trip, base64
 * otherwise. Preferring text is not cosmetic: an instruction tree is markdown
 * and JSON, base64 costs a third more request body against a bounded limit,
 * and a readable payload is a readable failure when something goes wrong.
 *
 * The round trip is the test rather than a heuristic on the bytes, because
 * `TextDecoder` replaces anything invalid with U+FFFD silently — a file that
 * "decoded fine" would have been sent with its bad bytes rewritten.
 */
function encodeContent(bytes: Uint8Array): {
	content: string;
	encoding: "utf8" | "base64";
} {
	const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
	const roundTrip = new TextEncoder().encode(text);
	if (
		roundTrip.length === bytes.length &&
		roundTrip.every((byte, index) => byte === bytes[index])
	) {
		return { content: text, encoding: "utf8" };
	}
	return {
		content: Buffer.from(bytes).toString("base64"),
		encoding: "base64",
	};
}

function sha256Of(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The one refusal every stale- or tampered-ledger case shares.
 *
 * Same sentence, same instruction, whichever direction the disagreement was
 * found in: the ledger is not the published version, and the fix is local.
 */
function refuseStaleLedger(detail: string): never {
	throw new Error(
		`Refusing to push: the sync lock does not match the published version — ${detail}. Run \`fabric instructions sync\` and try again. Nothing was read and nothing was sent.`,
	);
}

/**
 * Refuse unless the lock describes EXACTLY the published version it names.
 *
 * Both directions are checked, and they catch different things.
 *
 * An EXTRA path — one the ledger claims and the manifest does not — is the
 * attack: it is how a file that was never part of the instructions gets read
 * and sent.
 *
 * A MISSING one — published, absent from the ledger — is the quiet half. The
 * diff below only ever walks what the lock names, so deleting an entry from
 * the ledger makes that file invisible to this command: a local edit to it is
 * dropped from the proposal, a local deletion of it is never reported, and a
 * checkout with one file changed can report "Nothing to push". Neither is
 * loud, and both produce a proposal that is not the diff it claims to be.
 *
 * A DIFFERENT hash is neither of those and just as unusable: the diff is "what
 * changed since the last sync", and a ledger that disagrees with the version
 * it claims to record cannot answer that question.
 *
 * `nextLock` builds the ledger from the manifest with `Object.fromEntries`, so
 * on a tree this tool wrote the two agree entry for entry; anything else has
 * been edited since, and re-syncing rewrites it from the server.
 */
function assertLockMatchesManifest(
	lock: InstructionsLock,
	manifest: readonly InstructionManifestEntry[],
): void {
	const published = new Map(
		manifest.map((entry) => [entry.path, entry.sha256]),
	);
	for (const [path, entry] of Object.entries(lock.files)) {
		const expected = published.get(path);
		if (expected === undefined) {
			refuseStaleLedger(
				`it lists ${path}, which version ${lock.snapshotVersion} does not contain`,
			);
		}
		if (expected !== entry.sha256) {
			refuseStaleLedger(
				`its record of ${path} is not the published file`,
			);
		}
	}
	for (const entry of manifest) {
		// `Object.hasOwn` rather than a lookup: a published file named
		// `constructor` or `toString` would find something on the prototype
		// and pass a truthiness check while being absent from the ledger.
		if (!Object.hasOwn(lock.files, entry.path)) {
			refuseStaleLedger(
				`version ${lock.snapshotVersion} contains ${entry.path}, which the lock does not list`,
			);
		}
	}
}

export async function computePushPlan(input: {
	/** An already-canonical root, as every guarded read resolves against it. */
	root: string;
	lock: InstructionsLock;
	/**
	 * The PUBLISHED manifest for `lock.snapshotId`, straight from the server.
	 *
	 * The lock is an ordinary JSON file inside the checkout, so anything that
	 * can write into the working tree can write into it. Treating it as the
	 * list of files to read and send made that a way to exfiltrate: add
	 * `private-notes.md` to the ledger with a hash that matches nothing, and
	 * the next push reads that file and uploads its contents to a project
	 * whose instructions never mentioned it.
	 *
	 * So the ledger is checked against the server's own manifest before a
	 * single file is read. The manifest is the authority for WHICH paths this
	 * command may touch; the lock only supplies the hashes it compares
	 * against, and every one of those has to agree with the manifest too.
	 */
	manifest: readonly InstructionManifestEntry[];
	/** Paths to send as new files, from `--add`. */
	added?: readonly string[];
}): Promise<PushPlan> {
	const { root, lock } = input;
	const lockedPaths = Object.keys(lock.files);

	for (const lockedPath of lockedPaths) {
		assertPushablePath(
			lockedPath,
			"The lock names a path this tool will not touch.",
		);
	}
	assertLockMatchesManifest(lock, input.manifest);
	const lockCollision = findCollision(lockedPaths);
	if (lockCollision !== null) {
		throw new Error(
			`Refusing to push: ${describeRejection({
				ok: false,
				reason: "collision",
				detail: `${lockCollision.first} and ${lockCollision.second}`,
			})}. The lock names two paths this tool cannot tell apart.`,
		);
	}

	const added: string[] = [];
	const locked = new Set(lockedPaths);
	for (const candidate of input.added ?? []) {
		assertPushablePath(candidate, "That path cannot be pushed.");
		if (locked.has(candidate)) {
			// Already part of the diff below, where its hash decides whether
			// anything is sent at all. Accepting it here too would send it
			// twice, and the server refuses a path named twice.
			continue;
		}
		if (added.includes(candidate)) {
			continue;
		}
		added.push(candidate);
	}
	const allCollision = findCollision([...lockedPaths, ...added]);
	if (allCollision !== null) {
		throw new Error(
			`Refusing to push: ${describeRejection({
				ok: false,
				reason: "collision",
				detail: `${allCollision.first} and ${allCollision.second}`,
			})}. Two of these paths are one file on a case-insensitive filesystem.`,
		);
	}

	const entries: PushPlanEntry[] = [];
	const changes: InstructionChange[] = [];
	const unchanged: string[] = [];

	for (const lockedPath of lockedPaths.sort()) {
		const read = await readFileSafely(root, lockedPath);
		if (read === null) {
			entries.push({ path: lockedPath, action: "delete" });
			changes.push({ op: "delete", path: lockedPath });
			continue;
		}
		const actual = sha256Of(read.bytes);
		if (actual === lock.files[lockedPath]?.sha256) {
			unchanged.push(lockedPath);
			continue;
		}
		const encoded = encodeContent(read.bytes);
		entries.push({
			path: lockedPath,
			action: "put",
			size: read.bytes.length,
			sha256: actual,
		});
		changes.push({ op: "put", path: lockedPath, ...encoded });
	}

	for (const newPath of added.sort()) {
		const read = await readFileSafely(root, newPath);
		if (read === null) {
			throw new Error(
				`Refusing to push: there is no file at ${newPath}.`,
			);
		}
		const encoded = encodeContent(read.bytes);
		entries.push({
			path: newPath,
			action: "put",
			size: read.bytes.length,
			sha256: sha256Of(read.bytes),
		});
		changes.push({ op: "put", path: newPath, ...encoded });
	}

	return { entries, changes, unchanged };
}

/** A change left out of the plan because an open proposal already carries it. */
export interface AlreadyProposed {
	path: string;
	action: PushChangeAction;
	/** The newest open proposal that carries it. */
	proposal: {
		snapshotId: string;
		version: number;
		pullRequest: {
			state: ProposalPullRequestState;
			url: string | null;
		} | null;
	};
}

/**
 * Pull-request states in which a repository-sourced proposal is still on its
 * way to review. `BLOCKED` needs a person before it goes anywhere,
 * `CLOSE_REQUESTED` and `CANCELED` are withdrawals, and `MERGED` and `CLOSED`
 * are decided — none of those is carrying a change towards review any more.
 */
const LIVE_PULL_REQUEST_STATES: ReadonlySet<string> = new Set([
	"QUEUED",
	"OPENING",
	"OPEN",
]);

/**
 * Snapshot states in which a proposal's files are complete and its checks
 * are running or have passed. `RECEIVING` may never finish; `FAILED` and
 * `REJECTED` land nothing until somebody acts on them.
 */
const LIVE_SNAPSHOT_STATUSES: ReadonlySet<string> = new Set([
	"VALIDATING",
	"READY",
]);

/**
 * The open proposals whose changes a push may leave out, newest first.
 *
 * Only a proposal that will reach review as it stands counts, because the
 * two ways of being wrong cost very different things. Sending a change a
 * proposal already carries costs a duplicate, which the server handles
 * correctly; leaving out a change whose proposal will never be approved
 * loses the edit from the only proposal that could have carried it. So:
 *
 * - stated against `baseSnapshotId`, the version this push is stated against
 *   and has already confirmed is the published one. A proposal against an
 *   older version is stale, and a stale proposal cannot be approved;
 * - its files complete and its checks running or passed;
 * - and, for a repository-sourced project, its pull request queued, being
 *   opened, or open.
 */
function carryingProposals(
	proposals: readonly OpenInstructionProposal[],
	baseSnapshotId: string,
): OpenInstructionProposal[] {
	return proposals
		.filter(
			(proposal) =>
				proposal.baseSnapshotId === baseSnapshotId &&
				LIVE_SNAPSHOT_STATUSES.has(proposal.status) &&
				(proposal.pullRequest === null ||
					LIVE_PULL_REQUEST_STATES.has(proposal.pullRequest.state)),
		)
		.sort((a, b) => b.version - a.version);
}

/**
 * Take out of `plan` every change one of the caller's open proposals already
 * carries: the same path with the same bytes (sha256) for a put, the same
 * path for a delete. Everything else stays exactly as computed — an edit that
 * differs from what the proposal carries is a new edit, and is sent.
 */
export function setAsideProposed(
	plan: PushPlan,
	proposals: readonly OpenInstructionProposal[],
	baseSnapshotId: string,
): { plan: PushPlan; alreadyProposed: AlreadyProposed[] } {
	const carrying = carryingProposals(proposals, baseSnapshotId);
	const carriedBy = (entry: PushPlanEntry) =>
		carrying.find((proposal) =>
			proposal.changes.some(
				(change) =>
					change.path === entry.path &&
					change.op === entry.action &&
					(entry.action === "delete" ||
						change.sha256 === entry.sha256),
			),
		);

	const setAside = new Set<string>();
	const alreadyProposed: AlreadyProposed[] = [];
	for (const entry of plan.entries) {
		const proposal = carriedBy(entry);
		if (proposal === undefined) {
			continue;
		}
		setAside.add(entry.path);
		alreadyProposed.push({
			path: entry.path,
			action: entry.action,
			proposal: {
				snapshotId: proposal.snapshotId,
				version: proposal.version,
				pullRequest: proposal.pullRequest,
			},
		});
	}

	return {
		plan: {
			entries: plan.entries.filter((entry) => !setAside.has(entry.path)),
			changes: plan.changes.filter(
				(change) => !setAside.has(change.path),
			),
			unchanged: plan.unchanged,
		},
		alreadyProposed,
	};
}
