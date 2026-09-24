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
