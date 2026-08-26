/**
 * PM attachment reconcile — PUSH HALF ONLY (Fizzy #1745, AC-1/2/3).
 *
 * Shares the shape designed for the ADO/Jira/Fizzy sibling (#1746 §5.2) so the
 * pull half and the other adapters drop in without rework. Transport-free: the
 * adapter is injected, and so are the rows and the persist callback, which is
 * what lets every rule be tested without a database or a network.
 *
 * The inbound cases deliberately THROW rather than no-op. A silent no-op is
 * indistinguishable from working sync, which is how #1746 came to be marked
 * done with no engine behind it.
 */
export class NotImplementedError extends Error {}

export type AttachmentAdapter = {
	upload(input: {
		storageKey: string;
		filename: string;
		mimeType: string;
	}): Promise<{ path: string; contentHash: string }>;
	list(description: string): Array<{ filename: string; path: string }>;
	/**
	 * The PM tool's OWN attachments on this item — the ones a human put there
	 * (Fizzy #1745, AC-5). Distinct from `list`, which reports what Fabric
	 * previously pushed: these are the import candidates, those are already
	 * ours.
	 */
	listRemote(description: string): RemoteAttachment[];
	/**
	 * Fetch one upload's bytes (Fizzy #1745, AC-5). `contentHash` is the
	 * sha256 of what actually arrived, so it is directly comparable to the
	 * `contentHash` the push half stored for a Fabric-origin row — which is
	 * what makes AC-6 (dedupe) and AC-8 (conflict) a hash comparison rather
	 * than a guess.
	 */
	download(input: { secret: string; filename: string }): Promise<{
		data: Buffer;
		contentType: string;
		contentHash: string;
	}>;
	delete(ref: string): Promise<never>;
};

/**
 * One attachment that exists on the PM item and may need importing.
 *
 * `secret` is carried separately from `path` because the download endpoint
 * takes it as its own path segment; re-deriving it from `path` at the call
 * site would put the same parse in two places.
 */
export type RemoteAttachment = {
	filename: string;
	path: string;
	secret: string;
};

export type ReconcileRow = {
	id: string;
	filename: string;
	mimeType: string;
	storageKey: string;
	designation: "LOCKED" | "UNLOCKED";
	source: "FABRIC" | "PM_SYNCED";
	contentHash: string | null;
	externalAttachmentId: string | null;
};

/**
 * Why a file did not end up correctly synced.
 *
 * `upload` — it never reached the PM tool. The bytes are still only in
 * Fabric.
 * `persist` — it DID reach the PM tool, but Fabric failed to record the
 * handle, so the link is lost locally and the next push re-uploads the same
 * bytes as a second attachment.
 *
 * The two need opposite advice, which is the whole reason this is a field
 * rather than something a reader infers from the message text.
 */
export type AttachmentFailureKind = "upload" | "persist";

export type ReconcileResult = {
	links: Array<{ filename: string; path: string }>;
	excluded: string[];
	failures: Array<{
		filename: string;
		message: string;
		kind: AttachmentFailureKind;
	}>;
	/**
	 * How many rows this run actually tried to upload. Excludes LOCKED files
	 * (never candidates) and rows whose link was reused from an earlier push
	 * (no transfer attempted), so a story with ten synced attachments and one
	 * new failure reports "1 of 1", not "1 of 11".
	 */
	attempted: number;
};

/**
 * One human-readable line describing what did not sync (Fizzy #1745, AC-4).
 *
 * Every surface a person reads this on is single-line: the sync log's
 * `statusDetail` (`list-pm-sync-log.ts` collapses `errorPayload` to one
 * string) and the notification snippet (rendered with CSS `truncate`). So the
 * count, the filenames and the reason all have to fit here — the structured
 * per-file list travels alongside for operators, not for this string.
 *
 * The two failure kinds get their OWN clause rather than a shared "failed to
 * upload", because they are opposite situations: an `upload` failure means
 * the PM tool never got the file, a `persist` failure means it got it and
 * Fabric lost the link. Collapsing them tells half the readers the reverse of
 * what happened.
 *
 * The filename list is capped per clause so a story that fails fifty uploads
 * produces a readable line rather than a paragraph; the counts stay exact, so
 * nothing is hidden by the cap.
 */
export function summarizeAttachmentFailures(
	result: Pick<ReconcileResult, "failures" | "attempted">,
): string {
	const NAMED = 3;
	const name = (list: ReconcileResult["failures"]): string => {
		const named = list
			.slice(0, NAMED)
			.map((f) => `${f.filename} (${f.message})`)
			.join("; ");
		return list.length > NAMED
			? `${named} and ${list.length - NAMED} more`
			: named;
	};

	const uploads = result.failures.filter((f) => f.kind === "upload");
	const persists = result.failures.filter((f) => f.kind === "persist");
	const clauses: string[] = [];

	if (uploads.length > 0) {
		clauses.push(
			`${uploads.length} of ${result.attempted} attachments failed to upload: ${name(uploads)}`,
		);
	}
	if (persists.length > 0) {
		clauses.push(
			`${persists.length} reached GitLab but Fabric could not record the link, so the next push will upload a duplicate: ${name(persists)}`,
		);
	}
	return clauses.join(". ");
}

export async function reconcileStoryAttachments(input: {
	rows: ReconcileRow[];
	adapter: AttachmentAdapter;
	direction: "push";
	isTerminal: boolean;
	persist(
		id: string,
		data: { externalAttachmentId: string; contentHash: string },
	): Promise<void>;
}): Promise<ReconcileResult> {
	if (input.direction !== "push") {
		throw new NotImplementedError(
			`reconcileStoryAttachments: direction "${input.direction}" is not implemented`,
		);
	}

	const result: ReconcileResult = {
		links: [],
		excluded: [],
		failures: [],
		attempted: 0,
	};

	for (const r of input.rows) {
		// AC-2: protected files never reach the adapter, only their names.
		if (r.designation === "LOCKED") {
			result.excluded.push(r.filename);
			continue;
		}
		// The push half owns Fabric-origin rows only.
		if (r.source !== "FABRIC") {
			continue;
		}
		// AC-3: StoryAttachment rows are content-immutable — storageKey is
		// written only at create (create-attachment.ts:222); every other
		// write path (remove-attachment, promote-attachment,
		// set-attachment-designation, story-attachment-ai-context) touches
		// only designation, deletedAt or promotedAt. Replacing a file's
		// bytes always creates a new row with a new id and a null
		// externalAttachmentId, which uploads naturally. So presence of
		// externalAttachmentId alone — with no hash comparison — is
		// correct and sufficient to skip a re-upload. If attachments ever
		// become mutable in place, this invariant breaks and needs a real
		// hash comparison again.
		if (r.externalAttachmentId) {
			result.links.push({
				filename: r.filename,
				path: r.externalAttachmentId,
			});
			continue;
		}

		// AC-4 of the sibling design: never push onto a closed item. This
		// check deliberately sits AFTER the link-reuse branch above: a
		// closed/terminal item must still keep the links it already has
		// (Fabric already holds the externalAttachmentId — omitting it
		// drops data, it does not "skip an upload"). Only a row that was
		// never uploaded gets skipped here, which is what "no outbound
		// sync onto a closed item" actually requires.
		if (input.isTerminal) {
			continue;
		}

		// Outbound-new. Upload and persist are split so a failure in one
		// records a message — and a `kind` — a reader can use to tell whether
		// the file actually reached the PM tool.
		result.attempted += 1;
		let uploaded: { path: string; contentHash: string };
		try {
			uploaded = await input.adapter.upload({
				storageKey: r.storageKey,
				filename: r.filename,
				mimeType: r.mimeType,
			});
		} catch (err) {
			result.failures.push({
				filename: r.filename,
				message: err instanceof Error ? err.message : String(err),
				kind: "upload",
			});
			continue;
		}

		try {
			await input.persist(r.id, {
				externalAttachmentId: uploaded.path,
				contentHash: uploaded.contentHash,
			});
			result.links.push({ filename: r.filename, path: uploaded.path });
		} catch (err) {
			result.failures.push({
				filename: r.filename,
				message: `uploaded to PM but failed to persist locally: ${
					err instanceof Error ? err.message : String(err)
				}`,
				kind: "persist",
			});
		}
	}

	return result;
}

/**
 * The subset of the adapter the pull half needs (Fizzy #1745, AC-5..AC-9).
 *
 * Narrower than `AttachmentAdapter` on purpose: the pull path must not be able
 * to upload or delete, and typing it that way makes that structural rather
 * than a rule someone has to remember.
 */
export type PullAdapter = {
	listRemote(description: string): RemoteAttachment[];
	download(input: { secret: string; filename: string }): Promise<{
		data: Buffer;
		contentType: string;
		contentHash: string;
	}>;
};

/** An attachment Fabric already holds, as the pull half needs to see it. */
export type PullRow = {
	id: string;
	filename: string;
	contentHash: string | null;
	source: "FABRIC" | "PM_SYNCED";
	externalAttachmentId: string | null;
};

export type PullResult = {
	imported: string[];
	skipped: string[];
	failures: Array<{ filename: string; message: string }>;
};

export async function reconcilePulledStoryAttachments(input: {
	rows: PullRow[];
	adapter: PullAdapter;
	description: string;
	/**
	 * #1702's server-authoritative limits, injected rather than read here so
	 * the engine stays transport- and env-free. Resolved by the caller from
	 * `resolveAttachmentLimits()` — the SAME resolver the API upload path
	 * uses, so the two doors into the attachment store cannot enforce
	 * different numbers.
	 */
	limits: {
		maxBytes: number;
		maxPerStory: number;
		allowlist: readonly string[];
	};
	importAttachment(data: {
		filename: string;
		contentType: string;
		contentHash: string;
		data: Buffer;
		designation: "UNLOCKED";
		source: "PM_SYNCED";
		externalAttachmentId: string;
	}): Promise<void>;
	recordIssue(issue: {
		filename: string;
		kind: string;
		detail: string;
	}): Promise<void>;
}): Promise<PullResult> {
	const result: PullResult = { imported: [], skipped: [], failures: [] };

	// Read the item's attachments ONCE. The AC-7 sweep below needs the same
	// list, and calling the adapter twice would both re-parse the description
	// and quietly assume the two calls agree.
	const candidates = input.adapter.listRemote(input.description);

	for (const candidate of candidates) {
		// AC-6, cheap path. A re-pull of an unchanged issue is the common
		// case; recognising the upload by the handle already stored avoids
		// paying for the bytes only to discover we have them.
		if (input.rows.some((r) => r.externalAttachmentId === candidate.path)) {
			result.skipped.push(candidate.filename);
			continue;
		}

		let downloaded: Awaited<ReturnType<PullAdapter["download"]>>;
		try {
			downloaded = await input.adapter.download({
				secret: candidate.secret,
				filename: candidate.filename,
			});
		} catch (err) {
			// AC-4's rule applied to the pull direction: one bad file must not
			// cost the user the others.
			result.failures.push({
				filename: candidate.filename,
				message: err instanceof Error ? err.message : String(err),
			});
			continue;
		}

		// AC-9. The cap is #1702's per-item limit, injected rather than
		// hardcoded: GitLab's own 25MB upload cap is a different number owned
		// by a different system, and conflating them enforces the wrong one.
		// Checked after the transfer because the download endpoint is the only
		// thing that reports a size, and GitLab's own cap bounds what that
		// transfer can cost.
		if (downloaded.data.length > input.limits.maxBytes) {
			await input.recordIssue({
				filename: candidate.filename,
				kind: "TOO_LARGE",
				detail: `"${candidate.filename}" is ${downloaded.data.length} bytes, over this project's ${input.limits.maxBytes}-byte attachment limit, so it was not imported.`,
			});
			result.skipped.push(candidate.filename);
			continue;
		}

		// Parity with `create-attachment.ts`, which enforces the allowlist on
		// the upload path. Not required by any acceptance criterion — but an
		// importer that skipped it would be a second door into the same store
		// with the control missing.
		if (!input.limits.allowlist.includes(downloaded.contentType)) {
			await input.recordIssue({
				filename: candidate.filename,
				kind: "DISALLOWED_TYPE",
				detail: `"${candidate.filename}" is a ${downloaded.contentType} file, which this deployment does not accept as an attachment, so it was not imported.`,
			});
			result.skipped.push(candidate.filename);
			continue;
		}

		// Also parity. Counts rows already held plus what this run has
		// imported, so one issue linking hundreds of uploads cannot import
		// past a cap enforced everywhere else.
		if (
			input.rows.length + result.imported.length >=
			input.limits.maxPerStory
		) {
			await input.recordIssue({
				filename: candidate.filename,
				kind: "STORY_CAP_REACHED",
				detail: `"${candidate.filename}" was not imported: this feature already holds the maximum of ${input.limits.maxPerStory} attachments.`,
			});
			result.skipped.push(candidate.filename);
			continue;
		}

		// AC-6, content path, and AC-8. The same bytes re-uploaded to GitLab
		// get a NEW secret, so the handle check above cannot catch them —
		// only the hash can, and the hash is only knowable after the
		// download. Same name AND same bytes is a duplicate; same name and
		// DIFFERENT bytes is a conflict, where importing would shadow the
		// Fabric copy and skipping silently would drop the GitLab one.
		const sameName = input.rows.filter(
			(r) => r.filename === candidate.filename,
		);
		if (sameName.some((r) => r.contentHash === downloaded.contentHash)) {
			result.skipped.push(candidate.filename);
			continue;
		}
		if (sameName.length > 0) {
			await input.recordIssue({
				filename: candidate.filename,
				kind: "CONFLICT",
				detail: `GitLab and Fabric both have "${candidate.filename}" with different contents. Neither copy was changed.`,
			});
			result.skipped.push(candidate.filename);
			continue;
		}

		try {
			await input.importAttachment({
				filename: candidate.filename,
				contentType: downloaded.contentType,
				contentHash: downloaded.contentHash,
				data: downloaded.data,
				// AC-3 of the card's pull section: land UNLOCKED so the
				// user can lock afterwards. Importing LOCKED would silently
				// withhold the file from the AI context it was pulled in to
				// feed.
				designation: "UNLOCKED",
				// Never FABRIC: the push half owns Fabric-origin rows and
				// would otherwise try to upload this straight back to GitLab.
				source: "PM_SYNCED",
				externalAttachmentId: candidate.path,
			});
		} catch (err) {
			// Mirrors the push half's persist guard. Without it a single
			// storage hiccup throws out of the activity AFTER the story has
			// already been updated, so the user sees a failed pull for one
			// that actually landed — and loses the other files with it.
			result.failures.push({
				filename: candidate.filename,
				message: `downloaded from GitLab but could not be saved: ${
					err instanceof Error ? err.message : String(err)
				}`,
			});
			continue;
		}
		result.imported.push(candidate.filename);
	}

	// AC-7. An upload Fabric pulled in earlier that the issue no longer
	// references has been deleted on the GitLab side. The Fabric copy is kept
	// — this engine has no delete path at all, so retention is structural —
	// but the divergence is reported so the user can act on it.
	//
	// Scoped to PM_SYNCED rows deliberately. A FABRIC-origin row's handle
	// points into Fabric's OWN attachment block, which `listRemote` strips by
	// design, so keying this on the handle alone would report every pushed
	// attachment as remotely deleted on every single pull.
	const stillPresent = new Set(candidates.map((r) => r.path));
	for (const row of input.rows) {
		if (row.source !== "PM_SYNCED" || !row.externalAttachmentId) {
			continue;
		}
		if (stillPresent.has(row.externalAttachmentId)) {
			continue;
		}
		await input.recordIssue({
			filename: row.filename,
			kind: "REMOTE_DELETED",
			detail: `"${row.filename}" is no longer attached to the linked GitLab issue. Fabric's copy has been kept.`,
		});
	}

	return result;
}
