/**
 * How a caller reports a refused `open`: one log record and one short reason
 * for a person, both built only from the error's sanitized diagnostic
 * (`providerStatus`, `providerMessage`, `requiredPermissions`; see
 * `classify.ts`). Nothing here reads a response.
 */
import type {
	InstructionPullRequestError,
	RepositoryIdentity,
	RepositoryProviderName,
} from "./types";

const PROVIDER_LABEL: Record<RepositoryProviderName, string> = {
	GITHUB: "GitHub",
	GITLAB: "GitLab",
	AZURE_DEVOPS: "Azure DevOps",
};

/** The fields to log when `open` fails. Safe to log: no token, URL or raw body. */
export function refusalLogFields(error: InstructionPullRequestError): {
	code: string;
	cause: string;
	status: number | null;
	providerMessage: string | null;
	requiredPermissions: string | null;
} {
	return {
		code: error.code,
		cause: error.cause,
		status: error.providerStatus ?? null,
		providerMessage: error.providerMessage ?? null,
		requiredPermissions: error.requiredPermissions ?? null,
	};
}

/**
 * `GitHub 422: Validation Failed — base: invalid`, or `GitHub 403` without a
 * message. Undefined when the provider answered nothing (a timeout).
 */
export function refusalReason(
	provider: RepositoryProviderName,
	error: InstructionPullRequestError,
): string | undefined {
	if (error.providerStatus === undefined) {
		return undefined;
	}
	const head = `${PROVIDER_LABEL[provider]} ${error.providerStatus}`;
	return error.providerMessage ? `${head}: ${error.providerMessage}` : head;
}

/**
 * GitHub's `X-Accepted-GitHub-Permissions` in words: `pull_requests=write`
 * reads "Pull requests (write)". Sets separated by `;` are alternatives;
 * permissions within a set separated by `,` are all required.
 */
export function githubPermissionsInWords(header: string): string {
	return header
		.split(";")
		.map((set) =>
			set
				.split(",")
				.map((pair) => {
					const [name = "", level] = pair.trim().split("=");
					const words = name.trim().replace(/_/g, " ");
					const label =
						words.charAt(0).toUpperCase() + words.slice(1);
					return level ? `${label} (${level.trim()})` : label;
				})
				.filter((p) => p !== "")
				.join(" and "),
		)
		.filter((s) => s !== "")
		.join(" or ");
}

/** The repository a refusal was about, by name only, for a log record. */
export function repositoryLogFields(identity: RepositoryIdentity): {
	provider: RepositoryProviderName;
	owner: string;
	name: string;
} {
	switch (identity.provider) {
		case "GITHUB":
			return {
				provider: identity.provider,
				owner: identity.owner,
				name: identity.repo,
			};
		case "GITLAB": {
			const cut = identity.projectPath.lastIndexOf("/");
			return {
				provider: identity.provider,
				owner: identity.projectPath.slice(0, Math.max(cut, 0)),
				name: identity.projectPath.slice(cut + 1),
			};
		}
		case "AZURE_DEVOPS":
			return {
				provider: identity.provider,
				owner: `${identity.organization}/${identity.project}`,
				name: identity.repository,
			};
	}
}
