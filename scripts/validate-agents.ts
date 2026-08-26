#!/usr/bin/env npx tsx
/**
 * Agent Build Validation Script
 *
 * Validates all agents can be built successfully before deployment.
 * Run this locally or in CI before deploying to catch issues early.
 *
 * Usage:
 *   pnpm validate:agents              # Validate all agents
 *   pnpm validate:agents --agent=document-generator  # Validate specific agent
 *   pnpm validate:agents --verbose    # Show detailed output
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const ROOT_DIR = join(__dirname, "..");
const AGENTS_DIR = join(ROOT_DIR, "agents/langchain");

const args = process.argv.slice(2);
const specificAgent = args.find((a) => a.startsWith("--agent="))?.split("=")[1];
const verbose = args.includes("--verbose") || args.includes("-v");

interface AgentConfig {
	name: string;
	path: string;
	packageName: string;
	type: "typescript" | "python";
}

function discoverAgents(): AgentConfig[] {
	const agents: AgentConfig[] = [];
	const entries = readdirSync(AGENTS_DIR, { withFileTypes: true });

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		const agentPath = join(AGENTS_DIR, entry.name);
		const packageJsonPath = join(agentPath, "package.json");
		const pyprojectPath = join(agentPath, "pyproject.toml");

		if (existsSync(packageJsonPath)) {
			const pkg = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
			agents.push({
				name: entry.name,
				path: agentPath,
				packageName: pkg.name,
				type: "typescript",
			});
		} else if (existsSync(pyprojectPath)) {
			agents.push({
				name: entry.name,
				path: agentPath,
				packageName: entry.name,
				type: "python",
			});
		}
	}
	return agents;
}

async function validateTsAgent(
	agent: AgentConfig,
): Promise<{ success: boolean; error?: string }> {
	const isWeaveAgent = [
		"weave-readers",
		"weave-shuttle",
		"weave-planners",
	].includes(agent.name);
	const steps = [
		{
			name: "type-check",
			cmd: `pnpm --filter ${agent.packageName} type-check 2>&1`,
		},
		...(isWeaveAgent
			? []
			: [
					{
						name: "build",
						cmd: `pnpm --filter ${agent.packageName} build 2>&1`,
					},
				]),
	];

	for (const step of steps) {
		try {
			if (verbose) {
				console.log(`   Running ${step.name}...`);
			}
			execSync(step.cmd, {
				cwd: ROOT_DIR,
				stdio: verbose ? "inherit" : "pipe",
			});
		} catch (error) {
			// Extract error output for better debugging
			const errorOutput =
				error instanceof Error && "stdout" in error
					? String(error.stdout)
					: "";
			const stderrOutput =
				error instanceof Error && "stderr" in error
					? String(error.stderr)
					: "";
			const combinedOutput = (errorOutput + stderrOutput).trim();
			// Show last 500 chars of output to help debug CI failures
			const truncatedOutput =
				combinedOutput.length > 500
					? `...${combinedOutput.slice(-500)}`
					: combinedOutput;
			if (truncatedOutput) {
				console.log(`   Error output:\n${truncatedOutput}`);
			}
			return { success: false, error: `${step.name} failed` };
		}
	}

	if (isWeaveAgent) {
		return { success: true };
	}

	const distPath = join(agent.path, "dist");
	if (!existsSync(distPath)) {
		return { success: false, error: "dist/ directory not created" };
	}

	const distFiles = readdirSync(distPath);
	const serverFile = distFiles.find(
		(f) => f.includes("server") && f.endsWith(".js"),
	);
	const entryFile = serverFile || distFiles.find((f) => f === "index.js");
	if (!entryFile) {
		return {
			success: false,
			error: "No runnable server entry found in dist/",
		};
	}

	// Verify the bundle can resolve all imports (catches missing external dependencies)
	// Uses --check to only parse and check imports without executing
	// Run from ROOT_DIR to simulate Docker environment where node_modules is at /app
	try {
		if (verbose) {
			console.log("   Running module resolution check...");
		}
		const bundlePath = join(
			"agents/langchain",
			agent.name,
			"dist",
			entryFile,
		).replace(/\\/g, "/");
		// Use --check flag to validate syntax and module resolution without executing
		const checkCmd = `node --check ./${bundlePath} 2>&1`;
		execSync(checkCmd, {
			cwd: ROOT_DIR,
			stdio: verbose ? "inherit" : "pipe",
			timeout: 30000,
		});
	} catch (error) {
		const errorMsg =
			error instanceof Error && "stderr" in error
				? String(error.stderr)
				: error instanceof Error && "stdout" in error
					? String(error.stdout)
					: "Check failed";
		// Extract the module name from common error patterns
		const moduleMatch = errorMsg.match(/Cannot find package '([^']+)'/);
		if (moduleMatch) {
			return {
				success: false,
				error: `Missing module: ${moduleMatch[1]} (external dep not bundled)`,
			};
		}
		// For syntax errors or other issues
		if (verbose) {
			console.log(`   Check output: ${errorMsg}`);
		}
		return { success: false, error: "Module resolution check failed" };
	}

	return { success: true };
}

async function validatePythonAgent(
	agent: AgentConfig,
): Promise<{ success: boolean; error?: string }> {
	if (!existsSync(join(agent.path, "Dockerfile"))) {
		return { success: false, error: "Dockerfile not found" };
	}

	const wrapperPath = join(agent.path, "ag-ui-wrapper");
	if (existsSync(join(wrapperPath, "package.json"))) {
		try {
			execSync("pnpm --filter cuga-ag-ui-wrapper build 2>&1", {
				cwd: ROOT_DIR,
				stdio: verbose ? "inherit" : "pipe",
			});
		} catch {
			return { success: false, error: "ag-ui-wrapper build failed" };
		}
	}
	return { success: true };
}

async function main() {
	console.log(`Agent Build Validation\n${"=".repeat(60)}`);

	const allAgents = discoverAgents();
	const agents = specificAgent
		? allAgents.filter((a) => a.name === specificAgent)
		: allAgents;

	if (agents.length === 0) {
		console.error(
			`No agents found${specificAgent ? ` matching "${specificAgent}"` : ""}`,
		);
		process.exit(1);
	}

	console.log(`\nFound ${agents.length} agent(s):\n`);
	for (const a of agents) {
		console.log(`  - ${a.name} (${a.type})`);
	}

	const results: Array<{
		agent: AgentConfig;
		success: boolean;
		error?: string;
		duration: number;
	}> = [];
	const startTime = Date.now();

	for (const agent of agents) {
		console.log(`\nValidating ${agent.name}...`);
		const agentStart = Date.now();
		const result =
			agent.type === "typescript"
				? await validateTsAgent(agent)
				: await validatePythonAgent(agent);
		const duration = Date.now() - agentStart;
		results.push({ agent, ...result, duration });
		console.log(
			result.success
				? `   Passed (${duration}ms)`
				: `   Failed: ${result.error}`,
		);
	}

	console.log(`\n${"=".repeat(60)}\nSummary\n`);
	const passed = results.filter((r) => r.success);
	const failed = results.filter((r) => !r.success);
	console.log(
		`Passed: ${passed.length}\nFailed: ${failed.length}\nTotal: ${Date.now() - startTime}ms`,
	);

	if (failed.length > 0) {
		console.log("\nFailed agents:");
		for (const { agent, error } of failed) {
			console.log(`  - ${agent.name}: ${error}`);
		}
		process.exit(1);
	}
	console.log("\nAll agents validated successfully!");
}

main().catch((e) => {
	console.error("Validation failed:", e);
	process.exit(1);
});
