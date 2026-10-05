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
 *
 * `selfUpdateBudgetMs` and `selfUpdateMarginMs` bound the kept copy's daily
 * update (`self-update.ts`), which runs after the hook's own output is
 * written and so can only delay the process's exit, never what it printed. It
 * starts only when the budget plus the margin still fit in what is left of
 * `deadlineMs`, so a hook that already spent half its deadline on a slow
 * network skips it and one that finished in the usual second or so has it
 * ended at least a second before the deadline. The served tarball is about
 * 400 KB, which four seconds carries at one megabit per second with the
 * manifest read besides; a slower connection abandons the attempt and the copy
 * is asked about again tomorrow.
 */
export const hookTiming = {
	deadlineMs: 10_000,
	gitMarginMs: 750,
	selfUpdateBudgetMs: 4_000,
	selfUpdateMarginMs: 1_000,
};
