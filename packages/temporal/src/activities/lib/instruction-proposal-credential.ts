/**
 * The recorded repository authority a proposal pull-request activity acts
 * under (Fizzy #2563 spec §6.1 step 2, §13.1, plan Decision 5): the row's
 * organization and project, the integration frozen in its context, and a
 * token resolved into a local. It mirrors `cloneWithAuthRecovery`: an
 * authentication failure forces one credential re-exchange and one more
 * run, and only then flags the integration for reconnect, with the
 * proposal's failure codes. The refresh actor is the proposer's user id, for
 * attribution only (R17); it grants nothing.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import path from "node:path";
import {
	getProjectRepoIntegration,
	type ProposalOperationRow,
} from "@repo/database";
import {
	type PullRequestContext,
	pullRequestContextSchema,
} from "@repo/instructions";
import {
	forceReExchangeRepoCredentials,
	isGitAuthError,
	markRepoReauthRequired,
	REPO_REAUTH_STEP_BOUND_MS,
	resolveFreshRepoToken,
} from "@repo/integrations";
import {
	adapterFor,
	type InstructionPullRequestAdapter,
	InstructionPullRequestError,
	repositoryIdentity,
	sameRepository,
	type Target,
} from "@repo/integrations/instruction-pull-requests";
import {
	assertMayContinue,
	assertTimeFor,
	ProposalStepFailure,
	timeGate,
} from "./instruction-proposal-boundary";
import {
	buildGitEnv,
	credentialFreeUrl,
	GitCommandError,
	gitUsernameFor,
} from "./instruction-sync-git";
import { createSyncRunDir, removeSyncRunDir } from "./instruction-sync-temp";
import { logGitFailure } from "./repository-sync-clone";

/**
 * The time an exchange needs left before the attempt's deadline to start.
 * Each credential helper takes the attempt's signal and checks it between
 * its steps, but an exchange already sent is left to finish: it spends a
 * single-use refresh token, and abandoning it loses the rotated grant. So
 * the helpers consult `exchangeGate` under the provider's lock, immediately
 * before the request, once the row reads, pool admission and lock wait have
 * been spent. From there the exchange (10 s deadline) and the write
 * persisting it finish inside what is left of the lock transaction's 20 s
 * timeout, well within this bound. A PAT or still-fresh token sends nothing
 * and is never gated, so a cheap lookup proceeds with less left.
 */
const CREDENTIAL_EXCHANGE_BOUND_MS = 30_000;

/** Everything a step needs to reach the repository; lives only in the activity's memory. */
export type ProposalCredential = {
	context: PullRequestContext;
	/** Credential-free (`credentialFreeUrl`); the token reaches git only through `env`. */
	url: string;
	env: NodeJS.ProcessEnv;
	/** The token and its Azure DevOps form, for `redactSecrets` (spec §13.1). */
	secrets: readonly string[];
	/** The activity's scratch directory; `workDir` is this pass's clone path. */
	runDir: string;
	workDir: string;
	signal: AbortSignal;
	adapter: InstructionPullRequestAdapter;
	/** The adapter call's target; the token appears only here and in `env`. */
	target: Target;
	integrationId: string;
};

/** The frozen context, or a non-retryable refusal when the stored value is not one. */
function proposalContextOf(
	row: Pick<ProposalOperationRow, "pullRequestContext">,
	phase: ProposalStepFailure["phase"],
): PullRequestContext {
	const parsed = pullRequestContextSchema.safeParse(row.pullRequestContext);
	if (!parsed.success) {
		throw new ProposalStepFailure({
			code: "CONFIGURATION_CHANGED",
			phase,
			retryable: false,
		});
	}
	return parsed.data;
}

/** Both spellings of a token that may reach a log (spec §13.1). */
function secretsFor(token: string): string[] {
	return [token, Buffer.from(`:${token}`).toString("base64")];
}

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

/**
 * Runs `fn` under the recorded credential. `unavailable` is the code a
 * missing or dead credential records: `AUTHENTICATION_FAILED` for open and
 * recovery, `CLOSE_CREDENTIALS_UNAVAILABLE` for close (spec §11). A second
 * run after a re-exchange starts `fn` from the top in a fresh `workDir`;
 * every step `fn` takes is fenced and idempotent, so a repeated step is
 * recovered rather than redone.
 */
export async function withProposalRepoCredential<R>(
	input: {
		row: ProposalOperationRow;
		phase: ProposalStepFailure["phase"];
		unavailable: "AUTHENTICATION_FAILED" | "CLOSE_CREDENTIALS_UNAVAILABLE";
		signal: AbortSignal;
	},
	fn: (credential: ProposalCredential) => Promise<R>,
): Promise<R> {
	const { row, phase } = input;
	const context = proposalContextOf(row, phase);
	const unavailable = () =>
		new ProposalStepFailure({
			code: input.unavailable,
			phase,
			retryable: true,
		});
	const integration = await getProjectRepoIntegration(
		context.integrationId,
		row.projectId,
	);
	// Every await here is checked before its result is read: an answer that
	// arrives after the attempt must stop is the stop, never a verdict.
	assertMayContinue(input.signal);
	if (!integration) {
		throw unavailable();
	}
	const url = credentialFreeUrl(integration.repositoryUrl);
	if (url === null || integration.provider !== context.provider) {
		throw new ProposalStepFailure({
			code: "REPOSITORY_UNAVAILABLE",
			phase,
			retryable: true,
		});
	}
	// The id and generation do not pin the repository: the integration's URL
	// can be re-pointed under both. The live URL must still name exactly the
	// repository admission froze, or nothing reaches git or the provider.
	const live = repositoryIdentity(
		integration.provider,
		integration.repositoryUrl,
	);
	if (live === null || !sameRepository(live, context.repository)) {
		throw new ProposalStepFailure({
			code: "CONFIGURATION_CHANGED",
			phase,
			retryable: false,
		});
	}
	const exchangeGate = timeGate(CREDENTIAL_EXCHANGE_BOUND_MS, input.signal);
	const resolve = async () => {
		const resolved = await resolveFreshRepoToken({
			integrationId: context.integrationId,
			projectId: row.projectId,
			userId: row.userId,
			organizationId: row.organizationId,
			signal: input.signal,
			beforeExchange: exchangeGate,
		});
		assertMayContinue(input.signal);
		return resolved;
	};
	const first = await resolve();
	if (!first.token) {
		throw unavailable();
	}
	const runDir = await createSyncRunDir();
	const credentialFor = (
		token: string,
		authMethod: string | null,
		pass: number,
	): ProposalCredential => ({
		context,
		url,
		env: buildGitEnv({
			home: runDir,
			username: gitUsernameFor(context.provider),
			credential: token,
			host: new URL(url).host,
		}),
		secrets: secretsFor(token),
		runDir,
		workDir: path.join(runDir, `repo-${pass}`),
		signal: input.signal,
		adapter: adapterFor(context.provider),
		target: {
			auth: {
				token,
				authMethod:
					(authMethod ?? integration.authMethod) === "PAT"
						? "PAT"
						: "OAUTH",
			},
			repository: context.repository,
			signal: input.signal,
		},
		integrationId: context.integrationId,
	});
	const log = {
		event: "instruction_proposal.git_failed",
		message: "Instruction proposal git step failed",
	};
	try {
		try {
			return await fn(credentialFor(first.token, first.authMethod, 0));
		} catch (error) {
			logGitFailure(error, secretsFor(first.token), log);
			if (!isCredentialFailure(error)) {
				throw error;
			}
		}
		const { refreshed } = await forceReExchangeRepoCredentials({
			integrationId: context.integrationId,
			userId: row.userId,
			organizationId: row.organizationId,
			signal: input.signal,
			beforeExchange: exchangeGate,
		});
		assertMayContinue(input.signal);
		const fresh = refreshed ? await resolve() : null;
		if (fresh?.token) {
			try {
				return await fn(
					credentialFor(fresh.token, fresh.authMethod, 1),
				);
			} catch (error) {
				logGitFailure(error, secretsFor(fresh.token), log);
				if (!isCredentialFailure(error)) {
					throw error;
				}
			}
		}
		// Bounded on its own: the status write (a transaction and a statement
		// timeout) and then the best-effort notification (its own deadline).
		// It starts only with both bounds left.
		assertTimeFor(REPO_REAUTH_STEP_BOUND_MS, input.signal);
		await markRepoReauthRequired({
			integrationId: context.integrationId,
			reason: "Instruction proposal pull request could not authenticate",
			signal: input.signal,
		});
		assertMayContinue(input.signal);
		throw unavailable();
	} finally {
		await removeSyncRunDir(runDir).catch(() => {});
	}
}
