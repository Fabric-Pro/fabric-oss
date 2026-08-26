/**
 * `Project.projectManagementAdditionalContext` is a free-form JSON column. It
 * started life as a flat bag of connection hints (`account_slug`,
 * `workItemType`, GitLab's status map) and both PM-capability procedures
 * publish it as `Record<string, string>` — a contract the Temporal `pmConfig`
 * input reuses verbatim.
 *
 * The column no longer holds only strings: the inbound field-mapping settings
 * are stored under `fieldMapping` as a nested object. Casting the whole column
 * to `Record<string, string>` therefore fails the procedures' own output
 * validation the moment a project saves a mapping, taking the entire
 * capabilities response — and every UI gated on it — down with it.
 *
 * Publishing the string-valued entries only keeps the declared contract honest
 * without dragging structured settings into workflow inputs that never asked
 * for them. Consumers that need the mapping read the column directly through
 * `readFieldMappingConfig`.
 */
export function readPmStringContext(
	value: unknown,
): Record<string, string> | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}

	const strings: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") {
			strings[key] = entry;
		}
	}
	return strings;
}
