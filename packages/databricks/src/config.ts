export interface DatabricksConfig {
	host: string; // normalized: trailing slashes stripped
	clientId?: string;
	clientSecret?: string;
	token?: string; // PAT — takes precedence over OAuth M2M when set
}

/**
 * Returns null when DATABRICKS_HOST is unset or blank.
 * Throws if the host does not start with "https://".
 * Reads DATABRICKS_CLIENT_ID, DATABRICKS_CLIENT_SECRET, DATABRICKS_TOKEN
 * (trimmed; empty string → undefined).
 */
export function getDatabricksConfig(
	env: NodeJS.ProcessEnv = process.env,
): DatabricksConfig | null {
	const rawHost = env.DATABRICKS_HOST?.trim();
	// "placeholder" is the seeded Key Vault value before real secrets are
	// synced (see ensure_secret in deploy-azure-container-apps.yml) — treat
	// it as unconfigured rather than failing the https validation below.
	if (!rawHost || rawHost === "placeholder") {
		return null;
	}

	if (!rawHost.startsWith("https://")) {
		throw new Error(
			`DATABRICKS_HOST must start with "https://" — got: ${rawHost}`,
		);
	}

	// Normalize: strip trailing slashes
	const host = rawHost.replace(/\/+$/, "");

	const readCredential = (value: string | undefined): string | undefined => {
		const trimmed = value?.trim();
		// Same Key Vault placeholder convention as the host above.
		return trimmed && trimmed !== "placeholder" ? trimmed : undefined;
	};
	const clientId = readCredential(env.DATABRICKS_CLIENT_ID);
	const clientSecret = readCredential(env.DATABRICKS_CLIENT_SECRET);
	const token = readCredential(env.DATABRICKS_TOKEN);

	return { host, clientId, clientSecret, token };
}

/**
 * Returns true only when a host is set AND credentials are available:
 * either a PAT token, or both clientId and clientSecret.
 */
export function isDatabricksConfigured(
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	const config = getDatabricksConfig(env);
	if (!config) {
		return false;
	}
	return !!(config.token || (config.clientId && config.clientSecret));
}

/**
 * Returns the configured Databricks host (with trailing slashes stripped).
 * Throws "DATABRICKS_HOST is not set" when unconfigured.
 */
export function getDatabricksHost(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const config = getDatabricksConfig(env);
	if (!config) {
		throw new Error("DATABRICKS_HOST is not set");
	}
	return config.host;
}
