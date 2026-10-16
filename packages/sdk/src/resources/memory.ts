/**
 * Living Memory write lane — the files agents keep in a project's repository
 * folders, delivered through Fabric (ADR-022).
 *
 * The primitives `fabric memory pull|push|status` are built on: the write
 * folders and where they land, the files Living Memory holds under one folder,
 * signed URLs to stage larger files, a write (a batch of PUTs and DELETEs that
 * lands as one commit or one pull request) and its receipt.
 *
 * Every call needs a credential with `memory:write`, and the caller must still
 * hold the project permission behind it (to read the folders, or to add
 * context): the scope is a ceiling, never a grant.
 */
import type { FabricHttpClient } from "../client.js";

export type MemoryWriteMode = "PULL_REQUEST" | "DIRECT_PUSH";

export interface MemoryWriteTarget {
	id: string;
	/** Repository-relative folder, `/`-separated. */
	folder: string;
	mode: MemoryWriteMode;
	version: number;
}

export interface MemoryWriteTargets {
	/** `null` when the project has no Living Memory repository sync. */
	sync: {
		ref: string;
		/** The commit the sync last applied: what a file listing reflects. */
		lastAppliedCommitSha: string | null;
		/** True while landed files reach Living Memory on their own. */
		ingesting: boolean;
		repository: { provider: string; owner: string; name: string };
	} | null;
	targets: MemoryWriteTarget[];
}

export interface MemoryFolderFile {
	path: string;
	/** The git blob the sync read; `null` until a sync run has stamped it. */
	blobOid: string | null;
	/** sha256 hex of the UTF-8 content. */
	contentHash: string | null;
	bytes: number;
}

export interface MemoryFolderFiles {
	targetId: string;
	folder: string;
	ref: string;
	lastAppliedCommitSha: string | null;
	files: MemoryFolderFile[];
	/** Pass as `after` for the next page; `null` on the last. */
	nextCursor: string | null;
}

export interface MemoryFolderFileContent extends MemoryFolderFile {
	targetId: string;
	ref: string;
	lastAppliedCommitSha: string | null;
	content: string;
}

export interface ListMemoryFolderFilesOptions {
	targetId: string;
	after?: string;
	limit?: number;
}

export interface GetMemoryFolderFileOptions {
	targetId: string;
	path: string;
}

/** One file of a write. A PUT carries inline `content` or a staged file; a DELETE names `ifMatchOid`. */
export interface MemoryWriteEntry {
	path: string;
	op: "PUT" | "DELETE";
	/** The blob the caller last saw at the path; absent means create-only. */
	ifMatchOid?: string;
	content?: string;
	stagedKey?: string;
	bytes?: number;
	sha256?: string;
}

export interface SubmitMemoryWriteInput {
	targetId: string;
	message: string;
	entries: MemoryWriteEntry[];
}

export type MemoryWriteStatus =
	| "PENDING"
	| "COMMITTED"
	| "PULL_REQUEST"
	| "CONFLICT"
	| "REFUSED"
	| "FAILED";

export interface SubmittedMemoryWrite {
	writeId: string;
	status: MemoryWriteStatus;
	digest: string;
	/** An identical request already had this receipt. */
	deduplicated: boolean;
}

export interface MemoryWritePathVerdict {
	path: string;
	code: string;
	/** The blob now at the path (a conflict). */
	currentOid?: string | null;
}

export type MemoryWriteOutcome =
	| { status: "COMMITTED"; sha: string; ref: string; fileCount: number }
	| {
			status: "PULL_REQUEST";
			sha: string;
			ref: string;
			branch: string;
			url: string;
			externalId: string;
			reason: "configured" | "protected";
			fileCount: number;
	  }
	| { status: "CONFLICT"; paths: MemoryWritePathVerdict[] }
	| { status: "REFUSED"; code: string; paths?: MemoryWritePathVerdict[] }
	| { status: "FAILED"; code: string; retryable: boolean; sha?: string };

export interface MemoryWriteReceipt {
	writeId: string;
	status: MemoryWriteStatus;
	digest: string;
	targetId: string;
	folder: string;
	mode: MemoryWriteMode;
	ref: string;
	via: string;
	entries: Array<{ path: string; op: "PUT" | "DELETE" }>;
	outcome: MemoryWriteOutcome | null;
	createdAt: string;
	settledAt: string | null;
}

export interface MemoryUploadUrls {
	expiresInSeconds: number;
	uploads: Array<{
		stagedKey: string;
		url: string;
		contentType: string;
		bytes: number;
	}>;
}

/** What a refused submit carries in `FabricError.data`. */
export interface MemoryWriteRefusalData {
	problems?: Array<{ path?: string; code: string; detail?: string }>;
	limit?: number;
}

export class MemoryResource {
	constructor(private readonly http: FabricHttpClient) {}

	private base(projectId: string): string {
		return `/projects/${encodeURIComponent(projectId)}/memory`;
	}

	/** The write folders, where they land, and the commit the sync last applied. */
	getTargets(projectId: string): Promise<MemoryWriteTargets> {
		return this.http.get<MemoryWriteTargets>(
			`${this.base(projectId)}/targets`,
		);
	}

	/** One page of what Living Memory holds under a write folder, by path. */
	listFiles(
		projectId: string,
		options: ListMemoryFolderFilesOptions,
	): Promise<MemoryFolderFiles> {
		const params = new URLSearchParams({ targetId: options.targetId });
		if (options.after !== undefined) {
			params.set("after", options.after);
		}
		if (options.limit !== undefined) {
			params.set("limit", String(options.limit));
		}
		return this.http.get<MemoryFolderFiles>(
			`${this.base(projectId)}/files?${params.toString()}`,
		);
	}

	/** One file under a write folder, with its text. */
	getFile(
		projectId: string,
		options: GetMemoryFolderFileOptions,
	): Promise<MemoryFolderFileContent> {
		const params = new URLSearchParams({
			targetId: options.targetId,
			path: options.path,
		});
		return this.http.get<MemoryFolderFileContent>(
			`${this.base(projectId)}/file?${params.toString()}`,
		);
	}

	/** Signed PUT URLs to stage file bytes too large to send inline. */
	createUploadUrls(
		projectId: string,
		files: Array<{ bytes: number }>,
	): Promise<MemoryUploadUrls> {
		return this.http.post<MemoryUploadUrls>(
			`${this.base(projectId)}/upload-urls`,
			{ files },
		);
	}

	/**
	 * Submit a write. It is admitted and started, not finished: read the
	 * receipt with {@link getWrite} for how it ended. A request that cannot be
	 * admitted rejects with a 400 `FabricError` whose `data.problems` lists
	 * every problem, and the pending cap rejects with a 429 whose `data.limit`
	 * is the cap.
	 *
	 * **Safe to retry**: an identical request from the same member that is in
	 * flight or landed answers its receipt with `deduplicated: true`.
	 */
	submitWrite(
		projectId: string,
		input: SubmitMemoryWriteInput,
	): Promise<SubmittedMemoryWrite> {
		return this.http.post<SubmittedMemoryWrite>(
			`${this.base(projectId)}/writes`,
			input,
		);
	}

	/** The receipt of a write: its status and, once settled, how it ended. */
	getWrite(projectId: string, writeId: string): Promise<MemoryWriteReceipt> {
		return this.http.get<MemoryWriteReceipt>(
			`${this.base(projectId)}/writes/${encodeURIComponent(writeId)}`,
		);
	}
}
