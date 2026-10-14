/**
 * The background job a stretch of work belongs to (Fizzy #2770): entered by
 * a job's entry point, read by model resolution for calls that name none.
 */
import { describe, expect, it } from "vitest";
import {
	asAiJobKey,
	currentAiJobType,
	runWithAiJobType,
	runWithDefaultAiJobType,
} from "../lib/job-context";

describe("AI job context", () => {
	it("is the job the work runs inside, and nothing outside one", async () => {
		expect(currentAiJobType()).toBeUndefined();
		await expect(
			runWithAiJobType("pr-review", async () => {
				await Promise.resolve();
				return currentAiJobType();
			}),
		).resolves.toBe("pr-review");
	});

	it("gives an always-background entry point its default when no job set one", () => {
		expect(
			runWithDefaultAiJobType("external-agent", () => currentAiJobType()),
		).toBe("external-agent");
	});

	it("keeps the run's own job over an entry point's default", () => {
		expect(
			runWithAiJobType("fabric-mention", () =>
				runWithDefaultAiJobType("external-agent", () =>
					currentAiJobType(),
				),
			),
		).toBe("fabric-mention");
	});

	it("accepts only job keys this build knows", () => {
		expect(asAiJobKey("scheduled-report")).toBe("scheduled-report");
		expect(asAiJobKey("not-a-job")).toBeUndefined();
		expect(asAiJobKey(42)).toBeUndefined();
	});
});
