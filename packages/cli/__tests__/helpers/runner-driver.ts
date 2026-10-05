/**
 * Runs one command through the real agent runner and lets the process end on
 * its own, for the test of whether the runner leaves a process that cannot.
 * Run by `agent-run.test.ts` with `node --import tsx`, on a `PATH` that has a
 * stand-in `codex` first. It does not call `process.exit`: that is the point.
 */
import { createAgentRunner } from "../../src/lib/instructions/agent-run.js";

async function main(): Promise<void> {
	const run = createAgentRunner({
		lookup: { env: process.env, platform: process.platform },
	});
	const result = await run("codex", ["mcp", "login", "fabric-pleone"], {
		cwd: process.cwd(),
		timeoutMs: 3000,
	});
	process.stdout.write(`${JSON.stringify(result)}\n`);
}

main().catch((error: unknown) => {
	process.stderr.write(`${String(error)}\n`);
	process.exitCode = 1;
});
