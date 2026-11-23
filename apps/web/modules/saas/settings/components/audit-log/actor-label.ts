interface AuditActorRow {
	actorType: string;
	actorEmailSnapshot: string | null;
	actorNameSnapshot: string | null;
	metadata?: unknown;
}

function apiKeyPrefix(metadata: unknown): string | undefined {
	if (
		!metadata ||
		typeof metadata !== "object" ||
		!("keyPrefix" in metadata)
	) {
		return undefined;
	}
	return typeof metadata.keyPrefix === "string"
		? metadata.keyPrefix
		: undefined;
}

/**
 * Who the audit log names as a row's actor. An API key shows its name, or
 * its prefix for rows written before the name was captured. An agent, such
 * as Fabric Parlume acting for a member, shows its own name. Anyone else
 * shows their email, and a row with none is the system's.
 */
export function auditActorLabel(
	row: AuditActorRow,
	t: (key: string) => string,
): string {
	if (row.actorType === "api_key") {
		return (
			row.actorNameSnapshot ??
			apiKeyPrefix(row.metadata) ??
			t("settings.auditLog.badges.apiKey")
		);
	}
	if (row.actorType === "agent" && row.actorNameSnapshot) {
		return row.actorNameSnapshot;
	}
	return row.actorEmailSnapshot ?? t("settings.auditLog.badges.system");
}

/**
 * The email of the person an agent acted for, shown under the agent's name.
 * Null for anyone else, and for an agent whose label is already that email.
 */
export function auditActingFor(row: AuditActorRow): string | null {
	return row.actorType === "agent" && row.actorNameSnapshot
		? row.actorEmailSnapshot
		: null;
}
