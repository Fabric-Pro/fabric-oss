/**
 * The repositories `code_search` can be scoped to: one per code-index row of
 * the project, so the list is exactly what has vectors to search. A row with no
 * repository integration is the project's legacy/default repository.
 */
export interface CodeSearchRepository {
	/** `null` for the project's legacy/default repository. */
	integrationId: string | null;
	/** `owner/name` when known, else the URL. */
	label: string;
	name: string | null;
	url: string | null;
	roleTag: string | null;
	status: string;
}

interface CodeIndexRow {
	repositoryIntegrationId: string | null;
	status: string;
}

interface RepositoryIntegrationRow {
	id: string;
	repositoryUrl: string;
	repositoryOwner: string;
	repositoryName: string;
	roleTag: string | null;
}

interface LegacyRepositoryRow {
	repositoryUrl: string | null;
	repositoryOwner: string | null;
	repositoryName: string | null;
}

export function buildCodeSearchRepositories(
	indexes: ReadonlyArray<CodeIndexRow>,
	integrations: ReadonlyArray<RepositoryIntegrationRow>,
	legacy: LegacyRepositoryRow | null,
): CodeSearchRepository[] {
	const byId = new Map(integrations.map((i) => [i.id, i]));
	const repositories: CodeSearchRepository[] = [];
	for (const index of indexes) {
		if (index.repositoryIntegrationId === null) {
			const url = legacy?.repositoryUrl ?? null;
			const name = legacy?.repositoryName ?? null;
			const label =
				legacy?.repositoryOwner && name
					? `${legacy.repositoryOwner}/${name}`
					: (url ?? "default repository");
			repositories.push({
				integrationId: null,
				label,
				name,
				url,
				roleTag: null,
				status: index.status,
			});
			continue;
		}
		const integration = byId.get(index.repositoryIntegrationId);
		if (!integration) {
			continue;
		}
		repositories.push({
			integrationId: integration.id,
			label: `${integration.repositoryOwner}/${integration.repositoryName}`,
			name: integration.repositoryName,
			url: integration.repositoryUrl,
			roleTag: integration.roleTag,
			status: index.status,
		});
	}
	return repositories;
}

function normalizeRepositoryRef(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/^[a-z]+:\/\//, "")
		.replace(/^[^@/]+@/, "")
		.replace(/^www\./, "")
		.replace(/\.git$/, "")
		.replace(/\/+$/, "");
}

/**
 * The repository a name, `owner/name` or URL refers to, or `null` when none —
 * or more than one — matches.
 */
export function resolveCodeSearchRepository(
	repositories: ReadonlyArray<CodeSearchRepository>,
	ref: string,
): CodeSearchRepository | null {
	const wanted = normalizeRepositoryRef(ref);
	if (!wanted) {
		return null;
	}
	const exact = repositories.filter(
		(repo) =>
			(repo.url && normalizeRepositoryRef(repo.url) === wanted) ||
			repo.label.toLowerCase() === wanted,
	);
	if (exact.length > 0) {
		return exact[0];
	}
	const loose = repositories.filter(
		(repo) =>
			repo.name?.toLowerCase() === wanted ||
			repo.roleTag?.toLowerCase() === wanted ||
			(repo.url &&
				normalizeRepositoryRef(repo.url).endsWith(`/${wanted}`)),
	);
	return loose.length === 1 ? loose[0] : null;
}

/** Qdrant filter term scoping a code search to one repository. */
export function repositoryFilterTerm(
	repository: CodeSearchRepository,
): Record<string, unknown> {
	return repository.integrationId === null
		? { is_empty: { key: "repositoryIntegrationId" } }
		: {
				key: "repositoryIntegrationId",
				match: { value: repository.integrationId },
			};
}

function describeRepository(repository: CodeSearchRepository): string {
	const role = repository.roleTag ? ` [${repository.roleTag}]` : "";
	const status =
		repository.status === "READY" ? "" : ` (index ${repository.status})`;
	return `${repository.label}${role}${status}`;
}

/** The repository clause of the tool description; "" for a single repo. */
export function describeCodeSearchRepositories(
	repositories: ReadonlyArray<CodeSearchRepository>,
	preferred: CodeSearchRepository | null,
): string {
	if (repositories.length < 2) {
		return "";
	}
	const list = repositories.map(describeRepository).join("; ");
	const scope = preferred
		? `Without \`repository\` it searches ${preferred.label}, the repository the user is viewing; pass another repository, or "all" to search every one.`
		: "Without `repository` it searches all of them; pass one to scope the search.";
	return ` This project's indexed repositories: ${list}. ${scope}`;
}

/**
 * The result `code_search` returns when the code index cannot be searched
 * right now. A plain result, not a failure: nothing the model did caused it
 * and retrying cannot fix it. As a failure it tripped the orchestrator's
 * three-strike breaker, which aborted the whole turn with a raw error
 * (Fizzy #2578). The message tells the model what to do instead.
 */
export function codeIndexUnavailableResult(
	status: string,
	repositoryLabel?: string,
): { available: false; status: string; results: []; message: string } {
	const subject = repositoryLabel
		? `The code index for ${repositoryLabel}`
		: "This project's code index";
	const state =
		status === "PENDING" || status === "INDEXING"
			? "is still building"
			: status === "FAILED"
				? "failed to build and needs a re-index from the project's repository settings"
				: status === "missing"
					? "does not exist — no repository has been indexed for this project"
					: `is not searchable right now (status ${status})`;
	return {
		available: false,
		status,
		results: [],
		message: `${subject} ${state}, so code search is unavailable for now. Do not call code_search again in this turn: answer from the project's other sources (documents, features, Context-tab sources), and tell the user that code search will work once the repository is indexed.`,
	};
}
