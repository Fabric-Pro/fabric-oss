/**
 * `startContextEmbeddingWorkflow` — the start the synced-file upsert and the
 * Living Memory repository sync share (design 2026-09-23 §5.3.1 step 9). The
 * API's own tests (`upsert-synced-file.test.ts`) pin the same start through
 * the upsert, unchanged by the extraction.
 *
 * Run with: pnpm --filter @repo/temporal exec vitest run __tests__/context-embedding-start.test.ts
 */
import type { Client } from "@temporalio/client";
import { describe, expect, it, vi } from "vitest";
import { startContextEmbeddingWorkflow } from "../src/lib/context-embedding-start";

const TARGET = {
	contextId: "ctx-1",
	projectId: "proj-1",
	userId: "user-1",
	organizationId: "org-host",
	sourcePath: "docs/architecture.md",
	title: "architecture.md",
	reembed: true,
};

function fakeClient(
	start = vi.fn(async (_type: string, _options: unknown) => undefined),
) {
	return {
		client: { workflow: { start } } as unknown as Pick<Client, "workflow">,
		start,
	};
}

describe("startContextEmbeddingWorkflow", () => {
	it("starts contextEmbeddingWorkflow on project-documents under a fresh id, with the path as filename and no body", async () => {
		const { client, start } = fakeClient();

		const result = await startContextEmbeddingWorkflow(client, TARGET, {
			now: () => 1_758_000_000_000,
		});

		expect(result).toEqual({
			workflowId: "context-embedding-ctx-1-1758000000000",
		});
		expect(start).toHaveBeenCalledWith("contextEmbeddingWorkflow", {
			taskQueue: "project-documents",
			workflowId: "context-embedding-ctx-1-1758000000000",
			args: [
				{
					contextId: "ctx-1",
					projectId: "proj-1",
					userId: "user-1",
					organizationId: "org-host",
					type: "TEXT",
					metadata: {
						filename: "docs/architecture.md",
						sourceTitle: "architecture.md",
						sourcePath: "docs/architecture.md",
					},
					reembed: true,
				},
			],
		});
	});

	it("leaves reembed out when the caller does not ask for the guarded pass", async () => {
		const { client, start } = fakeClient();

		await startContextEmbeddingWorkflow(client, {
			...TARGET,
			reembed: false,
		});

		const options = start.mock.calls[0]?.[1] as {
			workflowId: string;
			args: Record<string, unknown>[];
		};
		expect(options.args[0]).not.toHaveProperty("reembed");
		expect(options.workflowId).toMatch(/^context-embedding-ctx-1-\d+$/);
	});

	describe("dedupe (the Living Memory sync's index step)", () => {
		it("starts under one id per context, joining a pass still open and allowing a new one once it has closed", async () => {
			const { client, start } = fakeClient();

			const result = await startContextEmbeddingWorkflow(client, TARGET, {
				dedupe: true,
				now: () => 1_758_000_000_000,
			});

			expect(result).toEqual({ workflowId: "context-embedding-ctx-1" });
			expect(start).toHaveBeenCalledWith(
				"contextEmbeddingWorkflow",
				expect.objectContaining({
					workflowId: "context-embedding-ctx-1",
					workflowIdConflictPolicy: "USE_EXISTING",
					workflowIdReusePolicy: "ALLOW_DUPLICATE",
				}),
			);
		});

		it("gives two contexts two ids, so one row never joins another's pass", async () => {
			const { client } = fakeClient();

			const first = await startContextEmbeddingWorkflow(client, TARGET, {
				dedupe: true,
			});
			const second = await startContextEmbeddingWorkflow(
				client,
				{ ...TARGET, contextId: "ctx-2" },
				{ dedupe: true },
			);

			expect(first.workflowId).not.toBe(second.workflowId);
		});

		it("is ignored for an unguarded first embed, which reads the body once and could be left on a stale one", async () => {
			const { client, start } = fakeClient();

			const result = await startContextEmbeddingWorkflow(
				client,
				{ ...TARGET, reembed: false },
				{ dedupe: true, now: () => 1_758_000_000_000 },
			);

			expect(result.workflowId).toBe(
				"context-embedding-ctx-1-1758000000000",
			);
			expect(start.mock.calls[0]?.[1]).not.toHaveProperty(
				"workflowIdConflictPolicy",
			);
		});

		it("is off by default, so the synced-file upsert still starts a new execution every time", async () => {
			const { client, start } = fakeClient();

			await startContextEmbeddingWorkflow(client, TARGET, {
				now: () => 1_758_000_000_000,
			});

			expect(start.mock.calls[0]?.[1]).not.toHaveProperty(
				"workflowIdConflictPolicy",
			);
			expect(start.mock.calls[0]?.[1]).toMatchObject({
				workflowId: "context-embedding-ctx-1-1758000000000",
			});
		});
	});

	it("applies the caller's decoration last (the API's correlation memo)", async () => {
		const { client, start } = fakeClient();

		await startContextEmbeddingWorkflow(client, TARGET, {
			decorateStartOptions: (options) => ({
				...options,
				memo: { correlationId: "corr-1" },
			}),
		});

		expect(start.mock.calls[0]?.[1]).toMatchObject({
			taskQueue: "project-documents",
			memo: { correlationId: "corr-1" },
		});
	});

	it("throws what the start throws, for the caller to decide", async () => {
		const { client } = fakeClient(
			vi.fn(async () => {
				throw new Error("connect ECONNREFUSED");
			}),
		);

		await expect(
			startContextEmbeddingWorkflow(client, TARGET),
		).rejects.toThrow("connect ECONNREFUSED");
	});
});
