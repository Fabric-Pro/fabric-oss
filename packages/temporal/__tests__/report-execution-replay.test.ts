import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { historyFromJSON } from "@temporalio/common/lib/proto-utils";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildWorkflowBundleOptions } from "../src/lib/workflow-bundle-options";

const fixtureDirectory = resolve(
	import.meta.dirname,
	"__fixtures__/report-execution-histories",
);
const manifestEntrySchema = z.object({
	workflowId: z.string().startsWith("example-report-replay-"),
	eventCount: z.number().int().positive(),
	sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
let workflowBundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
let manifest: Record<string, z.infer<typeof manifestEntrySchema>>;

beforeAll(async () => {
	manifest = z
		.record(z.string(), manifestEntrySchema)
		.parse(
			JSON.parse(
				await readFile(
					resolve(fixtureDirectory, "manifest.json"),
					"utf8",
				),
			),
		);
	workflowBundle = await bundleWorkflowCode(
		buildWorkflowBundleOptions(
			resolve(
				import.meta.dirname,
				"../src/workflows/template-instance-execution.ts",
			),
		),
	);
}, 60_000);

describe("report execution saved-history compatibility", () => {
	// Recorded with the SDK on a loopback Temporal service. Activities used only
	// synthetic data; replay uses no service, database, provider, or credentials.
	it.each(["legacy", "protocol1", "refusal"])(
		"replays the genuine synthetic %s history with current workflow code",
		async (name) => {
			const entry = manifest[name];
			expect(entry).toBeDefined();
			const serialized = await readFile(
				resolve(fixtureDirectory, `${name}.json`),
				"utf8",
			);
			expect(createHash("sha256").update(serialized).digest("hex")).toBe(
				entry.sha256,
			);
			const history = historyFromJSON(JSON.parse(serialized));
			expect(history.events).toHaveLength(entry.eventCount);
			const activities = (history.events ?? []).flatMap(
				(event) =>
					event.activityTaskScheduledEventAttributes?.activityType
						?.name ?? [],
			);
			if (name === "legacy") {
				expect(activities).toContain("fetchReportTemplateSkills");
			} else {
				expect(activities).not.toContain("fetchReportTemplateSkills");
			}
			if (name === "refusal") {
				expect(activities).not.toContain("storeInstanceArtifact");
				expect(
					history.events?.at(-1)
						?.workflowExecutionFailedEventAttributes,
				).toBeDefined();
			} else {
				expect(activities).toContain("storeInstanceArtifact");
				expect(
					history.events?.at(-1)
						?.workflowExecutionCompletedEventAttributes,
				).toBeDefined();
			}
			await expect(
				Worker.runReplayHistory(
					{ workflowBundle },
					history,
					entry.workflowId,
				),
			).resolves.toBeUndefined();
		},
		30_000,
	);
});
