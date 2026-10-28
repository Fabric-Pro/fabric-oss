import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const activityDb = vi.hoisted(() => ({
	adapter: undefined as any,
	run: { id: "example-workflow-run", projectId: "example-project" },
	receipts: [] as any[],
}));
vi.mock("@repo/database", () => ({
	db: {
		codingRun: { findFirst: async () => activityDb.run },
		codingRunEvent: {
			upsert: async (value: any) => {
				activityDb.receipts.push(value);
			},
		},
	},
	canEditProject: async () => true,
	isProjectReadOnly: async () => false,
	addCodingRunEvent: vi.fn(),
	createCodingRun: vi.fn(),
	updateCodingRunStatus: vi.fn(),
}));
vi.mock("@repo/utils/project-context", () => ({
	getAmbientProjectId: () => undefined,
}));
vi.mock("../src/lib/coding-execution/get-provider", () => ({
	getCodingExecutionProvider: () => activityDb.adapter,
}));
vi.mock("../src/lib/coding-execution/local-kanban-provider", () => ({
	getLocalKanbanSessionUrl: vi.fn(),
}));
vi.mock("../src/lib/lifecycle-dispatcher", () => ({
	dispatchLifecycleEvent: vi.fn(),
}));
vi.mock("../src/activities/coding-run/spike", () => ({}));

const sourceRoot = process.env.FABRIC_AGENTS_ACCEPTANCE_SOURCE_ROOT;
// Explicit opt-in: do not pretend a missing sibling repository is qualification.
describe.skipIf(!sourceRoot)(
	"joint consumer → actual Fabric HTTP router",
	() => {
		let child: ChildProcess;
		let root: string;
		let adapter: import("../src/lib/coding-execution/background-agents-provider").FabricBackgroundAdapter;
		let errors = "";
		async function stop() {
			if (child && child.exitCode === null && child.signalCode === null) {
				await new Promise<void>((resolve) => {
					child.once("exit", () => resolve());
					child.kill("SIGTERM");
				});
			}
		}
		async function start() {
			if (!sourceRoot) {
				throw new Error(
					"An explicit Fabric Agents source root is required",
				);
			}
			child = spawn(
				process.env.FABRIC_ACCEPTANCE_BUN ?? "bun",
				[
					"--no-env-file",
					join(
						import.meta.dirname,
						"fixtures/coding-bridge-server.fixture.mts",
					),
					sourceRoot,
					root,
				],
				{
					env: {
						PATH: process.env.PATH,
						HOME: root,
						USERPROFILE: root,
						TMPDIR: root,
						FABRIC_CONFIG_DIR: join(root, "config"),
						FABRIC_SKIP_CREDENTIALS_MIGRATION: "1",
					},
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			errors = "";
			child.stderr?.on("data", (chunk) => {
				errors += chunk;
			});
			const url = await new Promise<string>((resolve, reject) => {
				const timeout = setTimeout(
					() =>
						reject(
							new Error(`Fixture startup timed out: ${errors}`),
						),
					10_000,
				);
				if (!child.stdout) {
					reject(new Error("Missing fixture stdout"));
					return;
				}
				const lines = createInterface({ input: child.stdout });
				lines.on("line", (line) => {
					try {
						const value = JSON.parse(line);
						if (value.url) {
							clearTimeout(timeout);
							lines.close();
							resolve(value.url);
						}
					} catch {
						/* Ignore startup diagnostics. */
					}
				});
				child.once("exit", () => {
					clearTimeout(timeout);
					reject(new Error(`Fixture exited: ${errors}`));
				});
			});
			vi.stubEnv("FABRIC_AGENTS_EXECUTION_BRIDGE_ENABLED", "true");
			vi.stubEnv("BACKGROUND_AGENTS_URL", url);
			vi.stubEnv(
				"BACKGROUND_AGENTS_INTERNAL_SECRET",
				"synthetic-service-secret-for-contract-tests",
			);
			vi.resetModules();
			const { FabricBackgroundAdapter } = await import(
				"../src/lib/coding-execution/background-agents-provider"
			);
			adapter = new FabricBackgroundAdapter();
			activityDb.adapter = adapter;
		}
		beforeAll(async () => {
			root = await mkdtemp(join(tmpdir(), "joint-coding-contract-"));
			await start();
		});
		afterAll(async () => {
			await stop();
			if (root) {
				await rm(root, { recursive: true, force: true });
			}
			vi.unstubAllEnvs();
		});
		const create = (codingRunId: string) =>
			adapter.createSession({
				repoOwner: "example-org",
				repoName: "example-repo",
				codingRunId,
				organizationId: "example-org",
			});
		it("authenticates with timestamp HMAC, binds one session, and returns a canonical desktop link", async () => {
			const first = await create("example-run-1");
			expect(await create("example-run-1")).toEqual(first);
			expect(first.externalUrl).toBe(
				`fabricagents://workspace/example-desktop-workspace/allSessions/session/${first.sessionId}`,
			);
		});
		it("replays a durable prompt receipt after an actual server process restart without another native send", async () => {
			const { sessionId } = await create("example-run-2");
			const first = await adapter.sendPrompt(
				sessionId,
				"work",
				"example-user",
				{ promptId: "example-prompt-1" },
			);
			await stop();
			await start();
			expect(
				await adapter.sendPrompt(sessionId, "work", "example-user", {
					promptId: "example-prompt-1",
				}),
			).toEqual(first);
			expect(
				JSON.parse(await readFile(join(root, "native.json"), "utf8"))
					.sends,
			).toBe(1);
		});
		it("fences uncertain delivery after restart and surfaces recovery instead of sending again", async () => {
			const { sessionId } = await create("example-run-3");
			await expect(
				adapter.sendPrompt(sessionId, "lose-ack", "example-user", {
					promptId: "example-prompt-2",
				}),
			).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
			await stop();
			await start();
			await expect(
				adapter.sendPrompt(sessionId, "lose-ack", "example-user", {
					promptId: "example-prompt-2",
				}),
			).rejects.toMatchObject({ code: "RECOVERY_REQUIRED" });
			expect(
				JSON.parse(await readFile(join(root, "native.json"), "utf8"))
					.sends,
			).toBe(2);
		});
		it("surfaces paused native input and refuses to treat ordinary text as approval", async () => {
			const { sessionId } = await create("example-run-4");
			await adapter.sendPrompt(sessionId, "checkpoint", "example-user", {
				promptId: "example-prompt-3",
			});
			expect((await adapter.getSessionStatus(sessionId)).status).toBe(
				"paused",
			);
			await expect(
				adapter.sendPrompt(sessionId, "yes", "example-user", {
					promptId: "example-prompt-4",
				}),
			).rejects.toMatchObject({ code: "INPUT_REQUIRED" });
		});
		it("executes the real coding workflow and delivery activities, then replays its recorded history", async () => {
			const { TestWorkflowEnvironment } = await import(
				"@temporalio/testing"
			);
			const { Worker, bundleWorkflowCode } = await import(
				"@temporalio/worker"
			);
			const activity = await import("../src/activities/coding-run");
			const env = await TestWorkflowEnvironment.createTimeSkipping();
			const statuses: string[] = [];
			const events: string[] = [];
			try {
				const workflowBundle = await bundleWorkflowCode({
					workflowsPath: resolve(
						import.meta.dirname,
						"../src/workflows/coding-run-workflow.ts",
					),
				});
				const worker = await Worker.create({
					connection: env.nativeConnection,
					taskQueue: "example-joint-acceptance",
					workflowBundle,
					activities: {
						createExecutionSession: activity.createExecutionSession,
						sendExecutionPrompt: activity.sendExecutionPrompt,
						pollExecutionStatus: activity.pollExecutionStatus,
						cancelExecutionSession: activity.cancelExecutionSession,
						updateCodingRunStatusActivity: async ({
							status,
						}: {
							status: string;
						}) => {
							statuses.push(status);
						},
						addCodingRunEventActivity: async ({
							eventType,
						}: {
							eventType: string;
						}) => {
							events.push(eventType);
						},
						buildImplementationPrompt: async () => "complete",
						syncCodingRunArtifacts: async () => ({}),
						cleanupWeaveResourcesActivity: async () => {},
					},
				});
				const workflowId = "example-joint-workflow";
				const handle = await env.client.workflow.start(
					"codingRunWorkflow",
					{
						workflowId,
						taskQueue: "example-joint-acceptance",
						args: [
							{
								codingRunId: activityDb.run.id,
								fabricAgentsBridgeEnabled: true,
								projectId: activityDb.run.projectId,
								storyId: "example-story",
								userId: "example-user",
								organizationId: "example-org",
								provider: "BACKGROUND_AGENTS",
								repositoryOwner: "example-org",
								repositoryName: "example-repo",
								targetBranch: "main",
								storyTitle: "Synthetic acceptance",
							},
						],
					},
				);
				const result = await worker.runUntil(handle.result());
				expect(result).toMatchObject({ status: "completed" });
				expect(statuses).toContain("COMPLETED");
				expect(events).toContain("workflow_completed");
				expect(activityDb.receipts).toHaveLength(1);
				expect(activityDb.receipts[0].create.providerEventId).toMatch(
					/^example-message-/,
				);
				const history = await handle.fetchHistory();
				expect(history.events?.length ?? 0).toBeGreaterThan(20);
				await Worker.runReplayHistory(
					{ workflowBundle },
					history,
					workflowId,
				);
			} finally {
				await env.teardown();
			}
		}, 120_000);
	},
);
