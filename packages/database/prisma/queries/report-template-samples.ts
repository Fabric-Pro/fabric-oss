/**
 * Stored AI-written samples of what a report template produces
 * (`report_template_sample`). A row has no tenant columns: callers find the
 * template through `getReportTemplate` first, which applies the tenant rules,
 * and only then read or write its samples.
 */

import { db } from "../client";

const SAMPLE_SELECT = { content: true, generatedAt: true } as const;

/** The sample written from exactly this prompt, if one is stored. */
export async function getReportTemplateSample({
	templateId,
	contentHash,
}: {
	templateId: string;
	contentHash: string;
}) {
	return db.reportTemplateSample.findUnique({
		where: { templateId_contentHash: { templateId, contentHash } },
		select: SAMPLE_SELECT,
	});
}

/** Stores a sample; a concurrent first write for the same prompt is applied as an update. */
export async function saveReportTemplateSample({
	templateId,
	contentHash,
	content,
}: {
	templateId: string;
	contentHash: string;
	content: string;
}) {
	return db.reportTemplateSample.upsert({
		where: { templateId_contentHash: { templateId, contentHash } },
		create: { templateId, contentHash, content },
		update: { content, generatedAt: new Date() },
		select: SAMPLE_SELECT,
	});
}
