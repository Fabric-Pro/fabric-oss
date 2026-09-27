/**
 * Provider adapters for Coding Instructions proposal pull requests (Fizzy
 * #2563 spec §10). Fixtures recorded from each provider are still owed
 * (plan R19); the tests use hand-built responses to the documented shapes.
 */
import { azureDevOps } from "./azure-devops";
import { github } from "./github";
import { gitlab } from "./gitlab";
import type {
	InstructionPullRequestAdapter,
	RepositoryProviderName,
} from "./types";

export { adoApiBase, azureDevOps } from "./azure-devops";
export {
	LOOKUP_TIMEOUT_MS,
	MAX_PAGES,
	OPEN_TIMEOUT_MS,
} from "./classify";
export {
	AZURE_DEVOPS_DESCRIPTION_LIMIT,
	azureDevOpsDescription,
	DESCRIPTION_LIMITS,
	fitDescription,
} from "./description";
export { github } from "./github";
export { gitlab } from "./gitlab";
export {
	credentialFreeUrl,
	repositoryIdentity,
	repositoryKey,
	sameRepository,
} from "./repository-identity";
export * from "./types";

export function adapterFor(
	provider: RepositoryProviderName,
): InstructionPullRequestAdapter {
	switch (provider) {
		case "GITHUB":
			return github;
		case "GITLAB":
			return gitlab;
		case "AZURE_DEVOPS":
			return azureDevOps;
		default:
			throw new Error(`No pull-request adapter for ${String(provider)}`);
	}
}

/**
 * The ref and expected SHA a caller should fetch to verify a pull request's
 * source head (spec §7 "Adapters"). Naming only: the fetch and the
 * `rev-parse` equality against `observedHeadSha` are `fetchPullRequestHead`'s
 * job. `unavailable` when the provider has no such ref (Azure DevOps) or
 * `externalId` fails the adapter's own validation.
 */
export function sourceHeadEvidence(
	adapter: InstructionPullRequestAdapter,
	externalId: string,
	observedHeadSha: string,
): { ref: string; expectSha: string } | { kind: "unavailable" } {
	const ref = adapter.pullRequestHeadRef(externalId);
	if (ref === null) {
		return { kind: "unavailable" };
	}
	return { ref, expectSha: observedHeadSha };
}
