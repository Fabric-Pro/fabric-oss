/**
 * The clone both repository syncs share: the Coding Instructions sync
 * (design 2026-09-23 §5.3.2) and the Living Memory sync (§5.3.1 steps 1–2,
 * Fizzy #2657). Token acquisition, the credential-scoped git environment, the
 * self-healing re-exchange after an authentication failure, and the mapping
 * of a failed git command to the four failure codes the two syncs' enums
 * share. Each caller turns a code into its own `ApplicationFailure`.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import { rm } from "node:fs/promises";
import {
	forceReExchangeRepoCredentials,
	isGitAuthError,
	markRepoReauthRequired,
	resolveFreshRepoToken,
} from "@repo/integrations";
import { logger } from "@repo/logs";
import {
	buildGitEnv,
	classifyGitFailure,
	cloneTreeless,
	GitCommandError,
	gitUsernameFor,
	redactSecrets,
} from "./instruction-sync-git";

/** The failure codes a clone or a later git step maps to, in both syncs' enums. */
export type RepositoryCloneFailureCode =
	| "LIMITS_EXCEEDED"
	| "REF_MISSING"
	| "INTEGRATION_UNAVAILABLE"
	| "CLONE_FAILED";

/** How a caller names its git failures in the debug log. */
export type GitFailureLog = { event: string; message: string };

/** Debug level only, after redaction (spec §8.3 of both designs). */
export function logGitFailure(
	error: unknown,
	secrets: readonly string[],
	log: GitFailureLog,
): void {
	if (error instanceof GitCommandError) {
		logger.debug(
			{
				event: log.event,
				label: error.label,
				kind: error.kind,
				exitCode: error.exitCode,
				stderr: redactSecrets(error.stderrTail, secrets),
			},
			log.message,
		);
	}
}

/** A git failure after the clone: the watchdog is a limit, everything else a failed fetch. */
export function gitStepFailureCode(
	error: unknown,
): "LIMITS_EXCEEDED" | "CLONE_FAILED" {
	return error instanceof GitCommandError && error.kind === "disk_limit"
		? "LIMITS_EXCEEDED"
		: "CLONE_FAILED";
}

function isAuthFailure(error: unknown): boolean {
	return (
		error instanceof GitCommandError &&
		error.kind === "exit" &&
		isGitAuthError(new Error(error.stderrTail))
	);
}

/** A failed clone, from its kind and (for an exit) its stderr. */
export function cloneFailureCode(error: unknown): RepositoryCloneFailureCode {
	if (error instanceof GitCommandError) {
		if (error.kind === "disk_limit") {
			return "LIMITS_EXCEEDED";
		}
		if (error.kind === "exit") {
			const kind = classifyGitFailure(error.stderrTail);
			if (kind === "ref_missing") {
				return "REF_MISSING";
			}
			if (kind === "repo_not_found") {
				return "INTEGRATION_UNAVAILABLE";
			}
		}
	}
	return "CLONE_FAILED";
}

/**
 * The clone, with the code-indexing clone's self-heal: an authentication
 * failure forces one credential re-exchange and one more clone, and only
 * then flags the integration for reconnect. Throws what `fail` builds:
 *
 *  - no token, or a re-exchange that could not help →
 *    `INTEGRATION_UNAVAILABLE`, non-retryable (retrying cannot help);
 *  - any other clone failure → `cloneFailureCode` of it.
 *
 * The token reaches git only through `buildGitEnv`'s host-scoped askpass
 * helper; `url` must be `credentialFreeUrl`'s output.
 */
export async function cloneWithAuthRecovery(input: {
	integrationId: string;
	projectId: string;
	userId: string;
	organizationId: string;
	ref: string;
	provider: string;
	url: string;
	runDir: string;
	dir: string;
	signal: AbortSignal;
	log: GitFailureLog;
	/** What `markRepoReauthRequired` records as the reason. */
	reauthReason: string;
	fail: (code: RepositoryCloneFailureCode, nonRetryable?: boolean) => Error;
}): Promise<{ env: NodeJS.ProcessEnv; token: string }> {
	const resolveToken = async () =>
		(
			await resolveFreshRepoToken({
				integrationId: input.integrationId,
				projectId: input.projectId,
				userId: input.userId,
				organizationId: input.organizationId,
			})
		).token;
	const attempt = async (token: string) => {
		const env = buildGitEnv({
			home: input.runDir,
			username: gitUsernameFor(input.provider),
			credential: token,
			host: new URL(input.url).host,
		});
		await rm(input.dir, { recursive: true, force: true });
		await cloneTreeless({
			cwd: input.runDir,
			url: input.url,
			ref: input.ref,
			dir: input.dir,
			env,
			signal: input.signal,
		});
		return { env, token };
	};
	const token = await resolveToken();
	if (!token) {
		throw input.fail("INTEGRATION_UNAVAILABLE", true);
	}
	try {
		return await attempt(token);
	} catch (error) {
		logGitFailure(error, [token], input.log);
		if (!isAuthFailure(error)) {
			throw input.fail(cloneFailureCode(error));
		}
	}
	const { refreshed } = await forceReExchangeRepoCredentials({
		integrationId: input.integrationId,
		userId: input.userId,
		organizationId: input.organizationId,
	});
	const fresh = refreshed ? await resolveToken() : null;
	if (fresh) {
		try {
			return await attempt(fresh);
		} catch (error) {
			logGitFailure(error, [fresh], input.log);
			if (!isAuthFailure(error)) {
				throw input.fail(cloneFailureCode(error));
			}
		}
	}
	await markRepoReauthRequired({
		integrationId: input.integrationId,
		reason: input.reauthReason,
	});
	// Retrying cannot help once a forced re-exchange failed.
	throw input.fail("INTEGRATION_UNAVAILABLE", true);
}
