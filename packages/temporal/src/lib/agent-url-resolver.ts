/**
 * Agent Endpoint URL Resolution (shared)
 *
 * Resolves a stored agent deployment URL to the URL actually reachable from the
 * current runtime. Used by BOTH the orchestrator delegation path and the agent
 * health monitor so the two never disagree about an agent's address.
 *
 * Reads process.env — call only from Temporal activities / Node code, never from
 * workflow code (determinism).
 */

/** Map of agent IDs to their environment variable names for runtime URL override */
const AGENT_URL_ENV_VARS: Record<string, string> = {
	project_document_generator: "PROJECT_DOCUMENT_GENERATOR_URL",
	document_generator: "DOCUMENT_GENERATOR_URL",
	task_planner: "TASK_PLANNER_URL",
	story_breakdown: "STORY_BREAKDOWN_URL",
	api_agent: "API_AGENT_URL",
	backlog_updater: "BACKLOG_UPDATER_URL",
	data_analyst: "DATA_ANALYST_URL",
	cuga_generalist: "CUGA_AGENT_URL",
	code_executor: "CODE_EXECUTOR_URL",
	prompt_enhancer: "PROMPT_ENHANCER_URL",
	fabric_orchestrator: "FABRIC_ORCHESTRATOR_URL",
	weave_thread: "WEAVE_READERS_URL",
	weave_spindle: "WEAVE_READERS_URL",
	weave_weft: "WEAVE_READERS_URL",
	weave_warp: "WEAVE_READERS_URL",
	weave_shuttle: "WEAVE_SHUTTLE_URL",
};

/** Map of Docker container hostnames to their localhost equivalents */
const DOCKER_TO_LOCALHOST_MAP: Record<string, string> = {
	"project-document-generator": "localhost",
	"document-generator": "localhost",
	"task-planner": "localhost",
	"story-breakdown": "localhost",
	"api-agent": "localhost",
	"backlog-updater": "localhost",
	"data-analyst": "localhost",
	"cuga-wrapper": "localhost",
	"cuga-backend": "localhost",
	"prompt-enhancer": "localhost",
	"fabric-orchestrator": "localhost",
	"weave-readers": "localhost",
	"weave-shuttle": "localhost",
	"weave-planners": "localhost",
};

export function resolveAgentUrl(agentId: string, databaseUrl: string): string {
	// 1. Environment variable override takes precedence
	const envVar = AGENT_URL_ENV_VARS[agentId];
	if (envVar && process.env[envVar]) {
		return process.env[envVar] as string;
	}

	// 2. When not in Docker, convert known Docker hostnames to localhost
	const isDocker = process.env.DOCKER_CONTAINER === "true";
	if (!isDocker) {
		try {
			const url = new URL(databaseUrl);
			if (DOCKER_TO_LOCALHOST_MAP[url.hostname]) {
				url.hostname = DOCKER_TO_LOCALHOST_MAP[url.hostname];
				return url.toString().replace(/\/$/, "");
			}
		} catch {
			// fall through to raw URL on parse failure
		}
	}

	// 3. Use the database URL as-is
	return databaseUrl;
}
