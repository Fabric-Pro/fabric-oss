/**
 * Output Builder
 *
 * Utilities for formatting tool results and building user-friendly responses.
 */

/**
 * Formats a list of items as a user-friendly response.
 */
export function formatListResponse(
	items: unknown[],
	toolName: string,
	_stepDescription: string,
): string {
	const firstItem = items[0] as Record<string, unknown> | null;
	if (!firstItem || typeof firstItem !== "object") {
		return `Found ${items.length} items:\n${items.map((item, i) => `${i + 1}. ${String(item)}`).join("\n")}`;
	}

	const itemType = inferItemType(firstItem, toolName);
	let response = `Found ${items.length} ${itemType}${items.length !== 1 ? "s" : ""}:\n\n`;

	for (let i = 0; i < items.length; i++) {
		const item = items[i] as Record<string, unknown>;
		response += `${formatItem(item, i + 1)}\n`;
	}

	return response.trim();
}

/**
 * Infers the type of item based on its properties and tool name.
 */
export function inferItemType(
	item: Record<string, unknown>,
	toolName: string,
): string {
	const toolLower = toolName.toLowerCase();
	if (toolLower.includes("board")) {
		return "board";
	}
	if (toolLower.includes("project")) {
		return "project";
	}
	if (toolLower.includes("task")) {
		return "task";
	}
	if (toolLower.includes("issue")) {
		return "issue";
	}
	if (toolLower.includes("ticket")) {
		return "ticket";
	}
	if (toolLower.includes("user")) {
		return "user";
	}
	if (toolLower.includes("contact")) {
		return "contact";
	}
	if (toolLower.includes("file")) {
		return "file";
	}
	if (toolLower.includes("document")) {
		return "document";
	}
	if (toolLower.includes("message")) {
		return "message";
	}
	if (toolLower.includes("channel")) {
		return "channel";
	}
	if (toolLower.includes("workspace")) {
		return "workspace";
	}
	if (toolLower.includes("repo")) {
		return "repository";
	}
	if (toolLower.includes("event")) {
		return "event";
	}
	if (toolLower.includes("meeting")) {
		return "meeting";
	}

	// Check item properties
	if ("title" in item && "status" in item) {
		return "task";
	}
	if ("name" in item && "url" in item && "creator" in item) {
		return "board";
	}
	if ("name" in item && "members" in item) {
		return "project";
	}
	if ("email" in item || "email_address" in item) {
		return "contact";
	}
	if ("filename" in item || "file_name" in item) {
		return "file";
	}

	return "item";
}

/**
 * Formats a single item with its key properties.
 */
export function formatItem(
	item: Record<string, unknown>,
	index: number,
): string {
	const parts: string[] = [];

	// Primary identifier
	const name = item.name || item.title || item.subject || item.label;
	if (name) {
		parts.push(`**${String(name)}**`);
	} else {
		parts.push(`**Item ${index}**`);
	}

	// ID
	if (item.id) {
		parts.push(`ID: ${String(item.id)}`);
	}

	// Status
	if (item.status) {
		parts.push(`Status: ${String(item.status)}`);
	}

	// URL
	if (item.url) {
		parts.push(`URL: ${String(item.url)}`);
	}

	// Description (truncated if long)
	if (item.description) {
		const desc = String(item.description);
		parts.push(
			`Description: ${desc.length > 100 ? `${desc.slice(0, 100)}...` : desc}`,
		);
	}

	// Date fields
	if (item.created_at || item.createdAt) {
		const date = item.created_at || item.createdAt;
		parts.push(`Created: ${formatDate(date)}`);
	}
	if (item.updated_at || item.updatedAt) {
		const date = item.updated_at || item.updatedAt;
		parts.push(`Updated: ${formatDate(date)}`);
	}
	if (item.due_date || item.dueDate) {
		const date = item.due_date || item.dueDate;
		parts.push(`Due: ${formatDate(date)}`);
	}

	// Creator/Owner/Assignee
	if (item.creator && typeof item.creator === "object") {
		const creator = item.creator as Record<string, unknown>;
		parts.push(`Creator: ${creator.name || creator.email || "Unknown"}`);
	}
	if (item.owner && typeof item.owner === "object") {
		const owner = item.owner as Record<string, unknown>;
		parts.push(`Owner: ${owner.name || owner.email || "Unknown"}`);
	}
	if (item.assignee && typeof item.assignee === "object") {
		const assignee = item.assignee as Record<string, unknown>;
		parts.push(`Assignee: ${assignee.name || assignee.email || "Unknown"}`);
	}

	// Email (for contacts/users)
	if (item.email || item.email_address) {
		parts.push(`Email: ${item.email || item.email_address}`);
	}

	return `${index}. ${parts.join(" | ")}`;
}

/**
 * Formats a date value for display.
 */
export function formatDate(date: unknown): string {
	if (!date) {
		return "Unknown";
	}
	try {
		const d = new Date(String(date));
		return d.toLocaleDateString("en-US", {
			year: "numeric",
			month: "short",
			day: "numeric",
		});
	} catch {
		return String(date);
	}
}
