/** A committed change is announced after rereading, or after this deadline. */
export const COMMIT_REREAD_TIMEOUT_MS = 10_000;

type CommitRereadResult = "success" | "rejected" | "timeout";

export async function rereadInstructionCommit(
	callbacks: readonly (() => Promise<void> | void)[],
): Promise<CommitRereadResult> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const rereads = Promise.allSettled(
		callbacks.map((callback) => Promise.resolve().then(callback)),
	).then(
		(outcomes): CommitRereadResult =>
			outcomes.some((outcome) => outcome.status === "rejected")
				? "rejected"
				: "success",
	);
	const deadline = new Promise<CommitRereadResult>((resolve) => {
		timer = setTimeout(() => resolve("timeout"), COMMIT_REREAD_TIMEOUT_MS);
	});
	try {
		return await Promise.race([rereads, deadline]);
	} finally {
		clearTimeout(timer);
	}
}
