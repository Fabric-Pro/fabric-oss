/**
 * The session hook's clock (Fizzy #2708), in one mutable object so a test can
 * shorten it instead of waiting ten real seconds. Nothing in the CLI writes
 * to it.
 *
 * `deadlineMs` bounds the whole of hook mode, the bundle download included
 * (`withDeadline` in `commands/instructions/index.ts`). `gitMarginMs` is how
 * long before that deadline every git command a repository-sourced project's
 * hook runs must already have stopped: the git calls and the outer timer
 * would otherwise share one instant, and at that instant the outer timer's
 * generic "skipped" line on stderr could win over the repository's own
 * `unknown` line on stdout — the one a session actually reads.
 */
export const hookTiming = {
	deadlineMs: 10_000,
	gitMarginMs: 750,
};
