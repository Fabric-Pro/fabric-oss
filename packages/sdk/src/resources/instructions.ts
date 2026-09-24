/**
 * Coding instructions — the published snapshot of a project's agent
 * instruction tree (AGENTS.md, .claude/ skills, rules, settings).
 *
 * Two calls, and they are meant to be used in that order by a client that
 * keeps a working tree current: `getPublished` with the digest you already
 * hold answers "did anything move?" for the cost of one request and no file
 * list, and only when something did move is `createDownloadUrl` worth making.
 */
import type { FabricHttpClient } from "../client.js";

/**
 * Where a project's instructions are authored. `REPOSITORY` means they are
 * changed in git and mirrored into Fabric, so a tool that writes them into a
 * checkout would be fighting `git pull`.
 */
export type InstructionSourceOfTruth = "UPLOAD" | "REPOSITORY";

export type InstructionFileKind =
	| "SKILL"
	| "AGENT"
	| "RULE"
	| "INSTRUCTIONS"
	| "SETTINGS"
	| "SCRIPT"
	| "KNOWLEDGE"
	| "OTHER";

export interface InstructionManifestEntry {
	/** Relative POSIX path inside the tree. Never absolute, never traversing. */
	path: string;
	/** Hex sha256 of the file's exact bytes. */
	sha256: string;
	size: number;
	/** POSIX mode as stored at upload, or null when none was recorded. */
	mode: number | null;
	kind: InstructionFileKind;
}

export interface InstructionChanges {
	added: string[];
	removed: string[];
	changed: string[];
}

export interface PublishedInstructionSnapshot {
	id: string;
	version: number;
	/**
	 * sha256 over the snapshot's sorted path+hash lines — the sync key. A
	 * file's normalised mode (permission bits only; null/absent reads as
	 * 0644) is folded into its line when it is not the default, so a
	 * mode-only republish gets a new digest too.
	 */
	digest: string;
	fileCount: number;
	/** ISO 8601, or null for a snapshot published before the column existed. */
	publishedAt: string | null;
}

export interface PublishedInstructions {
	published: boolean;
	sourceOfTruth: InstructionSourceOfTruth;
	/** Present only when `published` is true. */
	snapshot?: PublishedInstructionSnapshot;
	/**
	 * Present only when `sinceDigest` was sent. `true` means the caller
	 * already holds this exact content, and no manifest is returned.
	 */
	unchanged?: boolean;
	/**
	 * Present only when `sinceDigest` was sent. `null` means the base digest
	 * is not one this project has published (or has been pruned), so nothing
	 * can be said about what changed — take a full copy.
	 */
	changes?: InstructionChanges | null;
	/** Omitted when `unchanged` is true, and when nothing is published. */
	manifest?: InstructionManifestEntry[];
}

export interface InstructionDownload {
	snapshotId: string;
	digest: string;
	/** Short-lived signed URL to a zip of the whole published tree. */
	url: string;
	expiresInSeconds: number;
}

export interface GetPublishedInstructionsOptions {
	/** The digest already held locally; turns the call into a delta. */
	sinceDigest?: string;
	org?: string;
	personal?: boolean;
}

export interface CreateInstructionDownloadOptions {
	org?: string;
	personal?: boolean;
}

/**
 * One path's change, with the file's bytes carried inline.
 *
 * `content` is the file itself, not a URL: a change set is a handful of small
 * text files, and a round trip per file to a signed upload URL buys nothing at
 * that size. `encoding` defaults to `utf8`; send `base64` for anything that is
 * not text.
 *
 * `size` and `sha256` are deliberately absent. The server holds the bytes on
 * this path, so it computes both itself — a client-supplied hash could only
 * ever make the stored row disagree with the stored object.
 */
export type InstructionChange =
	| {
			op: "put";
			/** Relative POSIX path inside the tree. Never absolute, never traversing. */
			path: string;
			content: string;
			encoding?: "utf8" | "base64";
	  }
	| { op: "delete"; path: string };

export interface SubmitInstructionChangeOptions {
	org?: string;
	personal?: boolean;
}

export interface SubmittedInstructionChange {
	/**
	 * Which route answered: `proposal` from `submitChange`, `publish` from
	 * `publishChange`. Echoed by the server, so it says what actually
	 * happened rather than what was asked for.
	 */
	mode: "proposal" | "publish";
	snapshotId: string;
	version: number;
	baseSnapshotId: string;
	baseVersion: number;
	fileCount: number;
	inheritedCount: number;
	putCount: number;
	deleteCount: number;
	/**
	 * The review state. `PENDING` for a proposal — a later state means an
	 * earlier attempt at the same change set was already decided. Always
	 * `null` for a publish: there is nobody to review it.
	 */
	proposalStatus: "PENDING" | "APPROVED" | "REJECTED" | null;
	/**
	 * The snapshot's status once its validation run was started, normally
	 * `VALIDATING`. A publish is NOT finished at this point, and `READY` here
	 * does NOT by itself mean it landed — see `published`.
	 */
	status: string;
	/**
	 * True when this snapshot has been published at least once by the time of
	 * this response. A publish normally lands AFTER the response returns —
	 * the server-side workflow that validates and publishes a snapshot keeps
	 * running past `publishChange`'s own return — so `false` means "not yet
	 * confirmed", never "refused": the same publish can still land a moment
	 * later without this field ever telling you so. `status: "READY"` does
	 * NOT imply `published: true` for exactly that reason. Poll `getPublished`
	 * or check the project's Coding Instructions tab to see the outcome once
	 * it has actually happened. Always `false` for `submitChange`'s proposal
	 * — nothing about that call ever asks the workflow to publish one.
	 */
	published: boolean;
}

export class InstructionsResource {
	constructor(private readonly http: FabricHttpClient) {}

	/**
	 * The project's published instruction manifest.
	 *
	 * Pass `sinceDigest` on every repeat call. An equal digest is answered
	 * before the server reads a single file row, which is what makes a
	 * session-start check cheap enough to run every time.
	 */
	getPublished(
		projectId: string,
		options: GetPublishedInstructionsOptions = {},
	): Promise<PublishedInstructions> {
		return this.http.get<PublishedInstructions>(
			`/projects/${encodeURIComponent(projectId)}/instructions/published${buildQuery(options)}`,
		);
	}

	/**
	 * A signed URL to a zip of the published tree.
	 *
	 * POST because it materialises an export object. It is idempotent in
	 * RESULT — the archive is keyed on the snapshot's digest, so a rebuild
	 * reuses whatever object is already at that key — but not in EFFECT: this
	 * route does not honour `Idempotency-Key`, and a retry does not wait for a
	 * build already in flight on the server, it starts another. On a large
	 * tree with no archive built yet, the client's default retry policy would
	 * turn one timed-out request into two or three concurrent builds of the
	 * same archive. So this call is sent once: `{ maxRetries: 0 }` overrides
	 * the client's retry policy for this request alone.
	 */
	createDownloadUrl(
		projectId: string,
		options: CreateInstructionDownloadOptions = {},
	): Promise<InstructionDownload> {
		return this.http.post<InstructionDownload>(
			`/projects/${encodeURIComponent(projectId)}/instructions/published/download${buildQuery(options)}`,
			{},
			{ retry: { maxRetries: 0 } },
		);
	}

	/**
	 * Suggest a change to the project's coding instructions.
	 *
	 * It opens a PROPOSAL and only a proposal: nothing is published until
	 * somebody who can edit the project's instructions approves it in the
	 * Coding Instructions tab. The body has no mode to set —
	 * `instructions:write` is offered to read-only roles and described as
	 * review-gated, and a publish mode here would make that description untrue
	 * for any key whose creator happens to hold the publishing permission.
	 * Publishing is `publishChange` below, a different route behind a
	 * different scope.
	 *
	 * `baseSnapshotId` is REQUIRED and positional: it is the id of the
	 * published snapshot the change set is stated against — `snapshotId` from
	 * `getPublished`, or the one recorded in `.fabric/instructions.lock`. A
	 * base that is no longer the published version comes back as a 409 whose
	 * `FabricError.code` is `PULL_FIRST`, meaning sync and make the change
	 * again. It has no default on purpose: falling back to whatever is
	 * published now would silently rebase an edit onto a version the caller
	 * never read. The other codes this call can answer with are
	 * `REPOSITORY_SOURCE_OF_TRUTH`, `NOTHING_PUBLISHED`,
	 * `PROPOSAL_PROPOSER_LIMIT` and `PROPOSAL_PROJECT_LIMIT`.
	 *
	 * Requires a key with `instructions:write`. The key's creator must still
	 * hold the project permission the tab requires to propose — the scope is a
	 * ceiling, never a grant.
	 *
	 * **Safe to retry**, and retried by the client's default policy like every
	 * other mutating call here. The route deduplicates by the CONTENT of the
	 * change set — the base it is stated against plus the set of paths,
	 * operations and hashes — so a request whose response was lost comes back
	 * with the proposal the first attempt opened rather than a second one
	 * against the five-per-proposer cap. The `snapshotId` a retry returns is
	 * therefore the same `snapshotId`.
	 */
	submitChange(
		projectId: string,
		baseSnapshotId: string,
		changes: InstructionChange[],
		options: SubmitInstructionChangeOptions = {},
	): Promise<SubmittedInstructionChange> {
		return this.http.post<SubmittedInstructionChange>(
			`/projects/${encodeURIComponent(projectId)}/instructions/changes${buildQuery(options)}`,
			{ baseSnapshotId, changes },
		);
	}

	/**
	 * Publish the same change set as a new version, with no review.
	 *
	 * A separate method for a separate route and a separate scope. It takes
	 * the same three arguments as `submitChange` and differs in authorization
	 * in two ways that matter to a caller: the key must carry `instructions:publish`
	 * rather than `instructions:write`, and its creator must still hold the
	 * project permission the Coding Instructions tab requires to publish —
	 * checked live on every call, so a demotion takes effect at once.
	 * `instructions:write` cannot reach this route and this scope cannot open
	 * a proposal; a key may of course carry both.
	 *
	 * Publishing is not instantaneous. What comes back is a snapshot whose
	 * validation run has just started, normally `status: "VALIDATING"`: the
	 * same verify → secret-scan → publish workflow a folder upload runs
	 * decides, and the version replaces the published one only when it
	 * passes. Poll `getPublished` if you need to see that it landed.
	 *
	 * `baseSnapshotId` is REQUIRED for the same reason as on `submitChange`,
	 * and matters more here: a publish is a fast-forward claim on the
	 * published pointer, so a base that is no longer published is a 409 whose
	 * `FabricError.code` is `PULL_FIRST` and nothing is written. The other
	 * codes are the same set `submitChange` documents, minus the two proposal
	 * caps, which do not apply to a version.
	 *
	 * **Sent once**: `{ maxRetries: 0 }` overrides the client's retry policy
	 * for this request alone. `submitChange` can be retried safely because the
	 * server recognises a change set it has already admitted as a proposal and
	 * answers with that proposal; a publish has no such dedup — the second
	 * request would create a second version of the same content — so a
	 * response lost in transit is reported rather than repeated. Check
	 * `getPublished` before sending it again.
	 */
	publishChange(
		projectId: string,
		baseSnapshotId: string,
		changes: InstructionChange[],
		options: SubmitInstructionChangeOptions = {},
	): Promise<SubmittedInstructionChange> {
		return this.http.post<SubmittedInstructionChange>(
			`/projects/${encodeURIComponent(projectId)}/instructions/versions${buildQuery(options)}`,
			{ baseSnapshotId, changes },
			{ retry: { maxRetries: 0 } },
		);
	}
}

/**
 * `personal` is emitted ONLY when true.
 *
 * The shared helper in `projects.ts` emits `personal=` for `false`, and
 * `FabricHttpClient.buildUrl` treats the mere presence of `personal=` as
 * "the caller set an explicit context" and skips injecting the client's
 * default `org`. Passing `personal: false` therefore silently dropped the
 * org a caller had configured.
 */
function buildQuery(opts: object): string {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(
		opts as Record<string, unknown>,
	)) {
		if (value === undefined || value === null) {
			continue;
		}
		if (key === "personal") {
			if (value === true) {
				params.set(key, "1");
			}
			continue;
		}
		params.set(key, String(value));
	}
	const query = params.toString();
	return query ? `?${query}` : "";
}
