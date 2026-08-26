/**
 * Shared audit-input builder for the per-project embeddable-widget owner
 * mutations (Task 5). Both `settings.update` (enable/disable) and
 * `settings.regenerateEmbedToken` write a row IN their mutation transaction via
 * `recordAuditTx`, so they need the same `RecordAuditInput` shape. Keeping the
 * builder pure (no DB, no request reads) makes it trivially unit-testable and
 * guarantees the two callsites stay consistent.
 *
 * A public-exposure change (turning the widget on/off, rotating the embed
 * token) must not commit without its audit trail — see the atomicity tests in
 * `procedures/__tests__/settings-embed.test.ts`.
 */

import type { RecordAuditInput } from "@repo/database";

/** Which owner action produced the audit row. */
export type WidgetAuditKind = "ENABLED" | "DISABLED" | "TOKEN_ROTATED";

const ACTION_BY_KIND: Record<WidgetAuditKind, RecordAuditInput["action"]> = {
	ENABLED: "newsletter.widget.enabled",
	DISABLED: "newsletter.widget.disabled",
	TOKEN_ROTATED: "newsletter.widget.token_rotated",
};

/**
 * Minimal context shape this builder reads — just the acting user. Kept inline
 * (not the full oRPC context type) so the builder stays pure and the unit tests
 * can pass a literal.
 */
export interface WidgetAuditActorContext {
	user: { id: string; email?: string | null; name?: string | null };
}

/**
 * Resolved project tenant identity. `organizationId` non-null => org context;
 * null => personal context. Passed in (not re-read) so the audit row's scope
 * matches the same XOR-resolved project the handler already verified.
 */
export interface WidgetAuditProject {
	id: string;
	organizationId?: string | null;
}

/**
 * Build the `RecordAuditInput` for a widget owner action. The action `category`
 * derives from the `newsletter.` prefix at write time (see `buildAuditRow`), so
 * we do not set it explicitly. The actor is the acting user (the owner), NOT the
 * tenant `userId` column (which is null in org context by XOR design).
 */
export function buildWidgetAuditInput(
	context: WidgetAuditActorContext,
	project: WidgetAuditProject,
	kind: WidgetAuditKind,
): RecordAuditInput {
	return {
		action: ACTION_BY_KIND[kind],
		actor: {
			type: "user",
			userId: context.user.id,
			emailSnapshot: context.user.email ?? null,
			nameSnapshot: context.user.name ?? null,
		},
		organizationId: project.organizationId ?? null,
		projectId: project.id,
		resource: { type: "newsletter_widget", id: project.id },
	};
}
