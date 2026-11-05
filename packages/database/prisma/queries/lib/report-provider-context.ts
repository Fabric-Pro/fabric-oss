/**
 * The context values each tool asks for when a report reads through it (a Fizzy
 * board, an Azure DevOps project), and what a project already answers for them.
 * Pure, so the report dialogs and the API make the same decision.
 */

export type ProviderContextField = {
	key: string;
	label: string;
	placeholder: string;
	required: boolean;
	helpText: string;
};

// Human-readable values the AI uses to find specific resources.
export const PROVIDER_CONTEXT_FIELDS: Record<string, ProviderContextField[]> = {
	azure_devops: [
		{
			key: "project",
			label: "Project Name",
			placeholder: "MyProject",
			required: true,
			helpText: "The Azure DevOps project name",
		},
		{
			key: "team",
			label: "Team Name",
			placeholder: "MyTeam",
			required: false,
			helpText: "The team name within the project (optional)",
		},
	],
	fizzy: [
		{
			key: "accountSlug",
			label: "Account Slug",
			placeholder: "123456",
			required: true,
			helpText:
				"The Fizzy account slug (e.g., '123456'). Find it via fizzy_get_identity.",
		},
		{
			key: "boardId",
			label: "Board",
			placeholder: "12345",
			required: true,
			helpText: "The Fizzy board to report on",
		},
		{
			key: "boardName",
			label: "Board Name",
			placeholder: "My Board",
			required: false,
			helpText:
				"Board name to help AI identify the right board (optional)",
		},
	],
	github: [
		{
			key: "organization",
			label: "Organization",
			placeholder: "my-org",
			required: true,
			helpText: "GitHub organization or username",
		},
		{
			key: "repository",
			label: "Repository",
			placeholder: "my-repo",
			required: false,
			helpText: "Repository name (optional, for repo-specific reports)",
		},
	],
	slack: [
		{
			key: "channels",
			label: "Channels",
			placeholder: "general, engineering",
			required: false,
			helpText: "Comma-separated channel names to focus on (optional)",
		},
	],
	linear: [
		{
			key: "team",
			label: "Team Name",
			placeholder: "Engineering",
			required: true,
			helpText: "Linear team name",
		},
	],
	jira: [
		{
			key: "project",
			label: "Project Key",
			placeholder: "PROJ",
			required: true,
			helpText: "Jira project key",
		},
	],
	microsoft_graph: [
		{
			key: "team",
			label: "Team Name",
			placeholder: "Engineering Team",
			required: false,
			helpText: "Microsoft Teams team name (optional)",
		},
		{
			key: "channels",
			label: "Channels",
			placeholder: "General, Announcements",
			required: false,
			helpText: "Comma-separated channel names (optional)",
		},
	],
};

/** Server keys that differ from the provider key the setup screens use. */
const SERVER_PROVIDER_ALIASES: Record<string, string> = {
	atlassian: "jira",
	"github-remote": "github",
	"gitlab-official": "gitlab",
	"linear-remote": "linear",
	"slack-remote": "slack",
};

function normalizedKey(key: string): string {
	return key.toLowerCase().replace(/[-_]/g, "");
}

/** The provider key the setup screens use for an MCP server. */
export function providerForServerKey(
	serverKey: string | null | undefined,
): string | null {
	if (!serverKey) {
		return null;
	}
	const normalized = normalizedKey(serverKey);
	return (
		SERVER_PROVIDER_ALIASES[serverKey.toLowerCase()] ??
		Object.keys(PROVIDER_CONTEXT_FIELDS).find(
			(provider) => normalizedKey(provider) === normalized,
		) ??
		serverKey
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** The project-management container a project saved in its settings. */
export type ProjectPmContainer = {
	projectManagementContainerId?: string | null;
	projectManagementContainerName?: string | null;
	projectManagementAdditionalContext?: unknown;
};

/** The account slug a project's container lookup recorded, without a leading slash. */
function projectAccountSlug(additionalContext: unknown): string {
	if (!isRecord(additionalContext)) {
		return "";
	}
	const raw =
		text(additionalContext.account_slug) ||
		text(additionalContext.accountSlug) ||
		text(additionalContext.slug);
	return raw.replace(/^\/+/, "");
}

/**
 * What a project's saved container answers for a tool's context fields: a Fizzy
 * board with its account, an Azure DevOps project with its team. Nothing for a
 * tool whose fields a container does not answer.
 */
export function projectPmContext(
	provider: string,
	container: ProjectPmContainer,
): Record<string, string> {
	const id = text(container.projectManagementContainerId);
	const name = text(container.projectManagementContainerName);
	const additional = container.projectManagementAdditionalContext;
	if (provider === "fizzy") {
		if (!id) {
			return {};
		}
		const slug = projectAccountSlug(additional);
		return {
			boardId: id,
			boardName: name || id,
			...(slug ? { accountSlug: slug } : {}),
		};
	}
	if (provider === "azure_devops") {
		if (!name && !id) {
			return {};
		}
		const team = isRecord(additional) ? text(additional.team) : "";
		return { project: name || id, ...(team ? { team } : {}) };
	}
	return {};
}

export type ProjectRepositoryProvider = "GITHUB" | "GITLAB" | "AZURE_DEVOPS";

/** The repository a project reads, as its first active integration names it. */
export type ProjectRepository = {
	provider: ProjectRepositoryProvider;
	repositoryOwner: string;
	repositoryName: string;
};

/** The provider key each repository host's MCP servers resolve to. */
const REPOSITORY_TOOL: Record<ProjectRepositoryProvider, string> = {
	GITHUB: "github",
	GITLAB: "gitlab",
	AZURE_DEVOPS: "azure_devops",
};

/** Whether a server of this key reads the project's repository host. */
export function serverReadsRepository(
	serverKey: string | null | undefined,
	provider: ProjectRepositoryProvider,
): boolean {
	return providerForServerKey(serverKey) === REPOSITORY_TOOL[provider];
}

/** The context a project's repository answers. */
export function projectRepositoryContext(
	repository: Pick<ProjectRepository, "repositoryOwner" | "repositoryName">,
): Record<string, string> {
	const organization = text(repository.repositoryOwner);
	const name = text(repository.repositoryName);
	return {
		...(organization ? { organization } : {}),
		...(name ? { repository: name } : {}),
	};
}
