/**
 * Permission error → friendly copy.
 *
 * The server's permission middleware throws ORPCError("FORBIDDEN") with a
 * literal message "Missing required permission: <key>". Those keys are
 * developer jargon (e.g. "org:data_connections:manage") — accurate but
 * useless to end users.
 *
 * This helper detects that message shape and substitutes a human-readable
 * variant. If the error is something else, the helper returns the original
 * message (or the caller-supplied fallback when no message is present).
 */

const FRIENDLY_COPY: Record<string, string> = {
	"org:data_connections:manage":
		"Only organization admins can manage shared connectors. Ask an admin to run this action.",
	"org:data_connections:read":
		"You don't have permission to view this connector. Ask an organization admin for access.",
	"org:integrations:manage":
		"Only organization admins can manage integrations. Ask an admin to run this action.",
	"integration:disconnect":
		"Only organization admins can disconnect this integration. Ask an admin to disconnect it.",
	"workspace:update":
		"Only organization admins can update workspace settings.",
	"workspace:delete": "Only organization admins can delete this workspace.",
};

const GENERIC_FORBIDDEN =
	"You don't have permission for this action. Contact an organization admin.";

const PERMISSION_PREFIX = "Missing required permission:";

function extractPermissionKey(message: string): string | null {
	if (!message.startsWith(PERMISSION_PREFIX)) {
		return null;
	}
	const key = message.slice(PERMISSION_PREFIX.length).trim();
	return key || null;
}

/**
 * Returns a user-facing error message:
 * - If `error` is a permission denial with a known key, returns the friendly
 *   copy for that key.
 * - If it's a permission denial with an unknown key, returns the generic
 *   forbidden copy.
 * - If it's any other Error with a message, returns that message.
 * - Otherwise, returns `fallback`.
 */
export function toFriendlyPermissionError(
	error: unknown,
	fallback: string,
): string {
	if (!(error instanceof Error)) {
		return fallback;
	}
	const message = error.message;
	if (!message) {
		return fallback;
	}

	const key = extractPermissionKey(message);
	if (key === null) {
		return message;
	}

	return FRIENDLY_COPY[key] ?? GENERIC_FORBIDDEN;
}
