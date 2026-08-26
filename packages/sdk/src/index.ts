/**
 * @fabricorg/sdk — TypeScript SDK for the Fabric AI platform
 *
 * @example
 * ```ts
 * import { createFabric } from '@fabricorg/sdk';
 *
 * const fabric = createFabric({
 *   apiKey: process.env.FABRIC_API_KEY,
 *   org: 'acme',                           // default context for every call
 * });
 *
 * const me      = await fabric.auth.whoami();
 * const project = await fabric.projects.list();
 *
 * // Bound clones — context is implicit from here on.
 * const proj = fabric.withProject('proj_123');
 * await proj.features.create({ title: 'Add SSO', priority: 'P1_HIGH' });
 * ```
 */

import { type FabricClientOptions, FabricHttpClient } from "./client.js";
import { AgentsResource } from "./resources/agents.js";
import { ApprovalsResource } from "./resources/approvals.js";
import { AuthResource } from "./resources/auth.js";
import { ChannelsResource } from "./resources/channels.js";
import { ChatsResource } from "./resources/chats.js";
import { FramesResource } from "./resources/frames.js";
import {
	createIntegrationsResource,
	type IntegrationsResource,
} from "./resources/integrations.js";
import { KnowledgeResource } from "./resources/knowledge.js";
import { McpResource } from "./resources/mcp.js";
import { OrgsResource } from "./resources/orgs.js";
import { ProjectsResource } from "./resources/projects.js";
import { PromptsResource } from "./resources/prompts.js";
import { ReportsResource } from "./resources/reports.js";
import { SkillsResource } from "./resources/skills.js";
import { WorkflowsResource } from "./resources/workflows.js";
import { WorkspacesResource } from "./resources/workspaces.js";

/**
 * Create a new Fabric client. Recommended entry point.
 *
 * Equivalent to `new FabricClient(options)`; `createFabric` is the documented
 * default because it composes naturally with `withOrg` / `withProject` /
 * `withPersonal` returning bound clones.
 */
export function createFabric(options: FabricClientOptions = {}): FabricClient {
	return new FabricClient(options);
}

export class FabricClient {
	readonly auth: AuthResource;
	readonly orgs: OrgsResource;
	readonly projects: ProjectsResource;
	readonly workflows: WorkflowsResource;
	readonly prompts: PromptsResource;
	readonly agents: AgentsResource;
	readonly skills: SkillsResource;
	readonly mcp: McpResource;
	readonly frames: FramesResource;
	readonly workspaces: WorkspacesResource;
	readonly chats: ChatsResource;
	readonly reports: ReportsResource;
	readonly integrations: IntegrationsResource;
	readonly channels: ChannelsResource;
	readonly approvals: ApprovalsResource;
	readonly knowledge: KnowledgeResource;

	/** Default project ID applied to project-scoped resources when not passed per-call. */
	readonly defaultProject: string | undefined;

	private readonly http: FabricHttpClient;

	constructor(optionsOrHttp: FabricClientOptions | FabricHttpClient = {}) {
		// Internal overload: an existing FabricHttpClient is used as-is so the
		// bound-clone helpers (withOrg / withProject / withPersonal) avoid
		// rebuilding from raw options.
		this.http =
			optionsOrHttp instanceof FabricHttpClient
				? optionsOrHttp
				: new FabricHttpClient(optionsOrHttp);
		this.defaultProject = this.http.defaults.project;

		this.auth = new AuthResource(this.http);
		this.orgs = new OrgsResource(this.http);
		this.projects = new ProjectsResource(this.http);
		this.workflows = new WorkflowsResource(this.http);
		this.prompts = new PromptsResource(this.http);
		this.agents = new AgentsResource(this.http);
		this.skills = new SkillsResource(this.http);
		this.mcp = new McpResource(this.http);
		this.frames = new FramesResource(this.http);
		this.workspaces = new WorkspacesResource(this.http);
		this.chats = new ChatsResource(this.http);
		this.reports = new ReportsResource(this.http);
		this.integrations = createIntegrationsResource(this.http);
		this.channels = new ChannelsResource(this.http);
		this.approvals = new ApprovalsResource(this.http);
		this.knowledge = new KnowledgeResource(this.http);
	}

	/** Returns a new client bound to the given org slug. Original is untouched. */
	withOrg(slug: string): FabricClient {
		return new FabricClient(this.http.withDefaults({ org: slug }));
	}

	/** Returns a new client bound to personal context. */
	withPersonal(): FabricClient {
		return new FabricClient(this.http.withDefaults({ personal: true }));
	}

	/** Returns a new client with a default project ID applied where resources accept one. */
	withProject(projectId: string): FabricClient {
		return new FabricClient(this.http.withDefaults({ project: projectId }));
	}
}

export type {
	ExecuteAgentOptions,
	InvokeAgentOptions,
	ListAgentsOptions,
} from "./resources/agents.js";
export type {
	ApprovalRunResult,
	ListApprovalsOptions,
	PendingApproval,
} from "./resources/approvals.js";
export type { CreateKeyOptions } from "./resources/auth.js";
export type {
	ChannelInfo,
	SendChannelMessageInput,
	SendChannelMessageResult,
} from "./resources/channels.js";
export type {
	CreateChatOptions,
	ListChatsOptions,
	SendMessageOptions,
	SendMessageResult,
	UpdateChatOptions,
} from "./resources/chats.js";
export type { ListFramesOptions } from "./resources/frames.js";
export type {
	FabricIntegrations,
	GenericIntegrationClient,
	IntegrationConnection,
	IntegrationsResource,
} from "./resources/integrations.js";
export type {
	KnowledgeChunk,
	KnowledgeScope,
	KnowledgeSearchOptions,
} from "./resources/knowledge.js";
export type { ListMcpOptions } from "./resources/mcp.js";
export type {
	CreateDocumentOptions,
	CreateFeatureOptions,
	CreateProjectOptions,
	FabricDocumentStatus,
	FabricDocumentType,
	ListDocumentsOptions,
	ListFeaturesOptions,
	ListProjectsOptions,
	UpdateDocumentOptions,
	UpdateFeatureOptions,
	UpdateProjectOptions,
} from "./resources/projects.js";
export type {
	CreatePromptOptions,
	ListPromptsOptions,
	UpdatePromptOptions,
} from "./resources/prompts.js";
export type {
	ListReportExecutionsOptions,
	ListReportTemplatesOptions,
} from "./resources/reports.js";
export type { ListSkillsOptions } from "./resources/skills.js";
export type {
	FabricExecutionStatus,
	ListExecutionsOptions,
	ListWorkflowsOptions,
	TriggerOptions,
} from "./resources/workflows.js";
export type {
	ListWorkspacesOptions,
	QueryWorkspaceOptions,
	WorkspaceQueryHit,
} from "./resources/workspaces.js";
// Re-export types for consumers
export type {
	FabricAgent,
	FabricAgentExecution,
	FabricApiKey,
	FabricApiKeyCreated,
	FabricChat,
	FabricClientOptions,
	FabricContext,
	FabricDocument,
	FabricDocumentSummary,
	FabricExecution,
	FabricFeature,
	FabricFrame,
	FabricMcpConfig,
	FabricMcpConfigDetail,
	FabricMcpServer,
	FabricOrg,
	FabricProject,
	FabricPrompt,
	FabricReportExecution,
	FabricReportTemplate,
	FabricRetryOptions,
	FabricSkill,
	FabricTask,
	FabricTelemetryEvent,
	FabricUser,
	FabricWorkflow,
	FabricWorkspace,
	FabricWorkspaceDetail,
	ListOptions,
	OrgContext,
	PersonalContext,
	WhoamiResult,
} from "./types.js";
export {
	FabricAuthError,
	FabricError,
	FabricForbiddenError,
	FabricNotFoundError,
} from "./types.js";
