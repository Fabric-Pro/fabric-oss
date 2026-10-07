import type { RepositoryCommit } from "@repo/connectors";
import { FALLBACK_PROPOSER_NAME, scanTextForSecrets } from "@repo/instructions";

export type RepositoryCommitOverlay = {
	published: number | null;
	refused: boolean;
};

const FABRIC_TRAILER = /^Fabric-(?:Commit|Change): /m;

function holdsSecret(text: string): boolean {
	return scanTextForSecrets(text, { limit: 0 }).total > 0;
}

/**
 * The commit metadata every instructions history surface may safely expose.
 * Provider messages and authors use the same secret withholding rule as the
 * repository sync history, while direct history intentionally has no snapshot
 * publication overlay.
 */
export function presentRepositoryCommit(
	commit: RepositoryCommit,
	overlay: RepositoryCommitOverlay = { published: null, refused: false },
) {
	const messageWithheld = holdsSecret(commit.message);
	return {
		sha: commit.sha,
		author: {
			name: holdsSecret(commit.authorName)
				? FALLBACK_PROPOSER_NAME
				: commit.authorName,
		},
		date: commit.date,
		message: messageWithheld ? null : commit.message,
		messageWithheld,
		url: commit.url,
		parent: commit.parent,
		published: overlay.published,
		refused: overlay.refused,
		isFabric:
			commit.committerName === "Fabric" ||
			FABRIC_TRAILER.test(commit.message),
	};
}
