/**
 * What each code host has to answer so a pull request can be reviewed.
 *
 * The review itself is provider-agnostic and always was: the lenses read a
 * unified diff, `groundFindings` verifies a cited line against that diff's
 * hunks, and the comment is markdown. Only three questions differ per host, and
 * they are the whole of this file: where the change lives, what its diff is, and
 * how a comment is written and later edited.
 *
 * **Every provider returns a unified diff**, including the two that do not
 * natively produce one. That is deliberate. GitHub hands back a unified diff for
 * a whole pull request; GitLab and Azure DevOps return per-file structures. The
 * alternative was to teach the line numbering, the path parser and the grounding
 * filter about three shapes, and each of those is a place a finding gets its
 * location wrong. Assembling one format here means the rest of the feature
 * cannot tell the hosts apart.
 */

import { ORPCError } from "@orpc/client";

/** One file's change, as the assemblers hand it over. */
export interface ProviderFileChange {
	/** Path in the new tree, or the old one for a deletion. */
	path: string;
	/** The old path when the file moved. */
	previousPath?: string;
	/**
	 * The hunks, already in unified form (`@@ -a,b +c,d @@` and its lines).
	 * GitLab and Azure both return this text per file; only the envelope differs.
	 */
	diff: string;
	isNew?: boolean;
	isDeleted?: boolean;
	isRenamed?: boolean;
}

/** What a host says about the change itself. */
interface ProviderPullRequest {
	title: string;
	authorLabel: string | null;
	headSha: string;
	baseSha: string;
	webUrl: string | null;
	changedFiles: number;
}

/** A comment Fabric has written, as the host identifies it. */
interface ProviderComment {
	/**
	 * The host's own id for the comment, stored so a later run edits it rather
	 * than searching. Azure needs two: see {@link AZURE_COMMENT_ID_SCALE}.
	 */
	id: number;
	webUrl: string | null;
}

/**
 * Assemble per-file changes into the unified diff the rest of the feature reads.
 *
 * The `diff --git` and `+++ b/` headers matter beyond decoration: `diffFilePaths`
 * parses them to decide whether a finding cites a file the change actually
 * touched, and a finding that fails that check is discarded. A host that omits
 * them would have every one of its findings dropped as ungrounded.
 */
export function toUnifiedDiff(files: ProviderFileChange[]): string {
	const out: string[] = [];
	for (const file of files) {
		const oldPath = file.isNew
			? "/dev/null"
			: `a/${file.previousPath ?? file.path}`;
		const newPath = file.isDeleted ? "/dev/null" : `b/${file.path}`;
		out.push(
			`diff --git a/${file.previousPath ?? file.path} b/${file.path}`,
		);
		if (file.isNew) {
			out.push("new file mode 100644");
		}
		if (file.isDeleted) {
			out.push("deleted file mode 100644");
		}
		if (file.isRenamed && file.previousPath) {
			out.push(
				`rename from ${file.previousPath}`,
				`rename to ${file.path}`,
			);
		}
		out.push(`--- ${oldPath}`, `+++ ${newPath}`);
		const body = file.diff.replace(/\n+$/, "");
		if (body) {
			out.push(body);
		}
	}
	return out.join("\n");
}

/**
 * Azure identifies a comment by thread AND comment, so one number has to carry
 * both. The thread id is multiplied by this and the comment id added, which is
 * safe because Azure comment ids within a thread are small (they start at 1 and
 * count up per thread) and thread ids are well under the range that would push
 * the product past a safe integer.
 *
 * Chosen over adding a second column because the column exists, holds a BigInt,
 * and every other host needs exactly one number.
 */
const AZURE_COMMENT_ID_SCALE = 1_000_000;

export function packAzureCommentId(
	threadId: number,
	commentId: number,
): number {
	return threadId * AZURE_COMMENT_ID_SCALE + commentId;
}

export function unpackAzureCommentId(packed: number): {
	threadId: number;
	commentId: number;
} {
	return {
		threadId: Math.floor(packed / AZURE_COMMENT_ID_SCALE),
		commentId: packed % AZURE_COMMENT_ID_SCALE,
	};
}

/**
 * Everything a host needs to address one pull request.
 *
 * `azureOrganization` sits here rather than in an Azure-only variant because the
 * caller reads one integration row and hands it over whole. Every other host
 * ignores it.
 */
interface ProviderTarget {
	token: string;
	repositoryUrl: string;
	repositoryOwner: string;
	repositoryName: string;
	azureOrganization?: string | null;
	prNumber: number;
}

/** The three questions a host must answer. */
export interface PrReviewProvider {
	/** Read the change and its diff, already unified. */
	read(input: ProviderTarget & { maxDiffBytes: number }): Promise<{
		pullRequest: ProviderPullRequest;
		diff: string | null;
		diffTruncated: boolean;
		/** Why the diff is null, in words a reader can act on. */
		failureText: string | null;
	}>;

	/** Write a new comment. */
	createComment(
		input: ProviderTarget & { body: string },
	): Promise<ProviderComment>;

	/**
	 * Edit one Fabric already wrote. Resolves to null when the host says it is
	 * gone, so the caller creates a fresh one rather than failing forever.
	 */
	editComment(
		input: ProviderTarget & { commentId: number; body: string },
	): Promise<ProviderComment | null>;
}

/**
 * Compose the error a host's refusal becomes.
 *
 * Built from the status alone, never the response body. Every one of these hosts
 * can echo the request back inside an error envelope, and the request carries
 * the token.
 */
export function hostRefused(
	status: number,
	what: string,
): ORPCError<string, unknown> {
	return new ORPCError("BAD_REQUEST", {
		message:
			status === 403 || status === 401
				? `The connected credential is not allowed to ${what} on this repository.`
				: status === 404
					? `Could not ${what}: the code host answered 404.`
					: `The code host refused to ${what} (HTTP ${status}).`,
	});
}

/**
 * Cut a diff to a byte budget, not a character count.
 *
 * `String.length` counts UTF-16 units, so a diff full of non-ASCII source or
 * comments can sit well past a cap named in bytes while the check says it is
 * under. The name promised bytes; this keeps the promise.
 *
 * Cuts on a line boundary, because half a hunk header teaches the model a line
 * number that does not exist, and the grounding filter would then discard every
 * finding citing it.
 */
export function truncateToBytes(
	text: string,
	maxBytes: number,
): { text: string; truncated: boolean } {
	if (Buffer.byteLength(text, "utf8") <= maxBytes) {
		return { text, truncated: false };
	}

	// `toString` on a buffer cut mid-character yields U+FFFD. Decoding in
	// stream mode instead holds the partial bytes back rather than replacing
	// them, so the result never carries a character the source did not have.
	const decoder = new TextDecoder("utf-8", { fatal: false });
	const cut = decoder.decode(
		Buffer.from(text, "utf8").subarray(0, maxBytes),
		{ stream: true },
	);

	// Cut on a line boundary where there is one: half a hunk header states a
	// line number that does not exist, and the grounding filter would then throw
	// away every finding citing it.
	//
	// A diff with no line break inside the budget is not hypothetical — a
	// minified asset or an embedded blob is exactly the case the cap exists for
	// — so that falls through to the byte cut, which is now clean either way.
	const lastBreak = cut.lastIndexOf("\n");
	return {
		text: lastBreak >= 0 ? cut.slice(0, lastBreak) : cut,
		truncated: true,
	};
}
