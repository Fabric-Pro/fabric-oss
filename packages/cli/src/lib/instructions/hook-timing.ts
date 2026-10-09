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
 * is asked about again tomorrow. A hook that has no time for it starts it in a
 * detached child instead (`self-update.ts`), which holds none of the hook's
 * pipes and has a budget of its own.
 *
 * `processStartedAt` is when the Node process began, set by the binary's entry
 * point: the deadline counts from there, so Node's own start-up is inside it
 * and not on top of it. Time before Node runs (an `npx` or `.cmd` shim
 * starting it) and the hook's last writes after the deadline fires are outside
 * it, which is why it is 9.5 seconds and not the ten a session gives a hook:
 * a hook that gives up has still left within ten. `exitWhenDone` makes hook mode end
 * the process once its output is written, so a descendant that still holds the
 * output pipes cannot keep the session waiting for the hook; only the entry
 * point sets it, so a test that runs the command in-process is not ended.
 */
export const hookTiming = {
	deadlineMs: 9_500,
	gitMarginMs: 750,
	selfUpdateBudgetMs: 4_000,
	selfUpdateMarginMs: 1_000,
	processStartedAt: undefined as number | undefined,
	exitWhenDone: false,
};

/** Milliseconds from the process start to `now`, or 0 when the start is not known (a test). */
export function sinceProcessStart(now: number = Date.now()): number {
	return hookTiming.processStartedAt === undefined
		? 0
		: Math.max(0, now - hookTiming.processStartedAt);
}
