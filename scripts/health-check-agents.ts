#!/usr/bin/env tsx
/**
 * Agent Health Check Script
 *
 * Comprehensive health check for all deployed agents.
 * Verifies:
 * - Health endpoint responds with 200
 * - Response contains expected fields (status, agent/service name)
 * - No module resolution errors (validates tsup bundling worked)
 *
 * Usage:
 *   pnpm tsx scripts/health-check-agents.ts [--env local|staging|production]
 *
 * Environment variables:
 *   AGENT_BASE_URL - Override base URL for all agents (e.g., http://localhost)
 */

interface AgentConfig {
	name: string;
	port: number;
	healthPath: string;
	expectedFields: string[];
	description: string;
}

interface HealthCheckResult {
	agent: string;
	healthy: boolean;
	responseTime: number;
	status?: number;
	response?: Record<string, unknown>;
	error?: string;
}

// Agent configurations with their ports and expected health response fields
const AGENTS: AgentConfig[] = [
	{
		name: "document-generator",
		port: 8124,
		healthPath: "/health",
		expectedFields: ["status", "agent"],
		description: "Document Generator Agent (AG-UI + A2A)",
	},
	{
		name: "project-document-generator",
		port: 8125,
		healthPath: "/health",
		expectedFields: ["status", "agent"],
		description: "Project Document Generator Agent (AG-UI + A2A)",
	},
	{
		name: "task-planner",
		port: 8126,
		healthPath: "/health",
		expectedFields: ["status", "agent"],
		description: "Task Planner Agent (AG-UI + A2A)",
	},
	{
		name: "story-breakdown",
		port: 8127,
		healthPath: "/health",
		expectedFields: ["status", "agent"],
		description: "Story Breakdown Agent (AG-UI + A2A)",
	},
	{
		name: "api-agent",
		port: 8131,
		healthPath: "/health",
		expectedFields: ["status", "agent"],
		description: "API Agent (AG-UI + A2A)",
	},
	{
		name: "prompt-enhancer",
		port: 8134,
		healthPath: "/health",
		expectedFields: ["status", "agent"],
		description: "Prompt Enhancer Agent (AG-UI + A2A)",
	},
	{
		name: "custom-agent-runtime",
		port: 8240,
		healthPath: "/health",
		expectedFields: ["status", "service"],
		description: "Custom Agent Runtime (Multi-tenant A2A)",
	},
	{
		name: "cuga-ag-ui-wrapper",
		port: 9999,
		healthPath: "/health",
		expectedFields: ["status"],
		description: "CUGA AG-UI Wrapper (Protocol Translation)",
	},
	{
		name: "cuga-backend",
		port: 7860,
		healthPath: "/",
		expectedFields: [],
		description: "CUGA Python Backend",
	},
];

async function checkHealth(
	agent: AgentConfig,
	baseUrl: string,
): Promise<HealthCheckResult> {
	const url = `${baseUrl}:${agent.port}${agent.healthPath}`;
	const startTime = Date.now();

	try {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), 10000);

		const response = await fetch(url, {
			method: "GET",
			signal: controller.signal,
			headers: { Accept: "application/json" },
		});

		clearTimeout(timeout);
		const responseTime = Date.now() - startTime;

		if (!response.ok) {
			return {
				agent: agent.name,
				healthy: false,
				responseTime,
				status: response.status,
				error: `HTTP ${response.status}: ${response.statusText}`,
			};
		}

		// For agents that don't return JSON (like cuga-backend serving HTML)
		// just check that we got a 200 response
		if (agent.expectedFields.length === 0) {
			return {
				agent: agent.name,
				healthy: true,
				responseTime,
				status: response.status,
			};
		}

		// Try to parse as JSON
		let data: Record<string, unknown>;
		try {
			data = (await response.json()) as Record<string, unknown>;
		} catch {
			return {
				agent: agent.name,
				healthy: false,
				responseTime,
				status: response.status,
				error: "Response is not valid JSON",
			};
		}

		// Check for expected fields
		const missingFields = agent.expectedFields.filter(
			(field) => !(field in data),
		);
		if (missingFields.length > 0) {
			return {
				agent: agent.name,
				healthy: false,
				responseTime,
				status: response.status,
				response: data,
				error: `Missing expected fields: ${missingFields.join(", ")}`,
			};
		}

		// Check for module resolution errors in response
		const responseStr = JSON.stringify(data);
		if (
			responseStr.includes("ERR_MODULE_NOT_FOUND") ||
			responseStr.includes("Cannot find module") ||
			responseStr.includes("@repo/")
		) {
			return {
				agent: agent.name,
				healthy: false,
				responseTime,
				status: response.status,
				response: data,
				error: "Module resolution error - tsup bundling may have failed",
			};
		}

		return {
			agent: agent.name,
			healthy: true,
			responseTime,
			status: response.status,
			response: data,
		};
	} catch (err) {
		return {
			agent: agent.name,
			healthy: false,
			responseTime: Date.now() - startTime,
			error: err instanceof Error ? err.message : "Unknown error",
		};
	}
}

function formatResult(result: HealthCheckResult): string {
	const icon = result.healthy ? "✅" : "❌";
	const time = `${result.responseTime}ms`;
	const status = result.status ? `HTTP ${result.status}` : "N/A";

	let output = `${icon} ${result.agent.padEnd(28)} ${status.padEnd(10)} ${time.padStart(8)}`;

	if (result.error) {
		output += `\n   └─ Error: ${result.error}`;
	}

	return output;
}

async function main() {
	const args = process.argv.slice(2);
	const envIndex = args.indexOf("--env");
	const env = envIndex !== -1 ? args[envIndex + 1] : "local";

	// Determine base URL based on environment.
	// Hostnames are NOT hardcoded — staging/production callers must set
	// STAGING_URL / PRODUCTION_URL explicitly so the script is portable across
	// deployments.
	let baseUrl: string;
	switch (env) {
		case "staging":
			baseUrl = process.env.STAGING_URL ?? "";
			if (!baseUrl) {
				console.error(
					"--env staging requires STAGING_URL to be set (no default).",
				);
				process.exit(1);
			}
			break;
		case "production":
			baseUrl = process.env.PRODUCTION_URL ?? "";
			if (!baseUrl) {
				console.error(
					"--env production requires PRODUCTION_URL to be set (no default).",
				);
				process.exit(1);
			}
			break;
		default:
			baseUrl = process.env.AGENT_BASE_URL || "http://localhost";
	}

	console.log("\n🏥 Agent Health Check");
	console.log("═".repeat(60));
	console.log(`Environment: ${env}`);
	console.log(`Base URL: ${baseUrl}`);
	console.log(`Checking ${AGENTS.length} agents...\n`);
	console.log(`${"Agent".padEnd(28)}${"Status".padEnd(10)}Response Time`);
	console.log("-".repeat(60));

	const results: HealthCheckResult[] = [];

	for (const agent of AGENTS) {
		const result = await checkHealth(agent, baseUrl);
		results.push(result);
		console.log(formatResult(result));
	}

	// Summary
	const healthy = results.filter((r) => r.healthy).length;
	const unhealthy = results.filter((r) => !r.healthy).length;

	console.log(`\n${"═".repeat(60)}`);
	console.log("Summary:");
	console.log(`  ✅ Healthy: ${healthy}/${results.length}`);
	console.log(`  ❌ Unhealthy: ${unhealthy}/${results.length}`);

	if (unhealthy > 0) {
		console.log("\n⚠️  Unhealthy agents:");
		for (const result of results.filter((r) => !r.healthy)) {
			console.log(`  - ${result.agent}: ${result.error}`);
		}
	}

	// Exit with error code if any agent is unhealthy
	if (unhealthy > 0) {
		console.log("\n❌ Health check FAILED");
		process.exit(1);
	}

	console.log("\n✅ All agents healthy!");
	process.exit(0);
}

main().catch((error) => {
	console.error("Fatal error:", error);
	process.exit(1);
});
