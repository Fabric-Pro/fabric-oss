import { createHash } from "node:crypto";
import { config } from "@repo/config";
import { downloadFile } from "@repo/storage";
import {
	ATTACHMENT_BLOCK_CLOSE,
	ATTACHMENT_BLOCK_OPEN,
	stripAttachmentBlock,
} from "./gitlab-attachment-block";
import {
	type AttachmentAdapter,
	NotImplementedError,
	type RemoteAttachment,
} from "./reconcile-story-attachments";

/** GitLab rejects uploads over 25MB; check before spending the request. */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * Turn an upload's HTTP status into a message that says what to DO about it
 * (Fizzy #1745, AC-9/AC-10).
 *
 * This string is the whole of what a person sees: it is what the reconcile
 * engine records as the file's failure, what the sync log's one-line
 * `statusDetail` renders, and what the notification snippet quotes. A bare
 * "failed: 403" satisfies none of those readers — AC-10 requires the reader
 * to learn what the fix is. The raw status stays appended so operators can
 * still grep for it.
 *
 * 401 and 403 are deliberately NOT folded together. A 401 means the token is
 * invalid, expired or revoked; a 403 means it authenticated but may not
 * upload. Telling the holder of an expired token to widen its scope sends
 * them to do the one thing that cannot help. `provider-http-error.ts` draws
 * the same line for the pipeline fetchers.
 *
 * The filename is NOT repeated here: every reader of this string already has
 * it — the engine stores it in the failure record's own `filename` field, and
 * `summarizeAttachmentFailures` prefixes it. Repeating it cost the notification
 * snippet its (single, truncated) line twice over.
 */
function describeUploadFailure(status: number): string {
	const cause =
		status === 401
			? "the configured GitLab token is invalid, expired or revoked"
			: status === 403
				? "the configured GitLab token lacks the 'api' scope required to upload files"
				: status === 413
					? "GitLab rejected the file as too large"
					: "GitLab rejected the upload";
	return `${cause} (HTTP ${status})`;
}

/**
 * Turn a download's HTTP status into a message a person can act on
 * (Fizzy #1745, AC-5/AC-7).
 *
 * 404 is called out separately because it is the ONLY status here that is
 * routinely benign: an upload referenced by an older issue description can
 * have been deleted on the GitLab side, which AC-7 treats as a discrepancy to
 * REPORT rather than a failure to retry. The engine keys off this to decide
 * which of the two it is looking at, so the wording is load-bearing.
 *
 * A 403 here does NOT carry the missing-`api`-scope meaning that the same
 * status carries on upload: download-by-secret needs only Guest, so telling
 * this reader to widen the token's scope sends them to do something that
 * cannot help. `describeUploadFailure` above owns that wording; this one must
 * not borrow it.
 */
function describeDownloadFailure(status: number): string {
	const cause =
		status === 404
			? "it is no longer present on GitLab"
			: status === 401
				? "the configured GitLab token is invalid, expired or revoked"
				: status === 403
					? "the configured GitLab token cannot read this project"
					: "GitLab refused the download";
	return `${cause} (HTTP ${status})`;
}

/**
 * GitLab attachment adapter (Fizzy #1745).
 *
 * Bytes come from object storage by `storageKey`, NEVER from a presigned URL:
 * the inline-image path fetches its own presigned R2 URL and silently keeps the
 * original markdown when that fetch fails, which is how a pushed image ends up
 * on GitLab as a link that expires in an hour.
 *
 * GitLab has no per-issue attachment API, so `list` parses the Fabric-owned
 * block. Links a human wrote elsewhere in the description are not ours and are
 * deliberately invisible to reconcile.
 */
export function createGitLabAttachmentAdapter(opts: {
	token: string;
	projectId: string;
	baseUrl?: string;
}): AttachmentAdapter {
	const root = (opts.baseUrl || "https://gitlab.com").replace(/\/+$/, "");
	const apiBase = root.endsWith("/api/v4") ? root : `${root}/api/v4`;
	const uploadUrl = `${apiBase}/projects/${encodeURIComponent(
		opts.projectId,
	)}/uploads`;

	return {
		async upload({ storageKey, filename, mimeType }) {
			const file = await downloadFile(storageKey, {
				bucket: config.storage.bucketNames.projectContexts,
			});
			if (file.data.length > MAX_BYTES) {
				throw new Error(
					`it is ${file.data.length} bytes, over GitLab's 25MB upload cap`,
				);
			}
			const contentHash = createHash("sha256")
				.update(file.data)
				.digest("hex");

			const form = new FormData();
			form.append(
				"file",
				new Blob([new Uint8Array(file.data)], {
					type: mimeType || file.contentType,
				}),
				filename,
			);
			const res = await fetch(uploadUrl, {
				method: "POST",
				headers: { "PRIVATE-TOKEN": opts.token },
				body: form,
			});
			if (!res.ok) {
				throw new Error(describeUploadFailure(res.status));
			}
			const body = (await res.json()) as {
				full_path?: string;
				url?: string;
			};
			// `url` is the relative `/uploads/<hash>/<file>` form and is what
			// every other GitLab uploader in this repo consumes
			// (story-sync-media.ts:1449 reads json.url and nothing else). For
			// a link inside an issue in the SAME project that relative form
			// is correct; `full_path` carries a group/project prefix that
			// would resolve wrong, so it is only a fallback.
			const path = body.url ?? body.full_path;
			if (!path) {
				throw new Error(
					`GitLab upload for ${filename} returned no path`,
				);
			}
			// Defense in depth (Fizzy #1745 review): GitLab's own storage
			// layer sanitizes the stored filename (CarrierWave::SanitizedFile,
			// default sanitize_regexp /[^[:word:]\.\-\+]/) before building
			// this path, so `<`/`>` should never survive into a real
			// response even though sanitizeAttachmentFilename lets them
			// through on the way in. Refuse to trust a response that
			// disagrees rather than let it forge the block's HTML-comment
			// fence markers.
			if (/[<>]/.test(path)) {
				throw new Error(
					`GitLab upload for ${filename} returned an unexpected character in its path; refusing to trust it`,
				);
			}
			return { path, contentHash };
		},

		async download({ secret, filename }) {
			// Download-by-secret (GitLab 17.4+), NOT download-by-id: the by-id
			// form requires Maintainer/Owner, this one requires only Guest,
			// and the integration PAT is frequently neither. The secret and
			// filename are the two components already present in every
			// `/uploads/<secret>/<filename>` link in an issue description, so
			// no extra lookup is needed to call it.
			const res = await fetch(
				`${apiBase}/projects/${encodeURIComponent(
					opts.projectId,
				)}/uploads/${encodeURIComponent(secret)}/${encodeURIComponent(
					filename,
				)}`,
				{ headers: { "PRIVATE-TOKEN": opts.token } },
			);
			if (!res.ok) {
				throw new Error(describeDownloadFailure(res.status));
			}
			const data = Buffer.from(await res.arrayBuffer());
			return {
				data,
				contentType:
					res.headers.get("content-type") ||
					"application/octet-stream",
				contentHash: createHash("sha256").update(data).digest("hex"),
			};
		},

		list(description) {
			const open = description.indexOf(ATTACHMENT_BLOCK_OPEN);
			const close = description.indexOf(ATTACHMENT_BLOCK_CLOSE);
			if (open === -1 || close === -1 || close < open) {
				return [];
			}
			const block = description.slice(open, close);
			return [
				...block.matchAll(/^- \[([^\]]+)\]\((\/uploads\/[^)]+)\)$/gm),
			].map((m) => ({ filename: m[1] as string, path: m[2] as string }));
		},

		listRemote(description) {
			// Everything inside Fabric's own block is what THIS side pushed;
			// `stripAttachmentBlock` removes it so those links can never be
			// re-imported as if a human had attached them.
			const outside = stripAttachmentBlock(description);
			// The leading `(?<!!)` is the AC-11 boundary: a `!` before the
			// bracket makes it an image embed, and `ingestPulledImages`
			// already downloads and re-hosts every one of those on each pull.
			// Claiming them here too would import one GitLab image twice per
			// pull, forever.
			const pattern =
				/(?<!!)\[([^\]]*)\]\((\/uploads\/([0-9a-f]{32})\/([^)\s]+))\)/g;
			const bySecret = new Map<string, RemoteAttachment>();
			for (const m of outside.matchAll(pattern)) {
				const path = m[2] as string;
				const secret = m[3] as string;
				// The filename comes from the PATH, not the link label: the
				// label is free text a human can set to anything, while the
				// path segment is what GitLab actually stored and what the
				// download endpoint requires.
				const filename = decodeURIComponent(m[4] as string);
				// One entry per upload. The same file linked twice in a
				// description is one attachment, not two.
				if (!bySecret.has(secret)) {
					bySecret.set(secret, { filename, path, secret });
				}
			}
			return [...bySecret.values()];
		},

		async delete() {
			throw new NotImplementedError(
				"GitLab attachment delete is not implemented (pull half, Fizzy #1745)",
			);
		},
	};
}
