/**
 * The one credential question the proposal steps share (Fizzy #2563 spec
 * §6.1 step 2, plan Decision 5): whether a failure is an authentication
 * failure, the one kind a credential re-exchange can cure. The member
 * proposal branch credential (`instruction-branch-credential.ts`) re-exchanges
 * on it, and `providerCall` and `gitCall` rethrow it untyped for that.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import { isGitAuthError } from "@repo/integrations";
import { InstructionPullRequestError } from "@repo/integrations/instruction-pull-requests";
import { GitCommandError } from "./instruction-sync-git";

/** An authentication failure from git or a provider: the one kind a re-exchange can cure. */
export function isCredentialFailure(error: unknown): boolean {
	if (error instanceof InstructionPullRequestError) {
		return error.code === "AUTHENTICATION_FAILED";
	}
	return (
		error instanceof GitCommandError &&
		error.kind === "exit" &&
		isGitAuthError(new Error(error.stderrTail))
	);
}
