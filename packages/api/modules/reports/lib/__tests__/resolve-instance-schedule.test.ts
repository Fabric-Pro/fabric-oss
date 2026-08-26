import { describe, expect, it } from "vitest";
import { templateScheduleForInheritance } from "../resolve-instance-schedule";

const sched = { frequency: "weekly" };

describe("templateScheduleForInheritance (owner-scoped, D3)", () => {
	it("inherits a USER template's schedule when the owner matches", () => {
		expect(
			templateScheduleForInheritance(
				{
					scope: "USER",
					userId: "u1",
					organizationId: null,
					schedule: sched,
				},
				"u1",
				null,
			),
		).toEqual(sched);
	});

	it("does NOT inherit a USER template owned by a different user", () => {
		expect(
			templateScheduleForInheritance(
				{
					scope: "USER",
					userId: "uX",
					organizationId: null,
					schedule: sched,
				},
				"u1",
				null,
			),
		).toBeUndefined();
	});

	it("inherits an ORGANIZATION template when the org matches", () => {
		expect(
			templateScheduleForInheritance(
				{
					scope: "ORGANIZATION",
					userId: null,
					organizationId: "o9",
					schedule: sched,
				},
				"u4",
				"o9",
			),
		).toEqual(sched);
	});

	it("does NOT inherit an ORGANIZATION template for a different org (or personal context)", () => {
		expect(
			templateScheduleForInheritance(
				{
					scope: "ORGANIZATION",
					userId: null,
					organizationId: "o9",
					schedule: sched,
				},
				"u4",
				"oOther",
			),
		).toBeUndefined();
		expect(
			templateScheduleForInheritance(
				{
					scope: "ORGANIZATION",
					userId: null,
					organizationId: "o9",
					schedule: sched,
				},
				"u4",
				null,
			),
		).toBeUndefined();
	});

	it("NEVER inherits a SYSTEM/public template (cross-tenant safety)", () => {
		expect(
			templateScheduleForInheritance(
				{
					scope: "SYSTEM",
					userId: null,
					organizationId: null,
					schedule: sched,
				},
				"u1",
				null,
			),
		).toBeUndefined();
	});

	it("returns undefined when the template has no schedule", () => {
		expect(
			templateScheduleForInheritance(
				{
					scope: "USER",
					userId: "u1",
					organizationId: null,
					schedule: null,
				},
				"u1",
				null,
			),
		).toBeUndefined();
	});
});
