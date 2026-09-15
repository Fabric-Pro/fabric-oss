/**
 * Predefined Kanban column title templates.
 *
 * Single source of truth shared by the web layer (StoriesKanban "apply preset"
 * action) and the API (applied at project creation from the engagement
 * profile's `kanbanTemplateId`).
 *
 * Templates apply titles by position (index) to the project's existing
 * statuses. If the project has fewer columns than the template, the web
 * action creates the missing columns; the creation-time helper only renames
 * what exists. Column order and item state are unchanged. PMs can customize
 * titles afterwards.
 *
 * This module is pure (no Prisma import) so client bundles can import it via
 * `@repo/database/src/kanban-column-templates`.
 */

export const KANBAN_COLUMN_TEMPLATES = [
	{
		id: "default",
		name: "Default",
		description: "Backlog → In Progress → Review → Done",
		titles: ["Backlog", "In Progress", "Review", "Done"],
	},
	{
		id: "scrum",
		name: "Scrum / Sprint",
		description: "Backlog → Ready → In Progress → Code Review → Done",
		titles: ["Backlog", "Ready", "In Progress", "Code Review", "Done"],
	},
	{
		id: "delivery",
		name: "Delivery / QA",
		description: "Backlog → In Progress → QA → Ready for Release → Done",
		titles: ["Backlog", "In Progress", "QA", "Ready for Release", "Done"],
	},
	{
		id: "discovery",
		name: "Discovery / Product",
		description: "Ideas → Validating → Prioritized → In Progress",
		titles: ["Ideas", "Validating", "Prioritized", "In Progress"],
	},
] as const;

export type KanbanColumnTemplate = (typeof KANBAN_COLUMN_TEMPLATES)[number];

export type KanbanColumnTemplateId = KanbanColumnTemplate["id"];

export function getKanbanColumnTemplate(
	id: string,
): KanbanColumnTemplate | undefined {
	return KANBAN_COLUMN_TEMPLATES.find((template) => template.id === id);
}
