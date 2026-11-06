/**
 * What `fabric instructions sync` says when the project has no published
 * coding instructions: none were ever published, or a project admin removed
 * them all. A recognised state, not a failure, as `check` (exit 0) and
 * doctor (a warning, exit 0) already treat it. The sync writes nothing and
 * deletes nothing, so a developer's local copy stays exactly as it was.
 */
import { HOOK_PREFIX } from "./outcome.js";

/** The `code` a `--format json` run reports, the one `push` maps too. */
const NOTHING_PUBLISHED_CODE = "NOTHING_PUBLISHED" as const;

/**
 * A person's run: what is true, that nothing local was touched, and for an
 * uploaded project the way to start again. A repository-sourced project's
 * first version comes from its repository instead.
 */
export function nothingPublishedSyncLine(uploaded: boolean): string {
	const line =
		"This project has no published coding instructions. Nothing was written or removed here; your local copy, if this folder has one, was left as it is.";
	return uploaded
		? `${line} A first version is uploaded from the project's Coding Instructions tab.`
		: line;
}

/**
 * Why `push` sends nothing for a project with nothing published, and where
 * its first version comes from: the tab for an uploaded project, the
 * repository for one whose instructions are mirrored from it.
 */
export function nothingPublishedPushLine(uploaded: boolean): string {
	return uploaded
		? "this project has no published coding instructions to change yet; the first version is uploaded from the Coding Instructions tab"
		: "this project has no published coding instructions yet; they come from its repository, so commit there and Fabric publishes them on its next sync. Nothing was sent";
}

/**
 * A session hook's one quiet line, on stderr, the same words the hook has
 * always printed for a project with nothing published.
 */
export const NOTHING_PUBLISHED_HOOK_LINE = `${HOOK_PREFIX} sync skipped: This project has no published coding instructions yet.`;

/** The `--format json` object. */
export function nothingPublishedJson(input: {
	projectId: string;
	destination: string;
	uploaded: boolean;
}): {
	projectId: string;
	destination: string;
	published: false;
	code: typeof NOTHING_PUBLISHED_CODE;
	message: string;
} {
	return {
		projectId: input.projectId,
		destination: input.destination,
		published: false,
		code: NOTHING_PUBLISHED_CODE,
		message: nothingPublishedSyncLine(input.uploaded),
	};
}
