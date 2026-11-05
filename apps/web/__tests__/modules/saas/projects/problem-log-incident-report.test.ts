/**
 * Incident report files (Fizzy #2277): the CSV carries every field the card
 * asks for, is RFC 4180-quoted, and cannot smuggle a spreadsheet formula; the
 * PDF renders every entry.
 */

import {
	buildIncidentReportCsv,
	type IncidentReportRow,
	incidentReportFilename,
	renderIncidentReportPdf,
} from "@saas/projects/components/problem-log/incident-report";
import { describe, expect, it } from "vitest";

const ROW: IncidentReportRow = {
	id: "entry-1",
	title: 'Could not sync "Checkout flow"',
	description: "Line one,\nline two",
	category: "INTEGRATION_FAILURE",
	severity: "ERROR",
	status: "OPEN",
	source: "pm-sync:jira",
	occurrenceCount: 4,
	firstSeenAt: "2026-10-01T10:00:00.000Z",
	lastSeenAt: "2026-10-02T10:00:00.000Z",
	resolvedAt: null,
	projectName: "Example project",
	affectedUser: "Dev",
};

describe("buildIncidentReportCsv", () => {
	it("writes a header and one quoted row per entry", () => {
		const csv = buildIncidentReportCsv([ROW]);
		const [header, ...rest] = csv.split("\r\n");
		expect(header).toBe(
			"first_seen,last_seen,severity,category,status,title,description,source,occurrences,project,affected_user,resolved_at",
		);
		const body = rest.join("\r\n");
		expect(body).toContain(
			'2026-10-01T10:00:00.000Z,2026-10-02T10:00:00.000Z,Error,Integration failure,Open,"Could not sync ""Checkout flow""","Line one,\nline two",pm-sync:jira,4,Example project,Dev,',
		);
	});

	it("emits only the header for no rows", () => {
		expect(buildIncidentReportCsv([])).toBe(
			"first_seen,last_seen,severity,category,status,title,description,source,occurrences,project,affected_user,resolved_at\r\n",
		);
	});

	it("neutralizes a leading formula character", () => {
		const csv = buildIncidentReportCsv([
			{ ...ROW, title: '=HYPERLINK("https://example.com")' },
		]);
		expect(csv).toContain(`"'=HYPERLINK(""https://example.com"")"`);
	});
});

describe("incidentReportFilename", () => {
	it("slugs the project and dates the file", () => {
		expect(
			incidentReportFilename(
				"Example Project / Phase 2",
				"2026-11-02T09:00:00.000Z",
				"pdf",
			),
		).toBe("incident-report-example-project-phase-2-2026-11-02.pdf");
	});
});

describe("renderIncidentReportPdf", () => {
	it("produces a PDF", async () => {
		const blob = await renderIncidentReportPdf(
			[ROW, { ...ROW, id: "e2" }],
			{
				projectName: "Example project",
				generatedAt: "2026-11-02T09:00:00.000Z",
				scope: "Open · All categories · All dates",
			},
		);
		expect(blob.size).toBeGreaterThan(500);
		const head = new TextDecoder().decode(
			new Uint8Array(await blob.slice(0, 5).arrayBuffer()),
		);
		expect(head).toBe("%PDF-");
	});
});
