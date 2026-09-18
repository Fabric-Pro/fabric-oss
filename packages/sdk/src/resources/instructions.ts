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
	/** sha256 over the snapshot's sorted path+hash lines — the sync key. */
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
	 * POST because it materialises an export object, but idempotent: the
	 * archive is keyed on the snapshot's digest and an existing object is
	 * reused rather than rebuilt.
	 */
	createDownloadUrl(
		projectId: string,
		options: CreateInstructionDownloadOptions = {},
	): Promise<InstructionDownload> {
		return this.http.post<InstructionDownload>(
			`/projects/${encodeURIComponent(projectId)}/instructions/published/download${buildQuery(options)}`,
			{},
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
