/**
 * Human-readable priority band labels for text sent to an LLM.
 *
 * The database enum (`P2_MEDIUM`) is a storage detail. Feeding it to a model
 * verbatim makes the model echo it back into prose a person reads — staging
 * produced "P2_MEDIUM feature in draft stage with no blockers", which reads
 * like a leaked database value because it is one. Every prompt that describes a
 * work item to a model formats the band through here instead.
 */
const PRIORITY_LABELS: Record<string, string> = {
	P0_CRITICAL: "P0 (Critical)",
	P1_HIGH: "P1 (High)",
	P2_MEDIUM: "P2 (Medium)",
	P3_LOW: "P3 (Low)",
};

export function priorityLabelForPrompt(priority: string): string {
	return PRIORITY_LABELS[priority] ?? priority;
}
