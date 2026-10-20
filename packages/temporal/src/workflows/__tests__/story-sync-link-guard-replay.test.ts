/** Offline synthetic histories: legacy, refused and active links; no server I/O. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	bundleWorkflowCode,
	Worker,
	type WorkflowBundleWithSourceMap,
} from "@temporalio/worker";
import { beforeAll, describe, expect, it } from "vitest";

const resolveImport = createRequire(import.meta.url).resolve;
const sourcePath = resolve(__dirname, "../story-sync-workflow.ts");
const patch = "bulk-sync-link-guard-v1";
let current: WorkflowBundleWithSourceMap;
let bypass: WorkflowBundleWithSourceMap;

beforeAll(async () => {
	current = await bundleWorkflowCode({ workflowsPath: sourcePath });
	// Keep a killed run's temporary source outside the repository. Only bypass
	// the new marker; replay must reject the pre-guard command sequence.
	const dir = mkdtempSync(join(tmpdir(), "fabric-story-replay-"));
	try {
		const source = readFileSync(sourcePath, "utf8")
			.replace(`patched("${patch}")`, "true")
			.replace(/from "([^"]+)"/g, (_match, specifier: string) => {
				const target = specifier.startsWith(".")
					? resolve(dirname(sourcePath), specifier)
					: resolveImport(specifier);
				return `from "${target.replaceAll("\\", "/")}"`;
			});
		expect(source).not.toContain(`patched("${patch}")`);
		const path = join(dir, "workflow.ts");
		writeFileSync(path, source);
		bypass = await bundleWorkflowCode({
			workflowsPath: path,
			// The SDK's generated entrypoint has bare imports too. Resolve them
			// from this package when its entrypoint lives under the OS temp dir.
			webpackConfigHook: (config) => {
				config.resolve = {
					...config.resolve,
					modules: [
						...(config.resolve?.modules ?? []),
						resolve(__dirname, "../../../node_modules"),
					],
				};
				return config;
			},
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}, 120_000);

function payload(value: unknown) {
	return {
		payloads: [
			{
				metadata: {
					encoding: Buffer.from("json/plain").toString("base64"),
				},
				data: Buffer.from(JSON.stringify(value)).toString("base64"),
			},
		],
	};
}

/** Standard Temporal history events with synthetic inputs and recorded results. */
function history(mode: "legacy" | "legacy-refused" | "refused" | "active") {
	const events: Record<string, unknown>[] = [];
	const queue = {
		name: "synthetic-story-sync",
		kind: "TASK_QUEUE_KIND_NORMAL",
	};
	const add = (kind: string, attributes: Record<string, unknown>) => {
		const [first, ...rest] = kind.toLowerCase().split("_");
		const key = `${first}${rest.map((part) => part[0].toUpperCase() + part.slice(1)).join("")}EventAttributes`;
		const id = String(events.length + 1);
		events.push({
			eventId: id,
			eventTime: "2026-01-01T00:00:00Z",
			eventType: `EVENT_TYPE_${kind}`,
			taskId: id,
			[key]: attributes,
		});
		return id;
	};
	const task = () => {
		const scheduled = add("WORKFLOW_TASK_SCHEDULED", {
			taskQueue: queue,
			startToCloseTimeout: "10s",
			attempt: 1,
		});
		const started = add("WORKFLOW_TASK_STARTED", {
			scheduledEventId: scheduled,
			identity: "synthetic-worker",
			requestId: "00000000-0000-4000-8000-000000000001",
		});
		return add("WORKFLOW_TASK_COMPLETED", {
			scheduledEventId: scheduled,
			startedEventId: started,
			sdkMetadata: {
				coreUsedFlags: [1, 2, 3],
				sdkName: "temporal-typescript",
				sdkVersion: "1.23.0",
			},
		});
	};
	add("WORKFLOW_EXECUTION_STARTED", {
		workflowType: { name: "storySyncWorkflow" },
		taskQueue: queue,
		input: payload({
			projectId: "project-1",
			mcpServerId: "server-1",
			mcpConfigId: "config-1",
			containerId: "container-1",
			userId: "user-1",
			organizationId: "example-org",
			additionalContext: { account_slug: "example-org" },
			direction: "push",
			unsyncedOnly: false,
		}),
		workflowTaskTimeout: "10s",
		originalExecutionRunId: "00000000-0000-4000-8000-000000000001",
		firstExecutionRunId: "00000000-0000-4000-8000-000000000001",
		attempt: 1,
	});
	let completed = task();
	let sequence = 0;
	const marker = (id: string) => {
		add("MARKER_RECORDED", {
			markerName: "core_patch",
			details: { "patch-data": payload({ id, deprecated: false }) },
			workflowTaskCompletedEventId: completed,
		});
		add("UPSERT_WORKFLOW_SEARCH_ATTRIBUTES", {
			workflowTaskCompletedEventId: completed,
			searchAttributes: {
				indexedFields: {
					TemporalChangeVersion: payload([`${id}-1`]).payloads[0],
				},
			},
		});
	};
	const activity = (name: string, result: unknown, patchId?: string) => {
		if (patchId) {
			marker(patchId);
		}
		const scheduled = add("ACTIVITY_TASK_SCHEDULED", {
			activityId: String(++sequence),
			activityType: { name },
			taskQueue: queue,
			startToCloseTimeout: "60s",
			heartbeatTimeout: "30s",
			workflowTaskCompletedEventId: completed,
		});
		const started = add("ACTIVITY_TASK_STARTED", {
			scheduledEventId: scheduled,
			identity: "synthetic-worker",
			requestId: "00000000-0000-4000-8000-000000000002",
			attempt: 1,
		});
		add("ACTIVITY_TASK_COMPLETED", {
			scheduledEventId: scheduled,
			startedEventId: started,
			result: payload(result),
		});
		completed = task();
	};
	activity("discoverPMToolCapabilities", {
		hasPMCapabilities: true,
		detectedType: "azure-devops",
		taskUpdate: {
			toolName: "update_case",
			idParam: "id",
			titleParam: "title",
			descriptionParam: "description",
			allParams: [],
		},
	});
	activity("getStoriesToSync", [
		{
			id: "story-1",
			identifier: "F-1",
			title: "Login works",
			description: null,
			externalId: "42",
			externalUrl:
				mode === "legacy-refused"
					? "https://linear.app/example-org/issue/42"
					: "https://pm.example.com/cards/42",
			...(mode === "active" || mode === "refused"
				? {
						externalMcpServerId:
							mode === "active" ? "server-1" : "server-old",
						externalPmTarget:
							mode === "active"
								? "example-active-target"
								: "example-other-target",
					}
				: {}),
		},
	]);
	if (mode === "refused" || mode === "active") {
		activity(
			"checkStoryPmLink",
			mode === "refused"
				? {
						success: false,
						outcome: "block",
						error: "Use Unlink & re-create.",
					}
				: { success: true, outcome: "link-ok" },
			patch,
		);
	}
	if (mode === "legacy-refused") {
		activity(
			"createStoryInPmWithClaim",
			{
				success: false,
				outcome: "legacy-other-tool",
				error: "Use Unlink & re-create.",
			},
			"bulk-sync-create-claim-v1",
		);
	} else if (mode !== "refused") {
		activity(
			"detectAndStampPmPushConflict",
			{ hasConflict: false },
			"bulk-sync-conflict-detection-v2",
		);
		activity("executeMcpTool", { success: true, output: {} });
	}
	activity("closeStorySyncJob", null, "story-sync-job-row-v1");

	add("WORKFLOW_EXECUTION_COMPLETED", {
		workflowTaskCompletedEventId: completed,
		result: payload({
			success: !(mode === "refused" || mode === "legacy-refused"),
			totalStories: 1,
			syncedCount:
				mode === "refused" || mode === "legacy-refused" ? 0 : 1,
			failedCount:
				mode === "refused" || mode === "legacy-refused" ? 1 : 0,
		}),
	});
	return { events };
}

describe("bulk story link guard replay", () => {
	it.each(["legacy", "legacy-refused", "refused", "active"] as const)(
		"replays the %s command sequence",
		async (mode) => {
			await Worker.runReplayHistory(
				{ workflowBundle: current },
				history(mode),
			);
		},
		120_000,
	);

	it("rejects the pre-guard history if the new patch marker is bypassed", async () => {
		await expect(
			Worker.runReplayHistory(
				{ workflowBundle: bypass },
				history("legacy"),
			),
		).rejects.toThrow(/nondeterminism/i);
	}, 120_000);
});
