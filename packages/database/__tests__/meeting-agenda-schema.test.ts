import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const schema = readFileSync(
	join(__dirname, "..", "prisma", "schema.prisma"),
	"utf8",
);

describe("ProjectMeetingAgenda", () => {
	it("declares the model and status enum", () => {
		expect(schema).toContain("model ProjectMeetingAgenda {");
		expect(schema).toContain("enum MeetingAgendaStatus {");
	});

	it("keys identity on (linkedMeetingId, occurrenceStart)", () => {
		// Graph event ids are PER-ATTENDEE — the same occurrence has a different
		// id in every participant's calendar, so it cannot be identity.
		expect(schema).toContain(
			"@@unique([linkedMeetingId, occurrenceStart])",
		);
	});

	it("carries both tenancy columns", () => {
		const model = schema.slice(
			schema.indexOf("model ProjectMeetingAgenda {"),
		);
		const body = model.slice(0, model.indexOf("\n}"));
		expect(body).toMatch(/userId\s+String\?/);
		expect(body).toMatch(/organizationId\s+String\?/);
		expect(body).toMatch(/version\s+Int\s+@default\(1\)/);
	});

	it("is registered as a project-scoped table for tenant filtering", () => {
		const tenantDb = readFileSync(
			join(__dirname, "..", "src", "tenant-db.ts"),
			"utf8",
		);
		expect(tenantDb).toContain('ProjectMeetingAgenda: "projectId"');
	});
});
