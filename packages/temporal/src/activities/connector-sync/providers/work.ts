import type { SyncCursor } from "../../../workflows/connector-sync/types";
import {
	buildBasicAuthHeaders,
	convertHtmlToText,
	normalizeHttpsBaseUrl,
	normalizeSubdomainApiBaseUrl,
} from "./shared";
import type { ConnectorCredentials, Document, Resource } from "./types";

interface ZendeskSyncConfig {
	includeArticles?: boolean;
	includeTickets?: boolean;
}

interface JiraSyncConfig {
	projectKeys?: string[];
	jql?: string;
}

interface LinearSyncConfig {
	teamKeys?: string[];
}

interface AsanaSyncConfig {
	workspaceId?: string;
	projectIds?: string[];
	teamId?: string;
}

interface ClickUpSyncConfig {
	teamId?: string;
	listIds?: string[];
	includeClosed?: boolean;
}

async function fetchZendeskJson<T>(input: {
	baseUrl: string;
	email: string;
	apiToken: string;
	path: string;
	query?: Record<string, string>;
}): Promise<T> {
	const queryString = input.query
		? `?${new URLSearchParams(input.query).toString()}`
		: "";
	const response = await fetch(
		`${input.baseUrl}/${input.path}${queryString}`,
		{
			headers: buildBasicAuthHeaders(
				`${input.email}/token`,
				input.apiToken,
			),
		},
	);

	if (!response.ok) {
		throw new Error(
			`Zendesk API error ${response.status} for ${input.path}`,
		);
	}

	return (await response.json()) as T;
}

async function fetchConfluenceJson<T>(input: {
	baseUrl: string;
	email: string;
	apiToken: string;
	path: string;
}): Promise<T> {
	const response = await fetch(`${input.baseUrl}${input.path}`, {
		headers: buildBasicAuthHeaders(input.email, input.apiToken),
	});

	if (!response.ok) {
		throw new Error(
			`Confluence API error ${response.status} for ${input.path}`,
		);
	}

	return (await response.json()) as T;
}

async function fetchLinearJson<T>(input: {
	token: string;
	query: string;
	variables?: Record<string, unknown>;
}): Promise<T> {
	const authorization = input.token.startsWith("Bearer ")
		? input.token
		: input.token;
	const response = await fetch("https://api.linear.app/graphql", {
		method: "POST",
		headers: {
			Authorization: authorization,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			query: input.query,
			variables: input.variables ?? {},
		}),
	});

	if (!response.ok) {
		throw new Error(`Linear API error ${response.status}`);
	}

	const data = (await response.json()) as {
		data?: T;
		errors?: Array<{ message?: string }>;
	};
	if (data.errors?.length) {
		throw new Error(data.errors[0]?.message || "Linear GraphQL error");
	}

	if (!data.data) {
		throw new Error("Linear GraphQL returned no data");
	}

	return data.data;
}

async function fetchAsanaJson<T>(input: {
	token: string;
	path: string;
	query?: Record<string, string>;
}): Promise<T> {
	const queryString = input.query
		? `?${new URLSearchParams(input.query).toString()}`
		: "";
	const response = await fetch(
		`https://app.asana.com/api/1.0/${input.path}${queryString}`,
		{
			headers: {
				Authorization: `Bearer ${input.token}`,
				Accept: "application/json",
			},
		},
	);

	if (!response.ok) {
		throw new Error(`Asana API error ${response.status} for ${input.path}`);
	}

	return (await response.json()) as T;
}

async function fetchClickUpJson<T>(input: {
	token: string;
	path: string;
	query?: Record<string, string>;
}): Promise<T> {
	const queryString = input.query
		? `?${new URLSearchParams(input.query).toString()}`
		: "";
	const response = await fetch(
		`https://api.clickup.com/api/v2/${input.path}${queryString}`,
		{
			headers: {
				Authorization: input.token,
				Accept: "application/json",
			},
		},
	);

	if (!response.ok) {
		throw new Error(
			`ClickUp API error ${response.status} for ${input.path}`,
		);
	}

	return (await response.json()) as T;
}

function buildJiraSearchJql(config: JiraSyncConfig): string {
	if (config.jql?.trim()) {
		return config.jql.trim();
	}

	if (config.projectKeys && config.projectKeys.length > 0) {
		const escapedKeys = config.projectKeys
			.map((key) => `'${key.replace(/'/g, "\\'")}'`)
			.join(",");
		return `project in (${escapedKeys}) ORDER BY updated DESC`;
	}

	return "ORDER BY updated DESC";
}

function extractJiraAdfText(node: unknown): string {
	if (!node || typeof node !== "object") {
		return "";
	}

	const current = node as {
		type?: string;
		text?: string;
		content?: unknown[];
	};

	const ownText = current.text ?? "";
	const childText = (current.content ?? [])
		.map((child) => extractJiraAdfText(child))
		.filter(Boolean)
		.join(current.type === "paragraph" ? "\n" : " ");

	return [ownText, childText]
		.filter(Boolean)
		.join(ownText && childText ? " " : "");
}

export async function testZendeskConnection(credentials: ConnectorCredentials) {
	if (
		typeof credentials.domain !== "string" ||
		typeof credentials.email !== "string" ||
		typeof credentials.apiToken !== "string"
	) {
		return false;
	}

	const response = await fetch(
		`${normalizeSubdomainApiBaseUrl(credentials.domain, "zendesk.com", "/api/v2")}/users/me.json`,
		{
			headers: buildBasicAuthHeaders(
				`${credentials.email}/token`,
				credentials.apiToken,
			),
		},
	);
	return response.ok;
}

export async function testJiraConnection(credentials: ConnectorCredentials) {
	if (
		typeof credentials.domain !== "string" ||
		typeof credentials.email !== "string" ||
		typeof credentials.apiToken !== "string"
	) {
		return false;
	}

	const response = await fetch(
		`${normalizeHttpsBaseUrl(credentials.domain)}/rest/api/3/myself`,
		{
			headers: buildBasicAuthHeaders(
				credentials.email,
				credentials.apiToken,
			),
		},
	);
	return response.ok;
}

export async function testLinearConnection(credentials: ConnectorCredentials) {
	return (
		typeof credentials.apiKey === "string" ||
		typeof credentials.accessToken === "string"
	);
}

export async function testAsanaConnection(credentials: ConnectorCredentials) {
	const token =
		(typeof credentials.apiKey === "string" && credentials.apiKey) ||
		(typeof credentials.accessToken === "string" &&
			credentials.accessToken) ||
		null;
	if (!token) {
		return false;
	}

	const response = await fetch("https://app.asana.com/api/1.0/users/me", {
		headers: {
			Authorization: `Bearer ${token}`,
			Accept: "application/json",
		},
	});

	return response.ok;
}

export async function testClickUpConnection(credentials: ConnectorCredentials) {
	const token =
		(typeof credentials.apiKey === "string" && credentials.apiKey) ||
		(typeof credentials.accessToken === "string" &&
			credentials.accessToken) ||
		null;
	if (!token) {
		return false;
	}

	const response = await fetch("https://api.clickup.com/api/v2/user", {
		headers: {
			Authorization: token,
			Accept: "application/json",
		},
	});

	return response.ok;
}

export async function discoverZendeskResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const domain =
		typeof input.credentials.domain === "string"
			? input.credentials.domain
			: null;
	const email =
		typeof input.credentials.email === "string"
			? input.credentials.email
			: null;
	const apiToken =
		typeof input.credentials.apiToken === "string"
			? input.credentials.apiToken
			: null;
	if (!domain || !email || !apiToken) {
		throw new Error("Zendesk domain, email, and API token are required");
	}

	const baseUrl = normalizeSubdomainApiBaseUrl(
		domain,
		"zendesk.com",
		"/api/v2",
	);
	const config = input.providerConfig as ZendeskSyncConfig;
	const resources: Resource[] = [];

	if (config.includeArticles !== false) {
		const articles = await fetchZendeskJson<{
			articles?: Array<{
				id: number;
				title?: string;
				html_url?: string;
				updated_at?: string;
				label_names?: string[];
			}>;
		}>({
			baseUrl,
			email,
			apiToken,
			path: "help_center/articles",
			query: {
				"page[size]": "100",
				sort_by: "updated_at",
				sort_order: "desc",
			},
		});

		for (const article of articles.articles ?? []) {
			resources.push({
				id: `zendesk:article:${article.id}`,
				name: article.title ?? `Zendesk Article ${article.id}`,
				type: "zendesk-article",
				path: article.html_url,
				metadata: {
					sourceType: "article",
					articleId: String(article.id),
					updatedAt: article.updated_at ?? null,
					labels: article.label_names ?? [],
				},
			});
		}
	}

	if (config.includeTickets !== false) {
		const tickets = await fetchZendeskJson<{
			tickets?: Array<{
				id: number;
				subject?: string;
				updated_at?: string;
				status?: string;
			}>;
		}>({
			baseUrl,
			email,
			apiToken,
			path: "incremental/tickets.json",
			query: {
				start_time: "0",
			},
		});

		for (const ticket of tickets.tickets ?? []) {
			resources.push({
				id: `zendesk:ticket:${ticket.id}`,
				name: ticket.subject ?? `Zendesk Ticket ${ticket.id}`,
				type: "zendesk-ticket",
				path: `https://${domain
					.replace(/^https?:\/\//, "")
					.replace(/\/+$/, "")
					.replace(/\/api\/v2$/, "")}/agent/tickets/${ticket.id}`,
				metadata: {
					sourceType: "ticket",
					ticketId: String(ticket.id),
					status: ticket.status ?? null,
					updatedAt: ticket.updated_at ?? null,
				},
			});
		}
	}

	return resources;
}

export async function discoverJiraResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const domain =
		typeof input.credentials.domain === "string"
			? input.credentials.domain
			: null;
	const email =
		typeof input.credentials.email === "string"
			? input.credentials.email
			: null;
	const apiToken =
		typeof input.credentials.apiToken === "string"
			? input.credentials.apiToken
			: null;

	if (!domain || !email || !apiToken) {
		throw new Error("Jira domain, email, and API token are required");
	}

	const baseUrl = normalizeHttpsBaseUrl(domain);
	const jiraConfig = input.providerConfig as JiraSyncConfig;
	const search = await fetchConfluenceJson<{
		issues?: Array<{
			id: string;
			key: string;
			fields?: {
				summary?: string;
				updated?: string;
				status?: { name?: string };
				project?: { key?: string; name?: string };
			};
		}>;
	}>({
		baseUrl,
		email,
		apiToken,
		path: `/rest/api/3/search/jql?maxResults=100&fields=summary,updated,status,project&jql=${encodeURIComponent(buildJiraSearchJql(jiraConfig))}`,
	});

	return (search.issues ?? []).map((issue) => ({
		id: `jira:issue:${issue.key}`,
		name: issue.fields?.summary ?? issue.key,
		type: "jira-issue",
		path: `${baseUrl}/browse/${issue.key}`,
		metadata: {
			issueKey: issue.key,
			issueId: issue.id,
			projectKey: issue.fields?.project?.key ?? null,
			projectName: issue.fields?.project?.name ?? null,
			status: issue.fields?.status?.name ?? null,
			updatedAt: issue.fields?.updated ?? null,
		},
	}));
}

export async function discoverLinearResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token =
		(typeof input.credentials.apiKey === "string" &&
			input.credentials.apiKey) ||
		(typeof input.credentials.accessToken === "string" &&
			input.credentials.accessToken) ||
		null;
	if (!token) {
		throw new Error("Linear API key is required");
	}

	const linearConfig = input.providerConfig as LinearSyncConfig;
	const data = await fetchLinearJson<{
		issues: {
			nodes?: Array<{
				id: string;
				identifier: string;
				title?: string;
				url?: string;
				updatedAt?: string;
				state?: { name?: string };
				team?: { key?: string; name?: string };
			}>;
		};
	}>({
		token,
		query: `
			query LinearIssues($teamKeys: [String!]) {
				issues(
					first: 100
					orderBy: updatedAt
					filter: { team: { key: { in: $teamKeys } } }
				) {
					nodes {
						id
						identifier
						title
						url
						updatedAt
						state { name }
						team { key name }
					}
				}
			}
		`,
		variables: {
			teamKeys: linearConfig.teamKeys?.length
				? linearConfig.teamKeys
				: undefined,
		},
	});

	return (data.issues.nodes ?? []).map((issue) => ({
		id: `linear:issue:${issue.identifier}`,
		name: issue.title ?? issue.identifier,
		type: "linear-issue",
		path: issue.url,
		metadata: {
			issueId: issue.id,
			issueKey: issue.identifier,
			teamKey: issue.team?.key ?? null,
			teamName: issue.team?.name ?? null,
			status: issue.state?.name ?? null,
			updatedAt: issue.updatedAt ?? null,
		},
	}));
}

export async function discoverAsanaResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token =
		(typeof input.credentials.apiKey === "string" &&
			input.credentials.apiKey) ||
		(typeof input.credentials.accessToken === "string" &&
			input.credentials.accessToken) ||
		null;
	if (!token) {
		throw new Error("Asana API token is required");
	}

	const config = input.providerConfig as AsanaSyncConfig;
	const workspaceId =
		typeof config.workspaceId === "string" ? config.workspaceId : null;
	const projectIds = Array.isArray(config.projectIds)
		? config.projectIds.filter(
				(projectId): projectId is string =>
					typeof projectId === "string",
			)
		: [];

	if (!workspaceId && projectIds.length === 0) {
		throw new Error("Asana workspaceId or projectIds are required");
	}

	const taskRequests =
		projectIds.length > 0
			? projectIds.map((projectId) =>
					fetchAsanaJson<{
						data?: Array<{
							gid: string;
							name?: string;
							permalink_url?: string;
							modified_at?: string;
							resource_subtype?: string;
							projects?: Array<{ gid?: string; name?: string }>;
							memberships?: Array<{
								project?: { gid?: string; name?: string };
								section?: { gid?: string; name?: string };
							}>;
						}>;
					}>({
						token,
						path: `projects/${projectId}/tasks`,
						query: {
							limit: "100",
							opt_fields:
								"gid,name,permalink_url,modified_at,resource_subtype,projects.gid,projects.name,memberships.project.gid,memberships.project.name,memberships.section.gid,memberships.section.name",
						},
					}),
				)
			: [
					fetchAsanaJson<{
						data?: Array<{
							gid: string;
							name?: string;
							permalink_url?: string;
							modified_at?: string;
							resource_subtype?: string;
							projects?: Array<{ gid?: string; name?: string }>;
							memberships?: Array<{
								project?: { gid?: string; name?: string };
								section?: { gid?: string; name?: string };
							}>;
						}>;
					}>({
						token,
						path: "tasks",
						query: {
							// biome-ignore lint/style/noNonNullAssertion: workspaceId is guaranteed non-null at this point
							workspace: workspaceId!,
							limit: "100",
							opt_fields:
								"gid,name,permalink_url,modified_at,resource_subtype,projects.gid,projects.name,memberships.project.gid,memberships.project.name,memberships.section.gid,memberships.section.name",
						},
					}),
				];

	const responses = await Promise.all(taskRequests);
	const tasks = responses.flatMap((response) => response.data ?? []);

	return tasks.map((task) => {
		const primaryProject =
			task.projects?.[0] ?? task.memberships?.[0]?.project ?? null;
		const primarySection = task.memberships?.[0]?.section ?? null;

		return {
			id: `asana:task:${task.gid}`,
			name: task.name ?? `Asana Task ${task.gid}`,
			type: "asana-task",
			path:
				task.permalink_url ??
				`https://app.asana.com/0/${workspaceId ?? 0}/${task.gid}/f`,
			metadata: {
				taskId: task.gid,
				projectId: primaryProject?.gid ?? null,
				projectName: primaryProject?.name ?? null,
				sectionId: primarySection?.gid ?? null,
				sectionName: primarySection?.name ?? null,
				workspaceId,
				updatedAt: task.modified_at ?? null,
				resourceSubtype: task.resource_subtype ?? null,
			},
		};
	});
}

export async function discoverClickUpResources(input: {
	credentials: ConnectorCredentials;
	providerConfig: Record<string, unknown>;
}): Promise<Resource[]> {
	const token =
		(typeof input.credentials.apiKey === "string" &&
			input.credentials.apiKey) ||
		(typeof input.credentials.accessToken === "string" &&
			input.credentials.accessToken) ||
		null;
	if (!token) {
		throw new Error("ClickUp API token is required");
	}

	const clickUpConfig = input.providerConfig as ClickUpSyncConfig;
	const listIds = clickUpConfig.listIds?.filter(Boolean) ?? [];
	const includeClosed =
		clickUpConfig.includeClosed === true ? "true" : "false";
	const teamId =
		typeof clickUpConfig.teamId === "string" && clickUpConfig.teamId
			? clickUpConfig.teamId
			: typeof input.credentials.teamId === "string" &&
					input.credentials.teamId
				? input.credentials.teamId
				: null;

	const taskRequests =
		listIds.length > 0
			? listIds.map((listId) =>
					fetchClickUpJson<{
						tasks?: Array<{
							id: string;
							name?: string;
							url?: string;
							date_updated?: string;
							status?: { status?: string };
							list?: { id?: string; name?: string };
						}>;
					}>({
						token,
						path: `list/${listId}/task`,
						query: {
							archived: "false",
							include_closed: includeClosed,
						},
					}),
				)
			: teamId
				? [
						fetchClickUpJson<{
							tasks?: Array<{
								id: string;
								name?: string;
								url?: string;
								date_updated?: string;
								status?: { status?: string };
								list?: { id?: string; name?: string };
							}>;
						}>({
							token,
							path: `team/${teamId}/task`,
							query: {
								archived: "false",
								include_closed: includeClosed,
							},
						}),
					]
				: [];

	if (taskRequests.length === 0) {
		throw new Error("ClickUp teamId or listIds are required");
	}

	const responses = await Promise.all(taskRequests);
	const tasks = responses.flatMap((response) => response.tasks ?? []);

	return tasks.map((task) => ({
		id: `clickup:task:${task.id}`,
		name: task.name ?? `ClickUp Task ${task.id}`,
		type: "clickup-task",
		path: task.url ?? undefined,
		metadata: {
			taskId: task.id,
			listId: task.list?.id ?? null,
			listName: task.list?.name ?? null,
			status: task.status?.status ?? null,
			updatedAt: task.date_updated ?? null,
			teamId,
		},
	}));
}

export async function fetchZendeskResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const domain =
		typeof input.credentials.domain === "string"
			? input.credentials.domain
			: null;
	const email =
		typeof input.credentials.email === "string"
			? input.credentials.email
			: null;
	const apiToken =
		typeof input.credentials.apiToken === "string"
			? input.credentials.apiToken
			: null;
	if (!domain || !email || !apiToken) {
		throw new Error("Zendesk domain, email, and API token are required");
	}

	const baseUrl = normalizeSubdomainApiBaseUrl(
		domain,
		"zendesk.com",
		"/api/v2",
	);
	const sourceType =
		typeof input.resource.metadata?.sourceType === "string"
			? input.resource.metadata.sourceType
			: "article";

	if (sourceType === "ticket") {
		const ticketId =
			(typeof input.resource.metadata?.ticketId === "string" &&
				input.resource.metadata.ticketId) ||
			input.resource.id.replace(/^zendesk:ticket:/, "");

		const [ticket, comments] = await Promise.all([
			fetchZendeskJson<{
				ticket: {
					id: number;
					subject?: string;
					description?: string | null;
					status?: string;
					priority?: string | null;
					updated_at?: string;
				};
			}>({
				baseUrl,
				email,
				apiToken,
				path: `tickets/${ticketId}.json`,
			}),
			fetchZendeskJson<{
				comments?: Array<{
					id: number;
					body?: string | null;
					html_body?: string | null;
					public?: boolean;
					created_at?: string;
				}>;
			}>({
				baseUrl,
				email,
				apiToken,
				path: `tickets/${ticketId}/comments.json`,
			}),
		]);

		const commentText = (comments.comments ?? [])
			.map((comment) =>
				[
					comment.created_at
						? `Comment at: ${comment.created_at}`
						: null,
					comment.public === false
						? "Visibility: internal"
						: "Visibility: public",
					comment.body?.trim() ||
						(comment.html_body
							? convertHtmlToText(comment.html_body)
							: "") ||
						"(No comment text)",
				]
					.filter((value): value is string => Boolean(value))
					.join("\n"),
			)
			.join("\n\n---\n\n");

		const updatedAt = ticket.ticket.updated_at ?? null;
		const title =
			ticket.ticket.subject ?? `Zendesk Ticket ${ticket.ticket.id}`;
		const content = [
			`# ${title}`,
			"",
			ticket.ticket.description?.trim() || "(No ticket description)",
			commentText ? `\n## Comments\n\n${commentText}` : null,
		]
			.filter((value): value is string => Boolean(value))
			.join("\n");

		return {
			documents: [
				{
					id: `zendesk-ticket-${ticket.ticket.id}`,
					externalId: `zendesk:ticket:${ticket.ticket.id}`,
					title,
					content,
					contentHash: updatedAt ?? undefined,
					metadata: {
						resourceType: "ticket",
						ticketId: String(ticket.ticket.id),
						status: ticket.ticket.status ?? null,
						priority: ticket.ticket.priority ?? null,
						url:
							input.resource.path ??
							`https://${domain.replace(/^https?:\/\//, "").replace(/\/+$/, "")}/agent/tickets/${ticket.ticket.id}`,
						updatedAt,
						commentCount: comments.comments?.length ?? 0,
					},
					sizeBytes: Buffer.byteLength(content, "utf8"),
					textLength: content.length,
				},
			],
			newCursor: updatedAt
				? {
						connectorId: input.connectorId,
						provider: "ZENDESK",
						cursorType: "incremental",
						cursor: updatedAt,
						lastSyncedAt: updatedAt,
					}
				: undefined,
		};
	}

	const articleId =
		(typeof input.resource.metadata?.articleId === "string" &&
			input.resource.metadata.articleId) ||
		input.resource.id.replace(/^zendesk:article:/, "");
	const article = await fetchZendeskJson<{
		article: {
			id: number;
			title?: string;
			body?: string | null;
			html_url?: string;
			updated_at?: string;
			label_names?: string[];
		};
	}>({
		baseUrl,
		email,
		apiToken,
		path: `help_center/articles/${articleId}`,
	});

	const bodyText = convertHtmlToText(article.article.body ?? "");
	const updatedAt = article.article.updated_at ?? null;
	const title =
		article.article.title ?? `Zendesk Article ${article.article.id}`;
	const content = `# ${title}\n\n${bodyText || "(Content could not be extracted)"}`;

	return {
		documents: [
			{
				id: `zendesk-article-${article.article.id}`,
				externalId: `zendesk:article:${article.article.id}`,
				title,
				content,
				contentHash: updatedAt ?? undefined,
				metadata: {
					resourceType: "article",
					articleId: String(article.article.id),
					url:
						article.article.html_url ?? input.resource.path ?? null,
					updatedAt,
					labels: article.article.label_names ?? [],
				},
				sizeBytes: Buffer.byteLength(
					article.article.body ?? "",
					"utf8",
				),
				textLength: bodyText.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "ZENDESK",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}

export async function fetchJiraResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const domain =
		typeof input.credentials.domain === "string"
			? input.credentials.domain
			: null;
	const email =
		typeof input.credentials.email === "string"
			? input.credentials.email
			: null;
	const apiToken =
		typeof input.credentials.apiToken === "string"
			? input.credentials.apiToken
			: null;

	if (!domain || !email || !apiToken) {
		throw new Error("Jira domain, email, and API token are required");
	}

	const baseUrl = normalizeHttpsBaseUrl(domain);
	const issueKey =
		(typeof input.resource.metadata?.issueKey === "string" &&
			input.resource.metadata.issueKey) ||
		input.resource.id.replace(/^jira:issue:/, "");

	const issue = await fetchConfluenceJson<{
		id: string;
		key: string;
		fields?: {
			summary?: string;
			description?: unknown;
			updated?: string;
			status?: { name?: string };
			priority?: { name?: string };
			issuetype?: { name?: string };
			project?: { key?: string; name?: string };
			comment?: {
				comments?: Array<{
					body?: unknown;
					created?: string;
					author?: { displayName?: string };
				}>;
			};
		};
	}>({
		baseUrl,
		email,
		apiToken,
		path: `/rest/api/3/issue/${encodeURIComponent(issueKey)}?fields=summary,description,updated,status,priority,issuetype,project,comment`,
	});

	const descriptionText = extractJiraAdfText(issue.fields?.description);
	const commentsText = (issue.fields?.comment?.comments ?? [])
		.map((comment) =>
			[
				comment.author?.displayName
					? `Author: ${comment.author.displayName}`
					: null,
				comment.created ? `Created: ${comment.created}` : null,
				extractJiraAdfText(comment.body) || "(No comment text)",
			]
				.filter((value): value is string => Boolean(value))
				.join("\n"),
		)
		.join("\n\n---\n\n");

	const title = issue.fields?.summary ?? issue.key;
	const updatedAt = issue.fields?.updated ?? null;
	const content = [
		`# ${title}`,
		"",
		descriptionText || "(No issue description)",
		commentsText ? `\n## Comments\n\n${commentsText}` : null,
	]
		.filter((value): value is string => Boolean(value))
		.join("\n");

	return {
		documents: [
			{
				id: `jira-issue-${issue.key}`,
				externalId: `jira:issue:${issue.key}`,
				title,
				content,
				contentHash: updatedAt ?? undefined,
				metadata: {
					resourceType: "issue",
					issueId: issue.id,
					issueKey: issue.key,
					projectKey: issue.fields?.project?.key ?? null,
					projectName: issue.fields?.project?.name ?? null,
					status: issue.fields?.status?.name ?? null,
					priority: issue.fields?.priority?.name ?? null,
					issueType: issue.fields?.issuetype?.name ?? null,
					url: `${baseUrl}/browse/${issue.key}`,
					updatedAt,
					commentCount: issue.fields?.comment?.comments?.length ?? 0,
				},
				sizeBytes: Buffer.byteLength(content, "utf8"),
				textLength: content.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "JIRA",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}

export async function fetchLinearResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token =
		(typeof input.credentials.apiKey === "string" &&
			input.credentials.apiKey) ||
		(typeof input.credentials.accessToken === "string" &&
			input.credentials.accessToken) ||
		null;
	if (!token) {
		throw new Error("Linear API key is required");
	}

	const issueKey =
		(typeof input.resource.metadata?.issueKey === "string" &&
			input.resource.metadata.issueKey) ||
		input.resource.id.replace(/^linear:issue:/, "");

	const data = await fetchLinearJson<{
		issues: {
			nodes?: Array<{
				id: string;
				identifier: string;
				title?: string;
				url?: string;
				description?: string | null;
				updatedAt?: string;
				priorityLabel?: string | null;
				state?: { name?: string };
				team?: { key?: string; name?: string };
				comments?: {
					nodes?: Array<{
						body?: string | null;
						url?: string | null;
					}>;
				};
			}>;
		};
	}>({
		token,
		query: `
			query LinearIssue($identifier: String!) {
				issues(
					first: 1
					filter: { identifier: { eq: $identifier } }
				) {
					nodes {
						id
						identifier
						title
						url
						description
						updatedAt
						priorityLabel
						state { name }
						team { key name }
						comments(first: 50) {
							nodes {
								body
								url
							}
						}
					}
				}
			}
		`,
		variables: {
			identifier: issueKey,
		},
	});

	const issue = data.issues.nodes?.[0];
	if (!issue) {
		return { documents: [] };
	}

	const commentsText = (issue.comments?.nodes ?? [])
		.map((comment) => comment.body?.trim())
		.filter((value): value is string => Boolean(value))
		.join("\n\n---\n\n");

	const title = issue.title ?? issue.identifier;
	const updatedAt = issue.updatedAt ?? null;
	const content = [
		`# ${title}`,
		"",
		issue.description?.trim() || "(No issue description)",
		commentsText ? `\n## Comments\n\n${commentsText}` : null,
	]
		.filter((value): value is string => Boolean(value))
		.join("\n");

	return {
		documents: [
			{
				id: `linear-issue-${issue.identifier}`,
				externalId: `linear:issue:${issue.identifier}`,
				title,
				content,
				contentHash: updatedAt ?? undefined,
				metadata: {
					resourceType: "issue",
					issueId: issue.id,
					issueKey: issue.identifier,
					teamKey: issue.team?.key ?? null,
					teamName: issue.team?.name ?? null,
					status: issue.state?.name ?? null,
					priority: issue.priorityLabel ?? null,
					url: issue.url ?? input.resource.path ?? null,
					updatedAt,
					commentCount: issue.comments?.nodes?.length ?? 0,
				},
				sizeBytes: Buffer.byteLength(content, "utf8"),
				textLength: content.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "LINEAR",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}

export async function fetchAsanaResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token =
		(typeof input.credentials.apiKey === "string" &&
			input.credentials.apiKey) ||
		(typeof input.credentials.accessToken === "string" &&
			input.credentials.accessToken) ||
		null;
	if (!token) {
		throw new Error("Asana API token is required");
	}

	const taskId =
		(typeof input.resource.metadata?.taskId === "string" &&
			input.resource.metadata.taskId) ||
		input.resource.id.replace(/^asana:task:/, "");

	const [task, stories] = await Promise.all([
		fetchAsanaJson<{
			data: {
				gid: string;
				name?: string;
				notes?: string | null;
				permalink_url?: string;
				completed?: boolean;
				completed_at?: string | null;
				modified_at?: string;
				due_on?: string | null;
				due_at?: string | null;
				resource_subtype?: string;
				assignee?: { name?: string | null };
				projects?: Array<{ gid?: string; name?: string }>;
			};
		}>({
			token,
			path: `tasks/${taskId}`,
			query: {
				opt_fields:
					"gid,name,notes,permalink_url,completed,completed_at,modified_at,due_on,due_at,resource_subtype,assignee.name,projects.gid,projects.name",
			},
		}),
		fetchAsanaJson<{
			data?: Array<{
				gid: string;
				type?: string;
				text?: string;
				created_at?: string;
				created_by?: { name?: string | null };
			}>;
		}>({
			token,
			path: `tasks/${taskId}/stories`,
			query: {
				limit: "100",
				opt_fields: "gid,type,text,created_at,created_by.name",
			},
		}),
	]);

	const title = task.data.name ?? input.resource.name;
	const comments = (stories.data ?? [])
		.filter((story) => typeof story.text === "string" && story.text.trim())
		.map((story) =>
			[
				story.created_at ? `Comment at: ${story.created_at}` : null,
				story.created_by?.name ? `By: ${story.created_by.name}` : null,
				story.text?.trim() ?? null,
			]
				.filter((value): value is string => Boolean(value))
				.join("\n"),
		)
		.join("\n\n---\n\n");

	const project = task.data.projects?.[0] ?? null;
	const updatedAt = task.data.modified_at ?? null;
	const content = [
		`# ${title}`,
		"",
		task.data.notes?.trim() || "(No task description)",
		task.data.assignee?.name
			? `Assignee: ${task.data.assignee.name}`
			: null,
		task.data.completed ? "Status: completed" : "Status: open",
		task.data.due_on ? `Due: ${task.data.due_on}` : null,
		task.data.resource_subtype
			? `Type: ${task.data.resource_subtype}`
			: null,
		comments ? `\n## Comments\n\n${comments}` : null,
	]
		.filter((value): value is string => Boolean(value))
		.join("\n");

	return {
		documents: [
			{
				id: `asana-task-${task.data.gid}`,
				externalId: `asana:task:${task.data.gid}`,
				title,
				content,
				contentHash: updatedAt ?? undefined,
				metadata: {
					resourceType: "task",
					taskId: task.data.gid,
					projectId: project?.gid ?? null,
					projectName: project?.name ?? null,
					url: task.data.permalink_url ?? input.resource.path ?? null,
					updatedAt,
					completed: task.data.completed ?? false,
					completedAt: task.data.completed_at ?? null,
				},
				sizeBytes: Buffer.byteLength(content, "utf8"),
				textLength: content.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "ASANA",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}

export async function fetchClickUpResourceDocuments(input: {
	connectorId: string;
	resource: Resource;
	credentials: ConnectorCredentials;
}): Promise<{ documents: Document[]; newCursor?: SyncCursor }> {
	const token =
		(typeof input.credentials.apiKey === "string" &&
			input.credentials.apiKey) ||
		(typeof input.credentials.accessToken === "string" &&
			input.credentials.accessToken) ||
		null;
	if (!token) {
		throw new Error("ClickUp API token is required");
	}

	const taskId =
		(typeof input.resource.metadata?.taskId === "string" &&
			input.resource.metadata.taskId) ||
		input.resource.id.replace(/^clickup:task:/, "");

	const [task, comments] = await Promise.all([
		fetchClickUpJson<{
			id: string;
			name?: string;
			description?: string | null;
			url?: string;
			date_updated?: string;
			status?: { status?: string };
			priority?: { priority?: string | null };
			due_date?: string | null;
			list?: { id?: string; name?: string };
			assignees?: Array<{ username?: string | null }>;
		}>({
			token,
			path: `task/${taskId}`,
		}),
		fetchClickUpJson<{
			comments?: Array<{
				comment_text?: string;
				date?: string;
				user?: { username?: string | null };
			}>;
		}>({
			token,
			path: `task/${taskId}/comment`,
		}),
	]);

	const commentsText = (comments.comments ?? [])
		.map((comment) =>
			[
				comment.date ? `Comment at: ${comment.date}` : null,
				comment.user?.username ? `By: ${comment.user.username}` : null,
				comment.comment_text?.trim() || null,
			]
				.filter((value): value is string => Boolean(value))
				.join("\n"),
		)
		.join("\n\n---\n\n");

	const title = task.name ?? input.resource.name;
	const updatedAt = task.date_updated ?? null;
	const primaryAssignee = task.assignees?.[0]?.username ?? null;
	const content = [
		`# ${title}`,
		"",
		task.description?.trim() || "(No task description)",
		primaryAssignee ? `Assignee: ${primaryAssignee}` : null,
		task.status?.status ? `Status: ${task.status.status}` : null,
		task.priority?.priority ? `Priority: ${task.priority.priority}` : null,
		task.due_date ? `Due: ${task.due_date}` : null,
		commentsText ? `\n## Comments\n\n${commentsText}` : null,
	]
		.filter((value): value is string => Boolean(value))
		.join("\n");

	return {
		documents: [
			{
				id: `clickup-task-${task.id}`,
				externalId: `clickup:task:${task.id}`,
				title,
				content,
				contentHash: updatedAt ?? undefined,
				metadata: {
					resourceType: "task",
					taskId: task.id,
					listId: task.list?.id ?? null,
					listName: task.list?.name ?? null,
					status: task.status?.status ?? null,
					url: task.url ?? input.resource.path ?? null,
					updatedAt,
					commentCount: comments.comments?.length ?? 0,
				},
				sizeBytes: Buffer.byteLength(content, "utf8"),
				textLength: content.length,
			},
		],
		newCursor: updatedAt
			? {
					connectorId: input.connectorId,
					provider: "CLICKUP",
					cursorType: "incremental",
					cursor: updatedAt,
					lastSyncedAt: updatedAt,
				}
			: undefined,
	};
}
