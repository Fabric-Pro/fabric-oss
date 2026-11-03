import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { historyFromJSON } from "@temporalio/common/lib/proto-utils";
import { bundleWorkflowCode, Worker } from "@temporalio/worker";
import { beforeAll, describe, expect, it } from "vitest";
import { buildWorkflowBundleOptions } from "../src/lib/workflow-bundle-options";

const directory = resolve(
	import.meta.dirname,
	"__fixtures__/saved-agent-step-histories",
);
let bundle: Awaited<ReturnType<typeof bundleWorkflowCode>>;
beforeAll(async () => {
	bundle = await bundleWorkflowCode(
		buildWorkflowBundleOptions(
			resolve(
				import.meta.dirname,
				"../src/workflows/saved-agent-durable-turn.ts",
			),
		),
	);
}, 60000);
describe("saved-agent model/effect step recorded restart histories", () => {
	// Genuine SDK histories from loopback Temporal. Own worker processes were
	// SIGKILLed, while an owned HTTP receiver counted a single external write.
	// Model activities used synthetic decisions; no model/provider/DB is needed
	// for replay. Parent saved-agent histories are qualified separately.
	it.each(["resume", "lost-ack"])(
		"replays %s without re-executing acknowledged decisions/effects",
		async (name) => {
			const manifest = JSON.parse(
				await readFile(resolve(directory, "manifest.json"), "utf8"),
			);
			const entry = manifest[name];
			const serialized = await readFile(
				resolve(directory, name + ".json"),
				"utf8",
			);
			expect(createHash("sha256").update(serialized).digest("hex")).toBe(
				entry.sha256,
			);
			const history = historyFromJSON(JSON.parse(serialized));
			expect(history.events).toHaveLength(entry.eventCount);
			expect(entry.oneExternalHttpEffect).toBe(true);
			expect(entry.oneToolActivityAttempt).toBe(true);
			const scheduled = (history.events ?? []).flatMap((event) =>
				event.activityTaskScheduledEventAttributes
					? [event.activityTaskScheduledEventAttributes]
					: [],
			);
			expect(
				scheduled.filter(
					(event) =>
						event.activityType?.name ===
						"executeSavedAgentToolStep",
				),
			).toHaveLength(1);
			expect(
				scheduled.find(
					(event) =>
						event.activityType?.name ===
						"executeSavedAgentToolStep",
				)?.retryPolicy?.maximumAttempts,
			).toBe(1);
			expect(
				scheduled.filter(
					(event) =>
						event.activityType?.name ===
						"executeSavedAgentModelStep",
				),
			).toHaveLength(name === "resume" ? 2 : 1);
			if (name === "lost-ack")
				expect(
					history.events?.some(
						(event) => event.activityTaskTimedOutEventAttributes,
					),
				).toBe(true);
			// Temporal coalesces an intermediate Activity timeout/retry; the resumed
			// model Activity records attempt2, while its acknowledged predecessor stays1.
			else
				expect(
					history.events?.some(
						(event) =>
							event.activityTaskStartedEventAttributes
								?.attempt === 2,
					),
				).toBe(true);
			expect(
				history.events?.at(-1)
					?.workflowExecutionCompletedEventAttributes,
			).toBeDefined();
			await expect(
				Worker.runReplayHistory(
					{ workflowBundle: bundle },
					history,
					entry.workflowId,
				),
			).resolves.toBeUndefined();
		},
		30000,
	);
});
