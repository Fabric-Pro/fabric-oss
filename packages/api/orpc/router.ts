import type { RouterClient } from "@orpc/server";
import { adminRouter } from "../modules/admin/router";
import { agentDeploymentsRouter } from "../modules/agent-deployments/router";
import { agentMemoryRouter } from "../modules/agent-memory/router";
import { agentTemplatesRouter } from "../modules/agent-templates/router";
import { agentsRouter } from "../modules/agents/router";
import { aiRouter } from "../modules/ai/router";
import { aiConfigRouter } from "../modules/ai-config/router";
import { artifactsRouter } from "../modules/artifacts/router";
import { atlasRouter } from "../modules/atlas/router";
import { auditRouter } from "../modules/audit/router";
import { authRouter } from "../modules/auth/router";
import { automationTemplatesRouter } from "../modules/automation-templates/router";
import { codingRunsRouter } from "../modules/coding-runs/router";
import { dailyBriefRouter } from "../modules/daily-brief/router";
import { dashboardRouter } from "../modules/dashboard/router";
import { dataConnectionsRouter } from "../modules/data-connections/router";
import { framesRouter } from "../modules/frames/router";
import { functionTagsRouter } from "../modules/function-tags/router";
import { githubRouter } from "../modules/github/router";
import { incidentsRouter } from "../modules/incidents/router";
import { integrationHealthRouter } from "../modules/integration-health/router";
import { integrationsRouter } from "../modules/integrations/router";
import { jobsRouter } from "../modules/jobs/router";
import { kanbanRouter } from "../modules/kanban/router";
import { mcpRouter } from "../modules/mcp/router";
import { newsletterRouter } from "../modules/newsletter/router";
import { notificationsRouter } from "../modules/notifications/router";
import { openapiRouter } from "../modules/openapi/router";
import { orchestratorRouter } from "../modules/orchestrator/router";
import { organizationsRouter } from "../modules/organizations/router";
import { paymentsRouter } from "../modules/payments/router";
import { pipelineRouter } from "../modules/pipeline/router";
import { projectsRouter } from "../modules/projects/router";
import { promptsRouter } from "../modules/prompts/router";
import { ragProvidersRouter } from "../modules/rag-providers/router";
import { reportsRouter } from "../modules/reports/router";
import { runtimeRouter } from "../modules/runtime/router";
import { sandboxRouter } from "../modules/sandbox/router";
import { searchProvidersRouter } from "../modules/search-providers/router";
import { skillsRouter } from "../modules/skills/router";
import { subscriptionsRouter } from "../modules/subscriptions/router";
import { systemHealthRouter } from "../modules/system-health/router";
import { userActivityRouter } from "../modules/user-activity/router";
import { usersRouter } from "../modules/users/router";
import { waitlistRouter } from "../modules/waitlist/router";
import { weaveRouter } from "../modules/weave/router";
import { wizardRouter } from "../modules/wizard/router";
import { workflowsRouter } from "../modules/workflows/router";
import { workspaceRouter } from "../modules/workspace/router";
import { documentWorkspacesRouter } from "../modules/workspaces/router";
import { publicProcedure } from "./procedures";

export const router = publicProcedure
	// Prefix for openapi
	.prefix("/api")
	.router({
		admin: adminRouter,
		agentDeployments: agentDeploymentsRouter,
		agentMemory: agentMemoryRouter,
		agents: agentsRouter,
		agentTemplates: agentTemplatesRouter,
		ai: aiRouter,
		aiConfig: aiConfigRouter,
		auth: authRouter,
		artifacts: artifactsRouter,
		audit: auditRouter,
		userActivity: userActivityRouter,
		automationTemplates: automationTemplatesRouter,
		atlas: atlasRouter,
		codingRuns: codingRunsRouter,
		dailyBrief: dailyBriefRouter,
		dashboard: dashboardRouter,
		frames: framesRouter,
		functionTags: functionTagsRouter,
		github: githubRouter,
		incidents: incidentsRouter,
		integrationHealth: integrationHealthRouter,
		integrations: integrationsRouter,
		jobs: jobsRouter,
		kanban: kanbanRouter,
		mcp: mcpRouter,
		newsletter: newsletterRouter,
		notifications: notificationsRouter,
		openapi: openapiRouter,
		orchestrator: orchestratorRouter,
		organizations: organizationsRouter,
		payments: paymentsRouter,
		pipeline: pipelineRouter,
		projects: projectsRouter,
		prompts: promptsRouter,
		ragProviders: ragProvidersRouter,
		runtime: runtimeRouter,
		sandbox: sandboxRouter,
		searchProviders: searchProvidersRouter,
		users: usersRouter,
		wizard: wizardRouter,
		workflows: workflowsRouter,
		workspace: workspaceRouter,
		documentWorkspaces: documentWorkspacesRouter,
		reports: reportsRouter,
		waitlist: waitlistRouter,
		dataConnections: dataConnectionsRouter,
		skills: skillsRouter,
		subscriptions: subscriptionsRouter,
		systemHealth: systemHealthRouter,
		weave: weaveRouter,
	});

export type ApiRouterClient = RouterClient<typeof router>;
