import {
	CATEGORY_LABEL,
	formatDateTime,
	type ProblemLogCategory,
	type ProblemLogSeverity,
	type ProblemLogStatus,
	SEVERITY_CONFIG,
	STATUS_LABEL,
} from "./constants";

export type IncidentReportRow = {
	id: string;
	title: string;
	description: string | null;
	category: ProblemLogCategory;
	severity: ProblemLogSeverity;
	status: ProblemLogStatus;
	source: string;
	occurrenceCount: number;
	firstSeenAt: string | Date;
	lastSeenAt: string | Date;
	resolvedAt: string | Date | null;
	projectName: string | null;
	affectedUser: string | null;
};

export type IncidentReportMeta = {
	projectName: string;
	generatedAt: string | Date;
	/** Human-readable filter summary, e.g. "Open · 1 Oct – 31 Oct 2026". */
	scope: string;
};

const CSV_HEADER = [
	"first_seen",
	"last_seen",
	"severity",
	"category",
	"status",
	"title",
	"description",
	"source",
	"occurrences",
	"project",
	"affected_user",
	"resolved_at",
] as const;

/** RFC 4180 field; a leading formula character is neutralized for spreadsheets. */
function csvField(value: string | number | null | undefined): string {
	if (value === null || value === undefined) {
		return "";
	}
	let str = String(value);
	if (/^[=+\-@\t\r]/.test(str)) {
		str = `'${str}`;
	}
	return /[",\r\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

const iso = (value: string | Date | null) =>
	value ? new Date(value).toISOString() : null;

export function buildIncidentReportCsv(rows: IncidentReportRow[]): string {
	const lines = rows.map((r) =>
		[
			iso(r.firstSeenAt),
			iso(r.lastSeenAt),
			SEVERITY_CONFIG[r.severity].label,
			CATEGORY_LABEL[r.category],
			STATUS_LABEL[r.status],
			r.title,
			r.description,
			r.source,
			r.occurrenceCount,
			r.projectName,
			r.affectedUser,
			iso(r.resolvedAt),
		]
			.map(csvField)
			.join(","),
	);
	return `${[CSV_HEADER.join(","), ...lines].join("\r\n")}\r\n`;
}

export function incidentReportFilename(
	projectName: string,
	generatedAt: string | Date,
	extension: "csv" | "pdf",
): string {
	const slug =
		projectName
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 60) || "project";
	const day = new Date(generatedAt).toISOString().slice(0, 10);
	return `incident-report-${slug}-${day}.${extension}`;
}

/** A plain A4 report, one block per entry. jsPDF loads on demand. */
export async function renderIncidentReportPdf(
	rows: IncidentReportRow[],
	meta: IncidentReportMeta,
): Promise<Blob> {
	const { jsPDF } = await import("jspdf");
	const doc = new jsPDF({ unit: "pt", format: "a4" });
	const margin = 48;
	const width = doc.internal.pageSize.getWidth() - margin * 2;
	const bottom = doc.internal.pageSize.getHeight() - margin;
	let y = margin;

	const write = (
		text: string,
		opts: { size?: number; bold?: boolean; gap?: number } = {},
	) => {
		const size = opts.size ?? 10;
		doc.setFont("helvetica", opts.bold ? "bold" : "normal");
		doc.setFontSize(size);
		for (const line of doc.splitTextToSize(text, width) as string[]) {
			if (y + size > bottom) {
				doc.addPage();
				y = margin;
			}
			doc.text(line, margin, y + size);
			y += size * 1.35;
		}
		y += opts.gap ?? 0;
	};

	write(`Incident report — ${meta.projectName}`, { size: 16, bold: true });
	write(`Generated ${formatDateTime(meta.generatedAt)} · ${meta.scope}`, {
		size: 9,
	});
	write(`${rows.length} ${rows.length === 1 ? "entry" : "entries"}`, {
		size: 9,
		gap: 12,
	});

	for (const r of rows) {
		write(r.title, { size: 11, bold: true });
		write(
			[
				SEVERITY_CONFIG[r.severity].label,
				CATEGORY_LABEL[r.category],
				STATUS_LABEL[r.status],
				`${r.occurrenceCount}×`,
			].join(" · "),
			{ size: 9 },
		);
		write(
			`First seen ${formatDateTime(r.firstSeenAt)} · last seen ${formatDateTime(r.lastSeenAt)}${
				r.resolvedAt
					? ` · resolved ${formatDateTime(r.resolvedAt)}`
					: ""
			}`,
			{ size: 9 },
		);
		write(
			`Source: ${r.source}${r.affectedUser ? ` · affected user: ${r.affectedUser}` : ""}`,
			{ size: 9 },
		);
		if (r.description) {
			write(r.description, { size: 9 });
		}
		y += 10;
	}
	return doc.output("blob");
}
