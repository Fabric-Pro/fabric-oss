/**
 * Creation-time Kanban column template application.
 *
 * Engagement profiles carry a `kanbanTemplateId` (see
 * `src/engagement-profiles.ts`). When a project is created, the profile's
 * template is applied by position to the default story statuses so that, for
 * example, an EXPLORE project starts with "Ideas → Validating → Prioritized →
 * In Progress → Done" instead of the delivery-oriented defaults.
 *
 * The helper is deliberately fail-safe: it never throws on a template it
 * cannot apply cleanly (it returns `{ applied: false, reason }`), because a
 * column-title problem must not fail project creation.
 */

import {
	getKanbanColumnTemplate,
	type KanbanColumnTemplateId,
} from "../../../src/kanban-column-templates";
import { db } from "../../client";
import { createDefaultStoryStatuses, listStoryStatuses } from "./stories";

export type ApplyKanbanTemplateResult =
	| { applied: true; renamed: number }
	| {
			applied: false;
			reason:
				| "default-template"
				| "unknown-template"
				| "duplicate-titles";
	  };

/**
 * Ensure the project has story statuses, then rename the first N by position
 * to the template's titles. The `default` template is a no-op because the
 * default statuses already are the default template (renaming by position
 * would collapse "Ready" and "Done" into a duplicate name).
 */
export async function applyKanbanTemplateForNewProject(
	projectId: string,
	templateId: KanbanColumnTemplateId,
): Promise<ApplyKanbanTemplateResult> {
	let statuses = await listStoryStatuses(projectId);
	if (statuses.length === 0) {
		await createDefaultStoryStatuses(projectId);
		statuses = await listStoryStatuses(projectId);
	}

	if (templateId === "default") {
		return { applied: false, reason: "default-template" };
	}

	const template = getKanbanColumnTemplate(templateId);
	if (!template) {
		return { applied: false, reason: "unknown-template" };
	}

	const sorted = [...statuses].sort((a, b) => a.order - b.order);
	const renameCount = Math.min(template.titles.length, sorted.length);

	// Names are unique per project. Compute the final set up front and refuse
	// to apply a template that would collide with an untouched trailing column.
	const finalNames = sorted.map((status, index) =>
		index < renameCount ? template.titles[index] : status.name,
	);
	if (new Set(finalNames).size !== finalNames.length) {
		return { applied: false, reason: "duplicate-titles" };
	}

	// Two-phase rename: park every affected column on a name that cannot
	// collide (its own id), then assign the template titles. Sequential
	// updates rather than an interactive transaction — see the PrismaPg note
	// in `upsertDraftProjectByKey`.
	for (let index = 0; index < renameCount; index++) {
		const status = sorted[index];
		if (status.name === template.titles[index]) {
			continue;
		}
		await db.projectStoryStatus.update({
			where: { id: status.id },
			data: { name: `__tpl_${status.id}` },
		});
	}
	for (let index = 0; index < renameCount; index++) {
		const status = sorted[index];
		if (status.name === template.titles[index]) {
			continue;
		}
		await db.projectStoryStatus.update({
			where: { id: status.id },
			data: { name: template.titles[index] },
		});
	}

	return { applied: true, renamed: renameCount };
}
