import { describe, expect, it } from "vitest";
import { ownerScopedTemplateSchedule } from "./owner-scoped-schedule";

const sched = { frequency: "weekly" };

describe("ownerScopedTemplateSchedule", () => {
	it("inherits a USER-scope template only when the instance owner matches", () => {
		expect(
			ownerScopedTemplateSchedule(
				{
					scope: "USER",
					userId: "u1",
					organizationId: null,
					schedule: sched,
				},
				"u1",
				null,
			),
		).toBe(sched);
		expect(
			ownerScopedTemplateSchedule(
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
	it("inherits an ORGANIZATION-scope template only when org ids match (and are non-null)", () => {
		expect(
			ownerScopedTemplateSchedule(
				{
					scope: "ORGANIZATION",
					userId: null,
					organizationId: "o9",
					schedule: sched,
				},
				"u1",
				"o9",
			),
		).toBe(sched);
		expect(
			ownerScopedTemplateSchedule(
				{
					scope: "ORGANIZATION",
					userId: null,
					organizationId: "o9",
					schedule: sched,
				},
				"u1",
				"oX",
			),
		).toBeUndefined();
		expect(
			ownerScopedTemplateSchedule(
				{
					scope: "ORGANIZATION",
					userId: null,
					organizationId: null,
					schedule: sched,
				},
				"u1",
				null,
			),
		).toBeUndefined();
	});
	it("never inherits a SYSTEM/other scope", () => {
		expect(
			ownerScopedTemplateSchedule(
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
			ownerScopedTemplateSchedule(
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
