/** Offline synthetic histories: legacy and capped PM listings; no server I/O. */
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
const patch = "pm-listing-completeness-v1";
const bundles: Record<
	string,
	{
		current: WorkflowBundleWithSourceMap;
		bypass: WorkflowBundleWithSourceMap;
	}
> = {};
const workflowTypes = ["storySyncWorkflow", "testCaseSyncWorkflow"] as const;
type WorkflowType = (typeof workflowTypes)[number];

beforeAll(async () => {
	for (const workflowType of workflowTypes) {
		const sourcePath = resolve(
			__dirname,
			workflowType === "storySyncWorkflow"
				? "../story-sync-workflow.ts"
				: "../test-case-sync-workflow.ts",
		);
		const current = await bundleWorkflowCode({ workflowsPath: sourcePath });
		const dir = mkdtempSync(join(tmpdir(), "fabric-pm-listing-replay-"));
		try {
			const source = readFileSync(sourcePath, "utf8")
				.replace(
					/patched\(\s*"pm-listing-completeness-v1",?\s*\)/,
					"true",
				)
				.replace(/from "([^"]+)"/g, (_match, specifier: string) => {
					const target = specifier.startsWith(".")
						? resolve(dirname(sourcePath), specifier)
						: resolveImport(specifier);
					return `from "${target.replaceAll("\\", "/")}"`;
				});
			expect(source).not.toMatch(
				/patched\(\s*"pm-listing-completeness-v1"/,
			);
			const path = join(dir, "workflow.ts");
			writeFileSync(path, source);
			const bypass = await bundleWorkflowCode({
				workflowsPath: path,
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
			bundles[workflowType] = { current, bypass };
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
type HistoryMode =
	| "legacy-cap"
	| "patched-cap"
	| "short"
	| "patched-short"
	| "legacy-raw-count"
	| "legacy-raw-total"
	| "patched-raw-count";
function history(mode: HistoryMode, workflowType: WorkflowType) {
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
		workflowType: { name: workflowType },
		taskQueue: queue,
		input: payload({
			projectId: "example-project",
			mcpServerId: "example-server",
			mcpConfigId: "example-config",
			containerId: "example-container",
			userId: "example-user",
			organizationId: "example-org",
			additionalContext: { account_slug: "example-org" },
			direction: "pull",
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
		detectedType: "github",
		taskList: {
			toolName: "github_list_issues",
			containerParam: "repo",
			allParams: [],
		},
	});
	if (mode.startsWith("patched-")) {
		marker(patch);
	}
	const rawCountMode = mode.endsWith("raw-count");
	const rawTotalMode = mode === "legacy-raw-total";
	const short = mode === "short" || mode === "patched-short";
	const pages = rawCountMode
		? mode === "patched-raw-count"
			? 3
			: 4
		: short || rawTotalMode
			? 2
			: 200;
	const item = { id: "example-issue", title: "Example issue" };
	for (let page = 1; page <= pages; page++) {
		const empty =
			((short || rawTotalMode) && page === 2) ||
			(mode === "legacy-raw-count" && page === 4);
		activity("listWorkItemsFromPM", {
			items: empty ? [] : [item],
			hasNextPage: !empty,
			...(rawCountMode ? { rawCount: [50, 37, 20, 0][page - 1] } : {}),
			...(rawTotalMode
				? { rawCount: page === 1 ? 50 : 0, total: 2 }
				: {}),
		});
	}
	const count = short || rawTotalMode ? 1 : rawCountMode ? 3 : 200;
	for (let index = 0; index < count; index++) {
		activity(
			workflowType === "storySyncWorkflow"
				? "createOrUpdateStoryFromPMItem"
				: "createOrUpdateTestCaseFromPMItem",
			{
				created: false,
				storyId: "example-story",
				testCaseId: "example-case",
				identifier: "EXAMPLE-1",
				externalId: item.id,
			},
		);
	}
	if (workflowType === "storySyncWorkflow") {
		if (mode !== "patched-cap") {
			activity("deleteStoriesNotInPMList", { deletedCount: 0 });
		}
		activity("closeStorySyncJob", null, "story-sync-job-row-v1");
	}

	add("WORKFLOW_EXECUTION_COMPLETED", {
		workflowTaskCompletedEventId: completed,
		result: payload({
			success: true,
			[workflowType === "storySyncWorkflow"
				? "totalStories"
				: "totalCases"]: count,
			syncedCount: count,
			failedCount: 0,
		}),
	});
	return { events };
}

describe.each(workflowTypes)("%s listing evidence replay", (workflowType) => {
	it.each([
		"legacy-cap",
		"patched-cap",
		"short",
		"patched-short",
		"legacy-raw-count",
		"legacy-raw-total",
		"patched-raw-count",
	] as const)(
		"replays the %s command sequence",
		async (mode) => {
			await Worker.runReplayHistory(
				{ workflowBundle: bundles[workflowType].current },
				history(mode, workflowType),
			);
		},
		120_000,
	);
	it.each(["legacy-raw-count", "legacy-raw-total"] as const)(
		"rejects %s when the patch is bypassed",
		async (mode) => {
			await expect(
				Worker.runReplayHistory(
					{ workflowBundle: bundles[workflowType].bypass },
					history(mode, workflowType),
				),
			).rejects.toThrow(/nondeterminism/i);
		},
		120_000,
	);
	if (workflowType === "storySyncWorkflow") {
		it("rejects the legacy cap history when the patch is bypassed", async () => {
			await expect(
				Worker.runReplayHistory(
					{ workflowBundle: bundles[workflowType].bypass },
					history("legacy-cap", workflowType),
				),
			).rejects.toThrow(/nondeterminism/i);
		}, 120_000);
	}
});
