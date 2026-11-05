/**
 * Which sections of a report template carry a heading of their own. The renderer
 * prints that heading and the model is asked to structure its answer by it. Pure,
 * so the worker and the sample prompt share one answer.
 */

type ReportSectionShape = {
	id?: unknown;
	title?: unknown;
	type?: unknown;
	config?: unknown;
};

const FIXED_SECTION_IDS: ReadonlySet<unknown> = new Set(["header", "footer"]);

/** The seeded header and footer: fixed text the renderer prints as it stands. */
export function isFixedReportSection(section: ReportSectionShape): boolean {
	return section.type === "text" && FIXED_SECTION_IDS.has(section.id);
}

/** A wrapper of `{{content}}` alone says the model's answer stands on its own. */
function printsContentAlone({ config }: ReportSectionShape): boolean {
	return (
		typeof config === "object" &&
		config !== null &&
		"wrapperTemplate" in config &&
		config.wrapperTemplate === "{{content}}"
	);
}

export function sectionHasHeading(section: ReportSectionShape): boolean {
	return (
		Boolean(section.title) &&
		!isFixedReportSection(section) &&
		!printsContentAlone(section)
	);
}
