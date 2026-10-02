import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "tsup";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const packageDir = fileURLToPath(new URL("..", import.meta.url));
let outDir: string;

beforeAll(async () => {
	const distDir = path.join(packageDir, "dist");
	await mkdir(distDir, { recursive: true });
	outDir = mkdtempSync(path.join(distDir, "smoke-"));
	// Exercise the production entry and config, including bundled workspace dependencies.
	await build({
		config: path.join(packageDir, "tsup.config.ts"),
		entry: [path.join(packageDir, "unified-server.ts")],
		outDir,
		sourcemap: false,
		clean: false,
		silent: true,
	});
}, 120_000);

afterAll(() => {
	if (outDir) rmSync(outDir, { recursive: true, force: true });
});

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Expected a local TCP address");
	}
	await new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
	return address.port;
}

async function terminate(child: ChildProcess) {
	if (!child.pid || child.exitCode !== null || child.signalCode !== null)
		return;
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
		child.once("exit", () => {
			clearTimeout(timer);
			resolve();
		});
		child.kill("SIGTERM");
	});
}

describe("production bundle", () => {
	it("starts with the Docker command and serves health", async () => {
		const port = await unusedPort();
		const child = spawn(
			process.execPath,
			[path.join(outDir, "unified-server.js")],
			{
				cwd: packageDir,
				// No inherited credentials or service endpoints. Only health is requested.
				env: {
					NODE_ENV: "production",
					HOST: "127.0.0.1",
					PORT: String(port),
					AGENT_API_KEY: "synthetic-smoke-test-key",
					OTEL_ENABLED: "false",
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let output = "";
		let spawnError: Error | undefined;
		child.stdout?.on(
			"data",
			(chunk: Buffer) => (output += chunk.toString()),
		);
		child.stderr?.on(
			"data",
			(chunk: Buffer) => (output += chunk.toString()),
		);
		child.once("error", (error) => {
			spawnError = error;
		});
		try {
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				if (spawnError) throw spawnError;
				if (child.exitCode !== null || child.signalCode !== null) {
					throw new Error(
						`Bundle exited before health was ready:\n${output}`,
					);
				}
				try {
					const response = await fetch(
						`http://127.0.0.1:${port}/health`,
						{
							headers: {
								"X-Agent-Key": "synthetic-smoke-test-key",
							},
							signal: AbortSignal.timeout(1_000),
						},
					);
					if (response.ok) {
						expect(await response.json()).toMatchObject({
							status: "healthy",
							agent: "data_analyst",
						});
						expect(output).not.toContain("Dynamic require of");
						return;
					}
				} catch (error) {
					if (
						!(error instanceof TypeError) &&
						!(error instanceof DOMException)
					) {
						throw error;
					}
				}
				await new Promise((resolve) => setTimeout(resolve, 100));
			}
			throw new Error(
				`Bundle health was not ready within 30 seconds:\n${output}`,
			);
		} finally {
			await terminate(child);
		}
	}, 45_000);
});
