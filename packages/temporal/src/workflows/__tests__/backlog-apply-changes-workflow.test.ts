import { describe, expect, it } from "vitest";
import {
	computePmSyncOutage,
	PM_SYNC_OUTAGE_THRESHOLD,
} from "../pm-sync-outage";

describe("computePmSyncOutage", () => {
	it("returns undefined when there are 0 failures", () => {
		expect(computePmSyncOutage([], "fizzy")).toBeUndefined();
	});

	it("returns undefined for 1 failure", () => {
		expect(
			computePmSyncOutage(
				[{ id: "s1", itemType: "story", errorClass: "PmAuthError" }],
				"fizzy",
			),
		).toBeUndefined();
	});

	it("returns undefined for 2 failures of the same class", () => {
		expect(
			computePmSyncOutage(
				[
					{ id: "s1", itemType: "story", errorClass: "PmAuthError" },
					{ id: "s2", itemType: "story", errorClass: "PmAuthError" },
				],
				"fizzy",
			),
		).toBeUndefined();
	});

	it("returns rollup when 3 failures share an errorClass", () => {
		const outage = computePmSyncOutage(
			[
				{ id: "s1", itemType: "story", errorClass: "PmAuthError" },
				{ id: "s2", itemType: "story", errorClass: "PmAuthError" },
				{ id: "s3", itemType: "story", errorClass: "PmAuthError" },
			],
			"fizzy",
		);
		expect(outage).toEqual({
			tool: "fizzy",
			errorClass: "PmAuthError",
			count: 3,
			items: [
				{ id: "s1", itemType: "story" },
				{ id: "s2", itemType: "story" },
				{ id: "s3", itemType: "story" },
			],
		});
	});

	it("returns rollup when more than threshold share an errorClass", () => {
		const failed = Array.from(
			{ length: PM_SYNC_OUTAGE_THRESHOLD + 2 },
			(_, i) => ({
				id: `s${i}`,
				itemType: "story" as const,
				errorClass: "PmAuthError",
			}),
		);
		const outage = computePmSyncOutage(failed, "azure-devops");
		expect(outage?.count).toBe(failed.length);
		expect(outage?.tool).toBe("azure-devops");
	});

	it("does not roll up when failures span different errorClasses below threshold", () => {
		const outage = computePmSyncOutage(
			[
				{ id: "s1", itemType: "story", errorClass: "PmAuthError" },
				{ id: "s2", itemType: "story", errorClass: "PmNotFoundError" },
				{ id: "s3", itemType: "story", errorClass: "PmCreateError" },
			],
			"fizzy",
		);
		expect(outage).toBeUndefined();
	});

	it("rolls up only the class meeting the threshold when classes are mixed", () => {
		const outage = computePmSyncOutage(
			[
				{ id: "s1", itemType: "story", errorClass: "PmAuthError" },
				{ id: "s2", itemType: "story", errorClass: "PmAuthError" },
				{ id: "s3", itemType: "story", errorClass: "PmAuthError" },
				{ id: "s4", itemType: "story", errorClass: "PmNotFoundError" },
			],
			"fizzy",
		);
		expect(outage?.errorClass).toBe("PmAuthError");
		expect(outage?.items).toEqual([
			{ id: "s1", itemType: "story" },
			{ id: "s2", itemType: "story" },
			{ id: "s3", itemType: "story" },
		]);
	});

	it("rolls up mixed item types when they share an errorClass", () => {
		const outage = computePmSyncOutage(
			[
				{ id: "s1", itemType: "story", errorClass: "PmAuthError" },
				{ id: "f1", itemType: "feature", errorClass: "PmAuthError" },
				{ id: "e1", itemType: "epic", errorClass: "PmAuthError" },
			],
			"azure-devops",
		);
		expect(outage?.count).toBe(3);
		expect(outage?.items).toEqual([
			{ id: "s1", itemType: "story" },
			{ id: "f1", itemType: "feature" },
			{ id: "e1", itemType: "epic" },
		]);
	});
});
