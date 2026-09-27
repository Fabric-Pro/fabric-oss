/**
 * The recorded repository authority a member proposal branch activity acts
 * under (Fizzy #2738 spec Decision 15, 18, 19): the branch's organization and
 * project, the integration frozen in its destination, and a token resolved
 * into a local. It mirrors `withProposalRepoCredential` (#2563), which
 * refuses a v2 context: an authentication failure forces one credential
 * re-exchange and one more run, and only then flags the integration for
 * reconnect. The refresh actor is the branch's member, for attribution only;
 * it grants nothing.
 *
 * The identity guard is Decision 19's: when the integration now names a
 * different repository than the branch froze, every branch activity stops
 * with the non-retryable REPOSITORY_CHANGED before anything reaches git or
 * the provider.
 *
 * Not re-exported from the activities barrel: every export of a module the
 * barrel re-exports becomes a schedulable Temporal activity.
 */
import path from "node:path";
import {
	type BranchRow,
	getProjectRepoIntegration,
	type PullRequestPhase,
} from "@repo/database";
import {
	type BranchDestination,
	branchDestinationSchema,
} from "@repo/instructions";
import {
	forceReExchangeRepoCredentials,
	markRepoReauthRequired,
	REPO_REAUTH_STEP_BOUND_MS,
	resolveFreshRepoToken,
} from "@repo/integrations";
import {
	adapterFor,
	type InstructionPullRequestAdapter,
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
import { isCredentialFailure } from "./instruction-proposal-credential";
import {
	buildGitEnv,
	credentialFreeUrl,
	gitUsernameFor,
} from "./instruction-sync-git";
import { createSyncRunDir, removeSyncRunDir } from "./instruction-sync-temp";
import { logGitFailure } from "./repository-sync-clone";

/** As #2563's: the time an exchange needs left before the attempt's deadline to start. */
const CREDENTIAL_EXCHANGE_BOUND_MS = 30_000;

/** Everything a branch step needs to reach the repository; lives only in the activity's memory. */
export type BranchCredential = {
	destination: BranchDestination;
	/** Credential-free (`credentialFreeUrl`); the token reaches git only through `env`. */
	url: string;
	env: NodeJS.ProcessEnv;
	/** The token and its Azure DevOps form, for `redactSecrets`. */
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

/** The branch's frozen destination, or a non-retryable refusal when the stored value is not one. */
export function destinationOf(
	branch: Pick<BranchRow, "destination">,
	phase: PullRequestPhase,
): BranchDestination {
	const parsed = branchDestinationSchema.safeParse(branch.destination);
	if (!parsed.success) {
		throw new ProposalStepFailure({
			code: "CONFIGURATION_CHANGED",
			phase,
			retryable: false,
		});
	}
	return parsed.data;
}

/** REPOSITORY_CHANGED (spec §9): the integration names another repository now. */
export function repositoryChanged(
	phase: PullRequestPhase,
): ProposalStepFailure {
	return new ProposalStepFailure({
		code: "REPOSITORY_CHANGED",
		phase,
		retryable: false,
	});
}

function secretsFor(token: string): string[] {
	return [token, Buffer.from(`:${token}`).toString("base64")];
}

/**
 * Runs `fn` under the branch's recorded credential. A second run after a
 * re-exchange starts `fn` from the top in a fresh `workDir`; every step `fn`
 * takes is fenced and idempotent, so a repeated step is recovered rather
 * than redone.
 */
export async function withBranchRepoCredential<R>(
	input: {
		branch: Pick<
			BranchRow,
			"id" | "projectId" | "userId" | "organizationId" | "destination"
		>;
		phase: PullRequestPhase;
		signal: AbortSignal;
	},
	fn: (credential: BranchCredential) => Promise<R>,
): Promise<R> {
	const { branch, phase } = input;
	const destination = destinationOf(branch, phase);
	const unavailable = () =>
		new ProposalStepFailure({
			code: "AUTHENTICATION_FAILED",
			phase,
			retryable: true,
		});
	const integration = await getProjectRepoIntegration(
		destination.integrationId,
		branch.projectId,
	);
	assertMayContinue(input.signal);
	if (!integration) {
		throw unavailable();
	}
	if (integration.provider !== destination.provider) {
		throw repositoryChanged(phase);
	}
	const url = credentialFreeUrl(integration.repositoryUrl);
	if (url === null) {
		throw new ProposalStepFailure({
			code: "REPOSITORY_UNAVAILABLE",
			phase,
			retryable: true,
		});
	}
	// Decision 19: the id and generation do not pin the repository, so the
	// live URL must still name exactly the repository the branch froze.
	const live = repositoryIdentity(
		integration.provider,
		integration.repositoryUrl,
	);
	if (live === null || !sameRepository(live, destination.repository)) {
		throw repositoryChanged(phase);
	}
	const exchangeGate = timeGate(CREDENTIAL_EXCHANGE_BOUND_MS, input.signal);
	const resolve = async () => {
		const resolved = await resolveFreshRepoToken({
			integrationId: destination.integrationId,
			projectId: branch.projectId,
			userId: branch.userId,
			organizationId: branch.organizationId,
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
	): BranchCredential => ({
		destination,
		url,
		env: buildGitEnv({
			home: runDir,
			username: gitUsernameFor(destination.provider),
			credential: token,
			host: new URL(url).host,
		}),
		secrets: secretsFor(token),
		runDir,
		workDir: path.join(runDir, `repo-${pass}`),
		signal: input.signal,
		adapter: adapterFor(destination.provider),
		target: {
			auth: {
				token,
				authMethod:
					(authMethod ?? integration.authMethod) === "PAT"
						? "PAT"
						: "OAUTH",
			},
			repository: destination.repository,
			signal: input.signal,
		},
		integrationId: destination.integrationId,
	});
	const log = {
		event: "instruction_proposal_branch.git_failed",
		message: "Instruction proposal branch git step failed",
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
			integrationId: destination.integrationId,
			userId: branch.userId,
			organizationId: branch.organizationId,
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
		assertTimeFor(REPO_REAUTH_STEP_BOUND_MS, input.signal);
		await markRepoReauthRequired({
			integrationId: destination.integrationId,
			reason: "Instruction proposal branch could not authenticate",
			signal: input.signal,
		});
		assertMayContinue(input.signal);
		throw unavailable();
	} finally {
		await removeSyncRunDir(runDir).catch(() => {});
	}
}
