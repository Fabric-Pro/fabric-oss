import type { SyncCursor } from "../../../workflows/connector-sync/types";
import type { ConnectorCredentials, Document, Resource } from "./types";

interface GitHubSyncConfig {
	owner?: string;
	repos?: string[];
	excludeRepos?: string[];
	includeIssues?: boolean;
	includePullRequests?: boolean;
	includeDiscussions?: boolean;
	includeCode?: boolean;
}

interface GitLabSyncConfig {
	baseUrl?: string;
	projects?: string[];
	group?: string;
	includeIssues?: boolean;
	includeMergeRequests?: boolean;
}

interface BitbucketSyncConfig {
	baseUrl?: string;
	username?: string;
	workspace?: string;
	repositories?: string[];
	includeIssues?: boolean;
	includePullRequests?: boolean;
}

interface SlackSyncConfig {
	channelIds?: string[];
	includePublicChannels?: boolean;
	includePrivateChannels?: boolean;
	includeThreads?: boolean;
}

function buildGithubHeaders(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github.v3+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"User-Agent": "Fabric-App",
	};
}

function normalizeGitLabApiBaseUrl(baseUrl?: string): string {
	const normalized = (baseUrl ?? "https://gitlab.com/api/v4")
		.trim()
		.replace(/\/+$/, "");
	return normalized.endsWith("/api/v4") ? normalized : `${normalized}/api/v4`;
}

function buildGitLabHeaders(token: string) {
	return {
		Authorization: `Bearer ${token}`,
		Accept: "application/json",
		"User-Agent": "Fabric-App",
	};
}

function normalizeBitbucketApiBaseUrl(baseUrl?: string): string {
	const normalized = (baseUrl ?? "https://api.bitbucket.org/2.0")
		.trim()
		.replace(/\/+$/, "");
	return normalized.endsWith("/2.0") ? normalized : `${normalized}/2.0`;
}

function buildBitbucketAuthHeader(credentials: ConnectorCredentials): string {
	const username =
		typeof credentials.username === "string"
			? credentials.username
			: undefined;
	const secret = credentials.apiKey ?? credentials.accessToken;
	if (!username || !secret) {
		throw new Error("Bitbucket username and app password are required");
	}

	return `Basic ${Buffer.from(`${username}:${secret}`, "utf8").toString("base64")}`;
}

async function fetchBitbucketJson<T>(input: {
	credentials: ConnectorCredentials;
	baseUrl?: string;
	path: string;
	query?: Record<string, string>;
}): Promise<T> {
	const queryString = input.query
		? `?${new URLSearchParams(input.query).toString()}`
		: "";
	const response = await fetch(
		`${normalizeBitbucketApiBaseUrl(input.baseUrl)}${input.path}${queryString}`,
		{
			headers: {
				Authorization: buildBitbucketAuthHeader(input.credentials),
				Accept: "application/json",
				"User-Agent": "Fabric-App",
			},
		},
	);

	if (!response.ok) {
		throw new Error(
			`Bitbucket API error ${response.status} for ${input.path}`,
		);
	}

	return (await response.json()) as T;
}

async function fetchGitLabJson<T>(input: {
	token: string;
	baseUrl?: string;
	path: string;
	query?: Record<string, string>;
}): Promise<T> {
	const queryString = input.query
		? `?${new URLSearchParams(input.query).toString()}`
		: "";
	const response = await fetch(
		`${normalizeGitLabApiBaseUrl(input.baseUrl)}${input.path}${queryString}`,
		{
			headers: buildGitLabHeaders(input.token),
		},
	);

	if (!response.ok) {
		throw new Error(
			`GitLab API error ${response.status} for ${input.path}`,
		);
	}

	return (await response.json()) as T;
}

async function fetchGitHubJson<T>(token: string, path: string): Promise<T> {
	const response = await fetch(`https://api.github.com${path}`, {
		headers: buildGithubHeaders(token),
	});

	if (!response.ok) {
		throw new Error(`GitHub API error ${response.status} for ${path}`);
	}

	return (await response.json()) as T;
}

async function fetchSlackJson<T>(input: {
	token: string;
	path: string;
	query?: Record<string, string>;
}): Promise<T> {
	const queryString = input.query
		? `?${new URLSearchParams(input.query).toString()}`
		: "";
	const response = await fetch(
		`https://slack.com/api/${input.path}${queryString}`,
		{
			headers: {
				Authorization: `Bearer ${input.token}`,
				"Content-Type": "application/json",
			},
		},
	);

	if (!response.ok) {
		throw new Error(`Slack API error ${response.status} for ${input.path}`);
	}

	const data = (await response.json()) as { ok?: boolean; error?: string };
	if (data.ok === false) {
		throw new Error(`Slack API error: ${data.error ?? "unknown_error"}`);
	}

	return data as T;
}

function buildGitHubIssueDocument(params: {
	repoFullName: string;
	item: {
		number: number;
		title: string;
		body?: string | null;
		html_url: string;
		user?: { login?: string | null };
		created_at: string;
		updated_at: string;
		pull_request?: unknown;
		labels?: Array<{ name?: string | null }>;
		state?: string;
	};
}): Document {
	const isPullRequest = !!params.item.pull_request;
	const docType = isPullRequest ? "pull_request" : "issue";
	const labels = (params.item.labels ?? [])
		.map((label) => label.name)
		.filter((label): label is string => !!label);

	return {
		id: `${params.repoFullName}-${docType}-${params.item.number}`,
		externalId: `${params.repoFullName}:${docType}:${params.item.number}`,
		title: `${isPullRequest ? "PR" : "Issue"} #${params.item.number}: ${params.item.title}`,
		content: [
			`Repository: ${params.repoFullName}`,
			`Type: ${isPullRequest ? "Pull Request" : "Issue"}`,
			`Number: ${params.item.number}`,
			`State: ${params.item.state ?? "unknown"}`,
			labels.length > 0 ? `Labels: ${labels.join(", ")}` : null,
			"",
			params.item.title,
			params.item.body ?? "",
		]
			.filter((value) => value !== null)
			.join("\n"),
		contentHash: `${params.item.updated_at}:${params.item.number}`,
		metadata: {
			resourceType: docType,
			repository: params.repoFullName,
			url: params.item.html_url,
			author: params.item.user?.login ?? null,
			createdAt: params.item.created_at,
			updatedAt: params.item.updated_at,
			labels,
		},
		sizeBytes: Buffer.byteLength(params.item.body ?? "", "utf8"),
		textLength: (params.item.body ?? params.item.title).length,
	};
}

function buildGitLabWorkItemDocument(params: {
	projectPath: string;
	item: {
		iid: number;
		title: string;
		description?: string | null;
		web_url: string;
		author?: { username?: string | null };
		created_at: string;
		updated_at: string;
		state?: string;
		labels?: string[];
	};
	type: "issue" | "merge_request";
}): Document {
	const labels = (params.item.labels ?? []).filter(Boolean);

	return {
		id: `${params.projectPath}-${params.type}-${params.item.iid}`,
		externalId: `${params.projectPath}:${params.type}:${params.item.iid}`,
		title: `${params.type === "merge_request" ? "MR" : "Issue"} #${params.item.iid}: ${params.item.title}`,
		content: [
			`Project: ${params.projectPath}`,
			`Type: ${params.type === "merge_request" ? "Merge Request" : "Issue"}`,
			`Number: ${params.item.iid}`,
			`State: ${params.item.state ?? "unknown"}`,
			labels.length > 0 ? `Labels: ${labels.join(", ")}` : null,
			"",
			params.item.title,
			params.item.description ?? "",
		]
			.filter((value) => value !== null)
			.join("\n"),
		contentHash: `${params.item.updated_at}:${params.item.iid}`,
		metadata: {
			resourceType: params.type,
			projectPath: params.projectPath,
			url: params.item.web_url,
			author: params.item.author?.username ?? null,
			createdAt: params.item.created_at,
			updatedAt: params.item.updated_at,
			labels,
		},
		sizeBytes: Buffer.byteLength(params.item.description ?? "", "utf8"),
		textLength: (params.item.description ?? params.item.title).length,
	};
}

function buildBitbucketWorkItemDocument(params: {
	repositoryFullName: string;
	item: {
		id?: number | string;
		title: string;
		content?: { raw?: string | null } | null;
		links?: { html?: { href?: string | null } | null } | null;
		reporter?: { display_name?: string | null } | null;
		created_on: string;
		updated_on: string;
		state?: { name?: string | null } | string | null;
	};
	type: "issue" | "pull_request";
	number: number | string;
}): Document {
	const state =
		typeof params.item.state === "string"
			? params.item.state
			: (params.item.state?.name ?? "unknown");

	return {
		id: `${params.repositoryFullName}-${params.type}-${params.number}`,
		externalId: `${params.repositoryFullName}:${params.type}:${params.number}`,
		title: `${params.type === "pull_request" ? "PR" : "Issue"} #${params.number}: ${params.item.title}`,
		content: [
			`Repository: ${params.repositoryFullName}`,
			`Type: ${params.type === "pull_request" ? "Pull Request" : "Issue"}`,
			`Number: ${params.number}`,
			`State: ${state}`,
			"",
			params.item.title,
			params.item.content?.raw ?? "",
		].join("\n"),
		contentHash: `${params.item.updated_on}:${params.number}`,
		metadata: {
			resourceType: params.type,
			repository: params.repositoryFullName,
			url: params.item.links?.html?.href ?? null,
			author: params.item.reporter?.display_name ?? null,
			createdAt: params.item.created_on,
			updatedAt: params.item.updated_on,
		},
		sizeBytes: Buffer.byteLength(params.item.content?.raw ?? "", "utf8"),
		textLength: (params.item.content?.raw ?? params.item.title).length,
	};
}

export async function testGitLabConnection(
	credentials: ConnectorCredentials,
): Promise<boolean> {
	const token = credentials.accessToken ?? credentials.apiKey;
	if (!token) {
		return false;
	}

	try {
		await fetchGitLabJson({
			token,
			path: "/user",
			baseUrl:
				typeof credentials.baseUrl === "string"
					? credentials.baseUrl
					: undefined,
		});
		return true;
	} catch {
		return false;
	}
}

export async function testBitbucketConnection(
	credentials: ConnectorCredentials,
): Promise<boolean> {
	try {
		await fetchBitbucketJson({
			credentials,
			baseUrl:
				typeof credentials.baseUrl === "string"
					? credentials.baseUrl
					: undefined,
			path: "/user",
		});
		return true;
	} catch {
		return false;
	}
}

function buildSlackMessageDocument(params: {
	channel: {
		id: string;
		name: string;
		isPrivate?: boolean;
	};
	message: {
		ts: string;
		text?: string;
		user?: string;
		thread_ts?: string;
	};
	threadReplies?: Array<{
		ts: string;
		text?: string;
		user?: string;
	}>;
}): Document {
	const replyCount = params.threadReplies?.length ?? 0;
	const repliesText =
		replyCount > 0
			? [
					"",
					"Thread replies:",
					...(params.threadReplies ?? []).map(
						(reply) =>
							`- ${reply.user ?? "unknown"} (${reply.ts}): ${reply.text ?? ""}`,
					),
				].join("\n")
			: "";

	return {
		id: `slack-${params.channel.id}-${params.message.ts}`,
		externalId: `slack:${params.channel.id}:${params.message.ts}`,
		title: `#${params.channel.name} message`,
		content: [
			`Channel: #${params.channel.name}`,
			`Timestamp: ${params.message.ts}`,
			`Author: ${params.message.user ?? "unknown"}`,
			"",
			params.message.text ?? "",
			repliesText,
		].join("\n"),
		contentHash: `${params.message.ts}:${replyCount}`,
		metadata: {
			resourceType: "message",
			channelId: params.channel.id,
			channelName: params.channel.name,
			isPrivate: params.channel.isPrivate ?? false,
			threadTs: params.message.thread_ts ?? null,
			replyCount,
			updatedAt: new Date(
				Number.parseFloat(params.message.ts) * 1000,
			).toISOString(),
		},
		sizeBytes: Buffer.byteLength(params.message.text ?? "", "utf8"),
		textLength:
			(params.message.text ?? "").length +
			(params.threadReplies ?? []).reduce(
				(total, reply) => total + (reply.text ?? "").length,
				0,
			),
	};
}

export async function testSlackConnection(credentials: ConnectorCredentials) {
	if (!credentials.accessToken) {
		return false;
	}

	const response = await fetch("https://slack.com/api/auth.test", {
		headers: {
			Authorization: `Bearer ${credentials.accessToken}`,
		},
	});
	if (!response.ok) {
		return false;
	}
	const data = (await response.json()) as { ok?: boolean };
	return data.ok === true;
}

export async function discoverGitHubResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token = input.credentials.accessToken;
	if (!token) {
		throw new Error("GitHub access token is required");
	}

	const githubConfig = input.providerConfig as GitHubSyncConfig;
	const configuredRepos = githubConfig.repos?.filter(Boolean);
	const excludedRepos = new Set(githubConfig.excludeRepos ?? []);

	if (configuredRepos && configuredRepos.length > 0) {
		return configuredRepos
			.filter((repo: string) => !excludedRepos.has(repo))
			.map((repo: string) => ({
				id: repo,
				name: repo,
				type: "github-repository",
				path: `https://github.com/${repo}`,
				metadata: {
					fullName: repo,
					owner: repo.split("/")[0] ?? githubConfig.owner,
					repo: repo.split("/")[1] ?? repo,
				},
			}));
	}

	const repos = await fetchGitHubJson<
		Array<{
			full_name: string;
			html_url: string;
			owner?: { login?: string };
			name: string;
		}>
	>(
		token,
		"/user/repos?sort=updated&per_page=100&affiliation=owner,organization_member",
	);

	return repos
		.filter((repo) => {
			if (excludedRepos.has(repo.full_name)) {
				return false;
			}
			if (!githubConfig.owner) {
				return true;
			}
			return repo.owner?.login === githubConfig.owner;
		})
		.map((repo) => ({
			id: repo.full_name,
			name: repo.full_name,
			type: "github-repository",
			path: repo.html_url,
			metadata: {
				fullName: repo.full_name,
				owner: repo.owner?.login ?? githubConfig.owner,
				repo: repo.name,
			},
		}));
}

export async function discoverGitLabResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token = input.credentials.accessToken ?? input.credentials.apiKey;
	if (!token) {
		throw new Error("GitLab access token is required");
	}

	const gitlabConfig = input.providerConfig as GitLabSyncConfig;
	const baseUrl =
		typeof gitlabConfig.baseUrl === "string"
			? gitlabConfig.baseUrl
			: undefined;
	const configuredProjects = gitlabConfig.projects?.filter(Boolean);

	if (configuredProjects && configuredProjects.length > 0) {
		return configuredProjects.map((projectPath) => ({
			id: projectPath,
			name: projectPath,
			type: "gitlab-project",
			path: `${normalizeGitLabApiBaseUrl(baseUrl).replace(/\/api\/v4$/, "")}/${projectPath}`,
			metadata: {
				fullPath: projectPath,
				baseUrl: normalizeGitLabApiBaseUrl(baseUrl),
			},
		}));
	}

	const query: Record<string, string> = {
		membership: "true",
		simple: "true",
		per_page: "100",
	};
	if (
		typeof gitlabConfig.group === "string" &&
		gitlabConfig.group.trim().length > 0
	) {
		query.search = gitlabConfig.group.trim();
	}

	const projects = await fetchGitLabJson<
		Array<{
			id: number;
			name: string;
			web_url: string;
			path_with_namespace: string;
		}>
	>({
		token,
		baseUrl,
		path: "/projects",
		query,
	});

	return projects
		.filter((project) =>
			gitlabConfig.group
				? project.path_with_namespace.startsWith(
						`${gitlabConfig.group}/`,
					) || project.path_with_namespace === gitlabConfig.group
				: true,
		)
		.map((project) => ({
			id: project.path_with_namespace,
			name: project.path_with_namespace,
			type: "gitlab-project",
			path: project.web_url,
			metadata: {
				fullPath: project.path_with_namespace,
				projectId: project.id,
				baseUrl: normalizeGitLabApiBaseUrl(baseUrl),
			},
		}));
}

export async function discoverBitbucketResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const bitbucketConfig = input.providerConfig as BitbucketSyncConfig;
	const baseUrl =
		typeof bitbucketConfig.baseUrl === "string"
			? bitbucketConfig.baseUrl
			: undefined;
	const usernameFromConfig =
		typeof bitbucketConfig.username === "string"
			? bitbucketConfig.username
			: undefined;
	const credentials = {
		...input.credentials,
		...(usernameFromConfig ? { username: usernameFromConfig } : {}),
	};
	const configuredRepositories =
		bitbucketConfig.repositories?.filter(Boolean);

	if (configuredRepositories && configuredRepositories.length > 0) {
		return configuredRepositories.map((repositoryFullName) => ({
			id: repositoryFullName,
			name: repositoryFullName,
			type: "bitbucket-repository",
			path: `${normalizeBitbucketApiBaseUrl(baseUrl).replace(/\/2\.0$/, "")}/${
				repositoryFullName
			}`,
			metadata: {
				fullName: repositoryFullName,
				baseUrl: normalizeBitbucketApiBaseUrl(baseUrl),
			},
		}));
	}

	if (!bitbucketConfig.workspace) {
		throw new Error(
			"Bitbucket workspace is required when repositories are not configured",
		);
	}

	const repositories = await fetchBitbucketJson<{
		values?: Array<{
			full_name: string;
			name: string;
			links?: { html?: { href?: string | null } | null };
		}>;
	}>({
		credentials,
		baseUrl,
		path: `/repositories/${bitbucketConfig.workspace}`,
		query: {
			pagelen: "100",
		},
	});

	return (repositories.values ?? []).map((repository) => ({
		id: repository.full_name,
		name: repository.full_name,
		type: "bitbucket-repository",
		path: repository.links?.html?.href ?? undefined,
		metadata: {
			fullName: repository.full_name,
			baseUrl: normalizeBitbucketApiBaseUrl(baseUrl),
		},
	}));
}

export async function discoverSlackResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token = input.credentials.accessToken;
	if (!token) {
		throw new Error("Slack access token is required");
	}

	const slackConfig = input.providerConfig as SlackSyncConfig;
	const configuredChannelIds = new Set(slackConfig.channelIds ?? []);
	const types = [
		slackConfig.includePublicChannels === false ? null : "public_channel",
		slackConfig.includePrivateChannels ? "private_channel" : null,
	]
		.filter((value): value is string => !!value)
		.join(",");

	const data = await fetchSlackJson<{
		channels?: Array<{
			id: string;
			name: string;
			is_private?: boolean;
		}>;
	}>({
		token,
		path: "conversations.list",
		query: {
			limit: "1000",
			types: types || "public_channel",
			exclude_archived: "true",
		},
	});

	return (data.channels ?? [])
		.filter((channel) =>
			configuredChannelIds.size > 0
				? configuredChannelIds.has(channel.id)
				: true,
		)
		.map((channel) => ({
			id: channel.id,
			name: channel.name,
			type: "slack-channel",
			path: `slack://channel/${channel.id}`,
			metadata: {
				channelId: channel.id,
				channelName: channel.name,
				isPrivate: channel.is_private ?? false,
			},
		}));
}

async function fetchSlackThreadReplies(input: {
	token: string;
	channelId: string;
	threadTs: string;
}): Promise<Array<{ ts: string; text?: string; user?: string }>> {
	const data = await fetchSlackJson<{
		messages?: Array<{ ts: string; text?: string; user?: string }>;
	}>({
		token: input.token,
		path: "conversations.replies",
		query: {
			channel: input.channelId,
			ts: input.threadTs,
			limit: "200",
		},
	});

	return (data.messages ?? []).filter(
		(message) => message.ts !== input.threadTs,
	);
}

export async function fetchGitHubResourceDocuments(input: {
	resource: Resource;
	credentials: ConnectorCredentials;
	providerConfig?: Record<string, unknown>;
	cursor?: SyncCursor;
	batchSize: number;
	syncType: "full" | "incremental" | "gc";
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token = input.credentials.accessToken;
	if (!token) {
		throw new Error("GitHub access token is required");
	}

	const githubConfig = (input.providerConfig ?? {}) as GitHubSyncConfig;
	const repoFullName =
		(typeof input.resource.metadata?.fullName === "string" &&
			input.resource.metadata.fullName) ||
		input.resource.id;
	const since =
		input.syncType === "incremental"
			? input.cursor?.lastSyncedAt
			: undefined;

	const issues = await fetchGitHubJson<
		Array<{
			number: number;
			title: string;
			body?: string | null;
			html_url: string;
			user?: { login?: string | null };
			created_at: string;
			updated_at: string;
			pull_request?: unknown;
			labels?: Array<{ name?: string | null }>;
			state?: string;
		}>
	>(
		token,
		`/repos/${repoFullName}/issues?state=all&per_page=${input.batchSize}${since ? `&since=${encodeURIComponent(since)}` : ""}`,
	);

	const documents = issues
		.filter((item) => {
			if (
				item.pull_request &&
				githubConfig.includePullRequests === false
			) {
				return false;
			}
			if (!item.pull_request && githubConfig.includeIssues === false) {
				return false;
			}
			return true;
		})
		.map((item) =>
			buildGitHubIssueDocument({
				repoFullName,
				item,
			}),
		);

	const sortedTimestamps = documents
		.map((doc) => doc.metadata.updatedAt)
		.filter((value): value is string => typeof value === "string")
		.sort();
	const newestTimestamp =
		sortedTimestamps.length > 0
			? sortedTimestamps[sortedTimestamps.length - 1]
			: undefined;

	return {
		documents,
		newCursor: newestTimestamp
			? {
					connectorId: input.cursor?.connectorId ?? "",
					provider: "GITHUB",
					cursorType: "incremental",
					cursor: newestTimestamp,
					lastSyncedAt: newestTimestamp,
				}
			: input.cursor,
	};
}

export async function fetchGitLabResourceDocuments(input: {
	resource: Resource;
	credentials: ConnectorCredentials;
	providerConfig?: Record<string, unknown>;
	cursor?: SyncCursor;
	batchSize: number;
	syncType: "full" | "incremental" | "gc";
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token = input.credentials.accessToken ?? input.credentials.apiKey;
	if (!token) {
		throw new Error("GitLab access token is required");
	}

	const gitlabConfig = (input.providerConfig ?? {}) as GitLabSyncConfig;
	const projectPath =
		(typeof input.resource.metadata?.fullPath === "string" &&
			input.resource.metadata.fullPath) ||
		input.resource.id;
	const encodedProjectPath = encodeURIComponent(projectPath);
	const baseUrl =
		typeof input.resource.metadata?.baseUrl === "string"
			? input.resource.metadata.baseUrl
			: gitlabConfig.baseUrl;
	const updatedAfter =
		input.syncType === "incremental"
			? input.cursor?.lastSyncedAt
			: undefined;
	const documents: Document[] = [];

	if (gitlabConfig.includeIssues !== false) {
		const issues = await fetchGitLabJson<
			Array<{
				iid: number;
				title: string;
				description?: string | null;
				web_url: string;
				author?: { username?: string | null };
				created_at: string;
				updated_at: string;
				state?: string;
				labels?: string[];
			}>
		>({
			token,
			baseUrl,
			path: `/projects/${encodedProjectPath}/issues`,
			query: {
				state: "all",
				per_page: String(input.batchSize),
				...(updatedAfter ? { updated_after: updatedAfter } : {}),
			},
		});

		documents.push(
			...issues.map((item) =>
				buildGitLabWorkItemDocument({
					projectPath,
					item,
					type: "issue",
				}),
			),
		);
	}

	if (gitlabConfig.includeMergeRequests !== false) {
		const mergeRequests = await fetchGitLabJson<
			Array<{
				iid: number;
				title: string;
				description?: string | null;
				web_url: string;
				author?: { username?: string | null };
				created_at: string;
				updated_at: string;
				state?: string;
				labels?: string[];
			}>
		>({
			token,
			baseUrl,
			path: `/projects/${encodedProjectPath}/merge_requests`,
			query: {
				state: "all",
				per_page: String(input.batchSize),
				...(updatedAfter ? { updated_after: updatedAfter } : {}),
			},
		});

		documents.push(
			...mergeRequests.map((item) =>
				buildGitLabWorkItemDocument({
					projectPath,
					item,
					type: "merge_request",
				}),
			),
		);
	}

	const sortedTimestamps = documents
		.map((doc) => doc.metadata.updatedAt)
		.filter((value): value is string => typeof value === "string")
		.sort();
	const newestTimestamp =
		sortedTimestamps.length > 0
			? sortedTimestamps[sortedTimestamps.length - 1]
			: undefined;

	return {
		documents,
		newCursor: newestTimestamp
			? {
					connectorId: input.cursor?.connectorId ?? "",
					provider: "GITLAB",
					cursorType: "incremental",
					cursor: newestTimestamp,
					lastSyncedAt: newestTimestamp,
				}
			: input.cursor,
	};
}

export async function fetchBitbucketResourceDocuments(input: {
	resource: Resource;
	credentials: ConnectorCredentials;
	providerConfig?: Record<string, unknown>;
	cursor?: SyncCursor;
	batchSize: number;
	syncType: "full" | "incremental" | "gc";
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const bitbucketConfig = (input.providerConfig ?? {}) as BitbucketSyncConfig;
	const usernameFromConfig =
		typeof bitbucketConfig.username === "string"
			? bitbucketConfig.username
			: undefined;
	const credentials = {
		...input.credentials,
		...(usernameFromConfig ? { username: usernameFromConfig } : {}),
	};
	const repositoryFullName =
		(typeof input.resource.metadata?.fullName === "string" &&
			input.resource.metadata.fullName) ||
		input.resource.id;
	const [workspace, repoSlug] = repositoryFullName.split("/");
	if (!workspace || !repoSlug) {
		throw new Error("Bitbucket repository full name is required");
	}

	const baseUrl =
		typeof input.resource.metadata?.baseUrl === "string"
			? input.resource.metadata.baseUrl
			: bitbucketConfig.baseUrl;
	const updatedAfter =
		input.syncType === "incremental"
			? input.cursor?.lastSyncedAt
			: undefined;
	const documents: Document[] = [];

	if (bitbucketConfig.includeIssues !== false) {
		const issues = await fetchBitbucketJson<{
			values?: Array<{
				id: number;
				title: string;
				content?: { raw?: string | null } | null;
				links?: { html?: { href?: string | null } | null } | null;
				reporter?: { display_name?: string | null } | null;
				created_on: string;
				updated_on: string;
				state?: string | null;
			}>;
		}>({
			credentials,
			baseUrl,
			path: `/repositories/${workspace}/${repoSlug}/issues`,
			query: {
				pagelen: String(input.batchSize),
				...(updatedAfter
					? { q: `updated_on >= "${updatedAfter}"` }
					: {}),
			},
		});

		documents.push(
			...(issues.values ?? []).map((item) =>
				buildBitbucketWorkItemDocument({
					repositoryFullName,
					item,
					type: "issue",
					number: item.id,
				}),
			),
		);
	}

	if (bitbucketConfig.includePullRequests !== false) {
		const pullRequests = await fetchBitbucketJson<{
			values?: Array<{
				id: number;
				title: string;
				content?: { raw?: string | null } | null;
				links?: { html?: { href?: string | null } | null } | null;
				author?: { display_name?: string | null } | null;
				created_on: string;
				updated_on: string;
				state?: string | null;
			}>;
		}>({
			credentials,
			baseUrl,
			path: `/repositories/${workspace}/${repoSlug}/pullrequests`,
			query: {
				state: "OPEN,MERGED,DECLINED,SUPERSEDED",
				pagelen: String(input.batchSize),
				...(updatedAfter
					? { q: `updated_on >= "${updatedAfter}"` }
					: {}),
			},
		});

		documents.push(
			...(pullRequests.values ?? []).map((item) =>
				buildBitbucketWorkItemDocument({
					repositoryFullName,
					item: {
						...item,
						reporter: item.author
							? { display_name: item.author.display_name ?? null }
							: null,
					},
					type: "pull_request",
					number: item.id,
				}),
			),
		);
	}

	const sortedTimestamps = documents
		.map((doc) => doc.metadata.updatedAt)
		.filter((value): value is string => typeof value === "string")
		.sort();
	const newestTimestamp =
		sortedTimestamps.length > 0
			? sortedTimestamps[sortedTimestamps.length - 1]
			: undefined;

	return {
		documents,
		newCursor: newestTimestamp
			? {
					connectorId: input.cursor?.connectorId ?? "",
					provider: "BITBUCKET",
					cursorType: "incremental",
					cursor: newestTimestamp,
					lastSyncedAt: newestTimestamp,
				}
			: input.cursor,
	};
}

export async function fetchSlackResourceDocuments(input: {
	resource: Resource;
	credentials: ConnectorCredentials;
	providerConfig?: Record<string, unknown>;
	cursor?: SyncCursor;
	batchSize: number;
	syncType: "full" | "incremental" | "gc";
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token = input.credentials.accessToken;
	if (!token) {
		throw new Error("Slack access token is required");
	}

	const slackConfig = (input.providerConfig ?? {}) as SlackSyncConfig;
	const channelId =
		(typeof input.resource.metadata?.channelId === "string" &&
			input.resource.metadata.channelId) ||
		input.resource.id;
	const channelName =
		(typeof input.resource.metadata?.channelName === "string" &&
			input.resource.metadata.channelName) ||
		input.resource.name;

	const oldest =
		input.syncType === "incremental"
			? input.cursor?.lastSyncedAt
			: undefined;
	const data = await fetchSlackJson<{
		messages?: Array<{
			ts: string;
			text?: string;
			user?: string;
			thread_ts?: string;
			reply_count?: number;
			subtype?: string;
		}>;
	}>({
		token,
		path: "conversations.history",
		query: {
			channel: channelId,
			limit: String(input.batchSize),
			inclusive: "false",
			...(oldest ? { oldest } : {}),
		},
	});

	const documents: Document[] = [];
	for (const message of data.messages ?? []) {
		if (message.subtype && message.subtype !== "thread_broadcast") {
			continue;
		}

		const threadReplies =
			slackConfig.includeThreads &&
			message.thread_ts &&
			message.thread_ts === message.ts &&
			(message.reply_count ?? 0) > 0
				? await fetchSlackThreadReplies({
						token,
						channelId,
						threadTs: message.thread_ts,
					})
				: undefined;

		documents.push(
			buildSlackMessageDocument({
				channel: {
					id: channelId,
					name: channelName,
					isPrivate:
						typeof input.resource.metadata?.isPrivate === "boolean"
							? input.resource.metadata.isPrivate
							: false,
				},
				message,
				threadReplies,
			}),
		);
	}

	const sortedTimestamps = documents
		.map((doc) => doc.metadata.updatedAt)
		.filter((value): value is string => typeof value === "string")
		.sort();
	const newestTimestamp =
		sortedTimestamps.length > 0
			? sortedTimestamps[sortedTimestamps.length - 1]
			: undefined;

	return {
		documents,
		newCursor: newestTimestamp
			? {
					connectorId: input.cursor?.connectorId ?? "",
					provider: "SLACK",
					cursorType: "incremental",
					cursor: newestTimestamp,
					lastSyncedAt: newestTimestamp,
				}
			: input.cursor,
	};
}
