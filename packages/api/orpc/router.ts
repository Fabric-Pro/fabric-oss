import { type AnyRouter, lazy, type RouterClient } from "@orpc/server";
import { publicProcedure } from "./procedures";

/**
 * Mounts a module router lazily. A request resolves only the module router it
 * addresses, so a cold function instance evaluates that module's import graph
 * (and no other) instead of all ~50 module routers up front. The router type,
 * and with it `ApiRouterClient`, is unchanged: oRPC unwraps `Lazy` in
 * `RouterClient` and in the OpenAPI generator.
 */
function lazyRouter<TKey extends string, TRouter extends AnyRouter>(
	key: TKey,
	load: () => Promise<Record<TKey, TRouter>>,
) {
	return lazy(() => load().then((loaded) => ({ default: loaded[key] })));
}

export const router = publicProcedure
	// Prefix for openapi
	.prefix("/api")
	.router({
		admin: lazyRouter(
			"adminRouter",
			() => import("../modules/admin/router"),
		),
		agentDeployments: lazyRouter(
			"agentDeploymentsRouter",
			() => import("../modules/agent-deployments/router"),
		),
		agentMemory: lazyRouter(
			"agentMemoryRouter",
			() => import("../modules/agent-memory/router"),
		),
		agents: lazyRouter(
			"agentsRouter",
			() => import("../modules/agents/router"),
		),
		agentTemplates: lazyRouter(
			"agentTemplatesRouter",
			() => import("../modules/agent-templates/router"),
		),
		ai: lazyRouter("aiRouter", () => import("../modules/ai/router")),
		aiConfig: lazyRouter(
			"aiConfigRouter",
			() => import("../modules/ai-config/router"),
		),
		auth: lazyRouter("authRouter", () => import("../modules/auth/router")),
		artifacts: lazyRouter(
			"artifactsRouter",
			() => import("../modules/artifacts/router"),
		),
		audit: lazyRouter(
			"auditRouter",
			() => import("../modules/audit/router"),
		),
		userActivity: lazyRouter(
			"userActivityRouter",
			() => import("../modules/user-activity/router"),
		),
		automationTemplates: lazyRouter(
			"automationTemplatesRouter",
			() => import("../modules/automation-templates/router"),
		),
		atlas: lazyRouter(
			"atlasRouter",
			() => import("../modules/atlas/router"),
		),
		codingRuns: lazyRouter(
			"codingRunsRouter",
			() => import("../modules/coding-runs/router"),
		),
		dailyBrief: lazyRouter(
			"dailyBriefRouter",
			() => import("../modules/daily-brief/router"),
		),
		dashboard: lazyRouter(
			"dashboardRouter",
			() => import("../modules/dashboard/router"),
		),
		frames: lazyRouter(
			"framesRouter",
			() => import("../modules/frames/router"),
		),
		functionTags: lazyRouter(
			"functionTagsRouter",
			() => import("../modules/function-tags/router"),
		),
		todos: lazyRouter(
			"todosRouter",
			() => import("../modules/todos/router"),
		),
		github: lazyRouter(
			"githubRouter",
			() => import("../modules/github/router"),
		),
		incidents: lazyRouter(
			"incidentsRouter",
			() => import("../modules/incidents/router"),
		),
		integrationHealth: lazyRouter(
			"integrationHealthRouter",
			() => import("../modules/integration-health/router"),
		),
		integrations: lazyRouter(
			"integrationsRouter",
			() => import("../modules/integrations/router"),
		),
		jobs: lazyRouter("jobsRouter", () => import("../modules/jobs/router")),
		kanban: lazyRouter(
			"kanbanRouter",
			() => import("../modules/kanban/router"),
		),
		mcp: lazyRouter("mcpRouter", () => import("../modules/mcp/router")),
		newsletter: lazyRouter(
			"newsletterRouter",
			() => import("../modules/newsletter/router"),
		),
		notifications: lazyRouter(
			"notificationsRouter",
			() => import("../modules/notifications/router"),
		),
		openapi: lazyRouter(
			"openapiRouter",
			() => import("../modules/openapi/router"),
		),
		orchestrator: lazyRouter(
			"orchestratorRouter",
			() => import("../modules/orchestrator/router"),
		),
		organizations: lazyRouter(
			"organizationsRouter",
			() => import("../modules/organizations/router"),
		),
		outcomes: lazyRouter(
			"outcomesRouter",
			() => import("../modules/outcomes/router"),
		),
		payments: lazyRouter(
			"paymentsRouter",
			() => import("../modules/payments/router"),
		),
		projects: lazyRouter(
			"projectsRouter",
			() => import("../modules/projects/router"),
		),
		capabilities: lazyRouter(
			"capabilitiesRouter",
			() => import("../modules/capabilities/router"),
		),
		prompts: lazyRouter(
			"promptsRouter",
			() => import("../modules/prompts/router"),
		),
		ragProviders: lazyRouter(
			"ragProvidersRouter",
			() => import("../modules/rag-providers/router"),
		),
		runtime: lazyRouter(
			"runtimeRouter",
			() => import("../modules/runtime/router"),
		),
		sandbox: lazyRouter(
			"sandboxRouter",
			() => import("../modules/sandbox/router"),
		),
		searchProviders: lazyRouter(
			"searchProvidersRouter",
			() => import("../modules/search-providers/router"),
		),
		users: lazyRouter(
			"usersRouter",
			() => import("../modules/users/router"),
		),
		wizard: lazyRouter(
			"wizardRouter",
			() => import("../modules/wizard/router"),
		),
		workflows: lazyRouter(
			"workflowsRouter",
			() => import("../modules/workflows/router"),
		),
		workspace: lazyRouter(
			"workspaceRouter",
			() => import("../modules/workspace/router"),
		),
		documentWorkspaces: lazyRouter(
			"documentWorkspacesRouter",
			() => import("../modules/workspaces/router"),
		),
		reports: lazyRouter(
			"reportsRouter",
			() => import("../modules/reports/router"),
		),
		waitlist: lazyRouter(
			"waitlistRouter",
			() => import("../modules/waitlist/router"),
		),
		dataConnections: lazyRouter(
			"dataConnectionsRouter",
			() => import("../modules/data-connections/router"),
		),
		skills: lazyRouter(
			"skillsRouter",
			() => import("../modules/skills/router"),
		),
		subscriptions: lazyRouter(
			"subscriptionsRouter",
			() => import("../modules/subscriptions/router"),
		),
		systemHealth: lazyRouter(
			"systemHealthRouter",
			() => import("../modules/system-health/router"),
		),
		weave: lazyRouter(
			"weaveRouter",
			() => import("../modules/weave/router"),
		),
	});

export type ApiRouterClient = RouterClient<typeof router>;
