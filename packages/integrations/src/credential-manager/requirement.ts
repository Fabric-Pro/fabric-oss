/**
 * What a consumer needs from a credential, and whether a given
 * credential satisfies it. Pure: the picker, the server-side bind check and
 * the resolver all call `checkCredentialRequirement`, so a row the picker
 * offers is a row the server accepts.
 */

import type { CredentialMetadata } from "@repo/database";

export type CredentialProviderName = CredentialMetadata["provider"];
export type CredentialKindName = CredentialMetadata["kind"];

export type CredentialRequirement = {
	provider: CredentialProviderName;
	kinds: readonly CredentialKindName[];
	/** OAuth scopes (or installation permissions) the feature calls need. */
	scopes?: readonly string[];
	/** When the target is one instance (self-managed GitLab, GHES). */
	origin?: string;
	/** Whose identity the provider must see. Omitted = either. */
	principal?: "APP" | "USER";
};

export type RequirementFailure =
	| { code: "provider-mismatch" }
	| { code: "kind-not-accepted"; kind: CredentialKindName }
	| { code: "origin-mismatch"; origin: string }
	| { code: "principal-mismatch" }
	| { code: "insufficient-scope"; missing: string[] }
	| { code: "revoked" }
	| { code: "needs-reauth" };

/**
 * Scopes a granted scope implies. GitHub's are documented on "Scopes for
 * OAuth apps"; GitLab's `api` covers the read scopes. A scope implies itself.
 */
const IMPLIED_SCOPES: Partial<
	Record<CredentialProviderName, Record<string, readonly string[]>>
> = {
	GITHUB: {
		repo: ["repo:status", "repo_deployment", "public_repo", "repo:invite"],
		project: ["read:project"],
		"write:org": ["read:org"],
		"admin:org": ["write:org", "read:org"],
		user: ["read:user", "user:email"],
		workflow: [],
	},
	GITLAB: {
		api: ["read_api", "read_repository", "read_user"],
		write_repository: ["read_repository"],
	},
};

export function expandScopes(
	provider: CredentialProviderName,
	granted: readonly string[],
): Set<string> {
	const implied = IMPLIED_SCOPES[provider] ?? {};
	const result = new Set<string>();
	for (const scope of granted) {
		result.add(scope);
		for (const extra of implied[scope] ?? []) {
			result.add(extra);
		}
	}
	return result;
}

/**
 * `origin` compared on scheme + host + port, case-insensitively, without a
 * trailing slash: `https://GitHub.com/` and `https://github.com` are one
 * origin.
 */
export function normalizeOrigin(origin: string): string {
	try {
		return new URL(origin).origin.toLowerCase();
	} catch {
		return origin.trim().replace(/\/+$/, "").toLowerCase();
	}
}

export function checkCredentialRequirement(
	credential: Pick<
		CredentialMetadata,
		"provider" | "kind" | "origin" | "principal" | "scopes" | "status"
	>,
	requirement: CredentialRequirement,
): RequirementFailure[] {
	const failures: RequirementFailure[] = [];
	if (credential.provider !== requirement.provider) {
		return [{ code: "provider-mismatch" }];
	}
	if (credential.status === "REVOKED") {
		failures.push({ code: "revoked" });
	} else if (credential.status === "NEEDS_REAUTH") {
		failures.push({ code: "needs-reauth" });
	}
	if (!requirement.kinds.includes(credential.kind)) {
		failures.push({ code: "kind-not-accepted", kind: credential.kind });
	}
	if (
		requirement.origin &&
		normalizeOrigin(requirement.origin) !==
			normalizeOrigin(credential.origin)
	) {
		failures.push({ code: "origin-mismatch", origin: credential.origin });
	}
	if (
		requirement.principal &&
		requirement.principal !== credential.principal
	) {
		failures.push({ code: "principal-mismatch" });
	}
	// A PAT or API key often cannot report its scopes; an empty list means
	// "unknown", and the first call proves it. Only a reported list can fail.
	if (requirement.scopes?.length && credential.scopes.length > 0) {
		const granted = expandScopes(credential.provider, credential.scopes);
		const missing = requirement.scopes.filter((s) => !granted.has(s));
		if (missing.length > 0) {
			failures.push({ code: "insufficient-scope", missing });
		}
	}
	return failures;
}

/**
 * Picker order: app installations first, then service accounts,
 * then a person's OAuth grant, then tokens and keys.
 */
const KIND_RANK: Record<CredentialKindName, number> = {
	APP_INSTALLATION: 0,
	SERVICE_ACCOUNT: 1,
	OAUTH: 2,
	GITHUB_APP_USER: 2,
	BASIC: 3,
	PAT: 3,
	API_KEY: 3,
	CUSTOM: 4,
};

export function rankCredentials<
	T extends Pick<CredentialMetadata, "kind" | "label">,
>(rows: readonly T[]): T[] {
	return [...rows].sort(
		(a, b) =>
			KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
			a.label.localeCompare(b.label),
	);
}
