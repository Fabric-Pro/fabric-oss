/**
 * Audit trail for AI provider credential configuration.
 *
 * Saving, replacing, re-pointing or deleting a provider config changes which
 * endpoint receives tenant prompts and which credential is used, so each
 * mutation records who did it and what changed. Metadata carries only
 * non-secret facts: the API key and client secret never appear, only whether a
 * new one was supplied, and a base URL is reduced to host and path.
 */

import { recordAuditFromRequest } from "../../../lib/audit";

type AuditContext = Parameters<typeof recordAuditFromRequest>[0];

export type ProviderAuditScope =
	| { kind: "org"; organizationId: string }
	| { kind: "account" };

/** The non-secret shape of a provider config row, as recorded before/after. */
export interface ProviderAuditSnapshot {
	baseUrl: string | null;
	deploymentName: string | null;
	hasClientId: boolean;
	isDefault: boolean;
	enabled: boolean;
	isEmbeddingProvider: boolean;
	purpose: string;
	enabledProviders: string[] | null;
}

interface ProviderRowLike {
	config?: unknown;
	clientId?: string | null;
	isDefault?: boolean;
	enabled?: boolean;
	isEmbeddingProvider?: boolean;
	purpose?: string;
}

const EMPTY_SNAPSHOT: ProviderAuditSnapshot = {
	baseUrl: null,
	deploymentName: null,
	hasClientId: false,
	isDefault: false,
	enabled: false,
	isEmbeddingProvider: false,
	purpose: "ALL",
	enabledProviders: null,
};

/** Host and path only: a pasted URL can carry userinfo or a query-string key. */
function describeBaseUrl(value: unknown): string | null {
	if (typeof value !== "string" || value.trim() === "") {
		return null;
	}
	try {
		const url = new URL(value.trim());
		return `${url.protocol}//${url.host}${url.pathname}`;
	} catch {
		return "(unparseable)";
	}
}

function readString(config: Record<string, unknown>, key: string) {
	const value = config[key];
	return typeof value === "string" && value !== "" ? value : null;
}

export function snapshotProviderRow(
	row: ProviderRowLike,
): ProviderAuditSnapshot {
	const config =
		row.config && typeof row.config === "object"
			? (row.config as Record<string, unknown>)
			: {};
	const enabledProviders = Array.isArray(config.enabledProviders)
		? config.enabledProviders.filter(
				(item): item is string => typeof item === "string",
			)
		: null;
	return {
		baseUrl: describeBaseUrl(config.baseUrl),
		deploymentName: readString(config, "deploymentName"),
		hasClientId: Boolean(row.clientId),
		isDefault: row.isDefault ?? false,
		enabled: row.enabled ?? true,
		isEmbeddingProvider: row.isEmbeddingProvider ?? false,
		purpose: row.purpose ?? "ALL",
		enabledProviders,
	};
}

function changedFields(
	before: ProviderAuditSnapshot,
	after: ProviderAuditSnapshot,
): string[] {
	return (Object.keys(after) as (keyof ProviderAuditSnapshot)[]).filter(
		(key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
	);
}

function actionFor(scope: ProviderAuditScope, suffix: string): string {
	return `${scope.kind}.ai_provider.${suffix}`;
}

function scopeFields(scope: ProviderAuditScope) {
	return {
		category: scope.kind,
		organizationId: scope.kind === "org" ? scope.organizationId : null,
	} as const;
}

interface ProviderRef {
	id: string;
	provider: string;
}

export function recordProviderConfigured(
	context: AuditContext,
	scope: ProviderAuditScope,
	ref: ProviderRef,
	change: {
		before: ProviderAuditSnapshot | null;
		after: ProviderAuditSnapshot;
		keyChanged: boolean;
	},
): void {
	const created = change.before === null;
	recordAuditFromRequest(context, {
		action: actionFor(scope, created ? "configured" : "updated"),
		...scopeFields(scope),
		resource: { type: "ai_provider", id: ref.id, name: ref.provider },
		metadata: {
			provider: ref.provider,
			keyChanged: change.keyChanged,
			changedFields: changedFields(
				change.before ?? EMPTY_SNAPSHOT,
				change.after,
			),
			before: change.before,
			after: change.after,
		},
	});
}

export function recordProviderSettingChanged(
	context: AuditContext,
	scope: ProviderAuditScope,
	suffix:
		| "default_changed"
		| "embedding_changed"
		| "enabled_providers_changed",
	ref: ProviderRef,
	change: {
		before: Partial<ProviderAuditSnapshot>;
		after: Partial<ProviderAuditSnapshot>;
		details?: Record<string, unknown>;
	},
): void {
	recordAuditFromRequest(context, {
		action: actionFor(scope, suffix),
		...scopeFields(scope),
		resource: { type: "ai_provider", id: ref.id, name: ref.provider },
		metadata: {
			provider: ref.provider,
			before: change.before,
			after: change.after,
			...change.details,
		},
	});
}

export function recordProviderDeleted(
	context: AuditContext,
	scope: ProviderAuditScope,
	ref: ProviderRef,
	change: {
		before: ProviderAuditSnapshot;
		defaultReassignedTo: string | null;
	},
): void {
	recordAuditFromRequest(context, {
		action: actionFor(scope, "deleted"),
		...scopeFields(scope),
		severity: "warning",
		resource: { type: "ai_provider", id: ref.id, name: ref.provider },
		metadata: {
			provider: ref.provider,
			before: change.before,
			defaultReassignedTo: change.defaultReassignedTo,
		},
	});
}
