import {
	AZURE_DEVOPS_API_VERSION,
	getRepositoryJson,
	isRecord,
	type RepositoryApiInput,
	type RepositoryFailure,
	repositoryApiTarget,
	stringField,
} from "./repository-api";

const PAGE_SIZE = 30;

export type RepositoryPullRequest = {
	number: number;
	title: string;
	author: string;
	url: string;
	draft: boolean;
};

/** One page of open native proposals targeting the attached branch. No writes. */
export async function listRepositoryPullRequests(
	input: RepositoryApiInput & {
		branch: string;
		page: number;
	},
): Promise<
	| { ok: true; pullRequests: RepositoryPullRequest[]; hasMore: boolean }
	| {
			ok: false;
			outcome: RepositoryFailure;
	  }
> {
	const target = repositoryApiTarget(input);
	if (
		!target ||
		!Number.isInteger(input.page) ||
		input.page < 1 ||
		input.page > 1000
	) {
		return { ok: false, outcome: "unreachable" };
	}
	let suffix: string;
	switch (input.provider) {
		case "GITHUB":
			suffix = `/pulls?${new URLSearchParams({ state: "open", base: input.branch, per_page: String(PAGE_SIZE), page: String(input.page), sort: "updated", direction: "desc" })}`;
			break;
		case "GITLAB":
			suffix = `/merge_requests?${new URLSearchParams({ state: "opened", target_branch: input.branch, per_page: String(PAGE_SIZE), page: String(input.page), order_by: "updated_at", sort: "desc" })}`;
			break;
		case "AZURE_DEVOPS":
			suffix = `/pullrequests?${new URLSearchParams({ "searchCriteria.status": "active", "searchCriteria.targetRefName": `refs/heads/${input.branch}`, $top: String(PAGE_SIZE), $skip: String((input.page - 1) * PAGE_SIZE), "api-version": AZURE_DEVOPS_API_VERSION })}`;
			break;
		default: {
			const unreachable: never = input.provider;
			return unreachable;
		}
	}
	const answer = await getRepositoryJson(target, suffix);
	if (!answer.ok) {
		return answer;
	}
	const entries = Array.isArray(answer.data)
		? answer.data
		: isRecord(answer.data) && Array.isArray(answer.data.value)
			? answer.data.value
			: null;
	if (!entries || entries.length > PAGE_SIZE) {
		return { ok: false, outcome: "unreachable" };
	}
	const pullRequests: RepositoryPullRequest[] = [];
	for (const entry of entries) {
		if (!isRecord(entry)) {
			return { ok: false, outcome: "unreachable" };
		}
		const number =
			input.provider === "GITHUB"
				? entry.number
				: input.provider === "GITLAB"
					? entry.iid
					: entry.pullRequestId;
		const title = stringField(entry, "title");
		if (
			typeof number !== "number" ||
			!Number.isSafeInteger(number) ||
			number < 1 ||
			title === null
		) {
			return { ok: false, outcome: "unreachable" };
		}
		const author =
			input.provider === "GITHUB"
				? entry.user
				: input.provider === "GITLAB"
					? entry.author
					: entry.createdBy;
		const authorName = isRecord(author)
			? (stringField(
					author,
					input.provider === "GITHUB"
						? "login"
						: input.provider === "GITLAB"
							? "name"
							: "displayName",
				) ?? "")
			: "";
		// Construct links from the canonical provider target, never provider body URLs.
		const url = target.pullRequestUrl(number);
		pullRequests.push({
			number,
			title: title.slice(0, 2000),
			author: authorName.slice(0, 200),
			url,
			draft: entry.draft === true || entry.isDraft === true,
		});
	}
	return { ok: true, pullRequests, hasMore: entries.length === PAGE_SIZE };
}
