/**
 * Strip the server-only secret fields from a DataConnection before returning it
 * to the browser.
 *
 * `accessToken` / `refreshToken` / `credentials` are reversible provider
 * credentials that the client (connection list + detail UI) never consumes.
 * Returning them would leak usable tokens to the browser — historically these
 * procedures serialized the full row, so this also closes a pre-existing
 * plaintext-token exposure (SOC 2 CC6.1 / CC6.7).
 */
export function toClientConnection<T extends Record<string, unknown>>(
	connection: T,
): Omit<T, "accessToken" | "refreshToken" | "credentials">;
export function toClientConnection<T extends Record<string, unknown>>(
	connection: T | null | undefined,
): Omit<T, "accessToken" | "refreshToken" | "credentials"> | null;
export function toClientConnection(
	connection: Record<string, unknown> | null | undefined,
) {
	if (!connection) {
		return null;
	}
	const { accessToken, refreshToken, credentials, ...rest } = connection;
	return rest;
}

/** Strip secrets from a list of connections. */
export function toClientConnections<T extends Record<string, unknown>>(
	connections: T[],
): Omit<T, "accessToken" | "refreshToken" | "credentials">[] {
	return connections.map((c) => toClientConnection(c));
}
