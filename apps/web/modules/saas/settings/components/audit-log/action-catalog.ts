/**
 * Action catalog for the audit-log viewer.
 *
 * Maps every closed-taxonomy action key (27 success + 8 error + 6 incident)
 * to a humanized label, lucide icon, default severity, and category. The
 * `label` is the i18n key suffix only — components read the actual string
 * via `useTranslations()` so labels are translatable.
 *
 * Unknown action keys fall through to a neutral descriptor so a typo or a
 * forward-compatible new key never crashes the UI.
 *
 * Spec: docs/audit-log/README.md §8.2.
 */

import {
	AlertCircle,
	AlertOctagon,
	AlertTriangle,
	Archive,
	BookmarkPlus,
	Briefcase,
	Building2,
	CheckCircle,
	Clock,
	Download,
	Eraser,
	Eye,
	FileSearch,
	FileText,
	FolderMinus,
	FolderPen,
	FolderPlus,
	Key,
	KeySquare,
	LogIn,
	LogOut,
	type LucideIcon,
	MessageSquare,
	Pencil,
	Plug,
	PlugZap,
	Settings2,
	ShieldAlert,
	ShieldCheck,
	ShieldOff,
	Stamp,
	Trash2,
	Unplug,
	Upload,
	UserCog,
	UserMinus,
	UserPlus,
	UserX,
	WandSparkles,
	Zap,
} from "lucide-react";

export type AuditSeverity = "info" | "warning" | "error" | "critical";

export type AuditCategoryKey =
	| "auth"
	| "org"
	| "project"
	| "story"
	| "audit"
	| "error"
	| "incident"
	| "weave"
	// Automatically-captured long-tail activity. Its descriptor is derived from
	// the action key rather than looked up, so this arm has no catalog entries.
	| "activity"
	| "unknown";

export interface ActionDescriptor {
	key: string;
	label: string;
	icon: LucideIcon;
	defaultSeverity: AuditSeverity;
	category: AuditCategoryKey;
}

const D = (
	key: string,
	label: string,
	icon: LucideIcon,
	defaultSeverity: AuditSeverity,
	category: AuditCategoryKey,
): ActionDescriptor => ({ key, label, icon, defaultSeverity, category });

export const ACTION_CATALOG: Record<string, ActionDescriptor> = {
	// auth (8)
	"auth.login.success": D(
		"auth.login.success",
		"Sign-in success",
		LogIn,
		"info",
		"auth",
	),
	"auth.login.failure": D(
		"auth.login.failure",
		"Sign-in failed",
		LogIn,
		"warning",
		"auth",
	),
	"auth.logout": D("auth.logout", "Sign-out", LogOut, "info", "auth"),
	"auth.mfa.enabled": D(
		"auth.mfa.enabled",
		"MFA enabled",
		ShieldCheck,
		"info",
		"auth",
	),
	"auth.mfa.disabled": D(
		"auth.mfa.disabled",
		"MFA disabled",
		ShieldOff,
		"warning",
		"auth",
	),
	"auth.password.changed": D(
		"auth.password.changed",
		"Password changed",
		KeySquare,
		"info",
		"auth",
	),
	"auth.impersonation.started": D(
		"auth.impersonation.started",
		"Impersonation started",
		UserCog,
		"warning",
		"auth",
	),
	"auth.impersonation.ended": D(
		"auth.impersonation.ended",
		"Impersonation ended",
		UserCog,
		"info",
		"auth",
	),

	// org (12)
	"org.created": D(
		"org.created",
		"Organization created",
		Building2,
		"info",
		"org",
	),
	"org.updated": D(
		"org.updated",
		"Organization updated",
		Pencil,
		"info",
		"org",
	),
	"org.deleted": D(
		"org.deleted",
		"Organization deleted",
		Trash2,
		"warning",
		"org",
	),
	"org.settings.updated": D(
		"org.settings.updated",
		"Organization settings updated",
		Settings2,
		"info",
		"org",
	),
	"org.member.invited": D(
		"org.member.invited",
		"Member invited",
		UserPlus,
		"info",
		"org",
	),
	"org.member.role_changed": D(
		"org.member.role_changed",
		"Member role changed",
		Stamp,
		"info",
		"org",
	),
	"org.member.removed": D(
		"org.member.removed",
		"Member removed",
		UserMinus,
		"warning",
		"org",
	),
	"org.api_key.created": D(
		"org.api_key.created",
		"API key created",
		Key,
		"info",
		"org",
	),
	"org.api_key.revoked": D(
		"org.api_key.revoked",
		"API key revoked",
		Key,
		"warning",
		"org",
	),
	"org.api_key.rotated": D(
		"org.api_key.rotated",
		"API key rotated",
		KeySquare,
		"info",
		"org",
	),
	"account.api_key.created": D(
		"account.api_key.created",
		"Personal API key created",
		Key,
		"info",
		"org",
	),
	"account.api_key.revoked": D(
		"account.api_key.revoked",
		"Personal API key revoked",
		Key,
		"warning",
		"org",
	),
	"account.api_key.rotated": D(
		"account.api_key.rotated",
		"Personal API key rotated",
		KeySquare,
		"info",
		"org",
	),
	"org.integration.connected": D(
		"org.integration.connected",
		"Integration connected",
		Plug,
		"info",
		"org",
	),
	"org.integration.disconnected": D(
		"org.integration.disconnected",
		"Integration disconnected",
		Unplug,
		"warning",
		"org",
	),
	"org.integration.config_updated": D(
		"org.integration.config_updated",
		"Integration config updated",
		PlugZap,
		"info",
		"org",
	),

	// project (8)
	"project.created": D(
		"project.created",
		"Project created",
		FolderPlus,
		"info",
		"project",
	),
	"project.updated": D(
		"project.updated",
		"Project updated",
		FolderPen,
		"info",
		"project",
	),
	"project.archived": D(
		"project.archived",
		"Project archived",
		Archive,
		"info",
		"project",
	),
	"project.deleted": D(
		"project.deleted",
		"Project deleted",
		FolderMinus,
		"warning",
		"project",
	),
	"project.member.invited": D(
		"project.member.invited",
		"Project member invited",
		UserPlus,
		"info",
		"project",
	),
	"project.member.role_changed": D(
		"project.member.role_changed",
		"Project member role changed",
		Stamp,
		"info",
		"project",
	),
	"project.member.function_tags_changed": D(
		"project.member.function_tags_changed",
		"Project member function tags changed",
		Stamp,
		"info",
		"project",
	),
	"project.member.function_tags_confirmed": D(
		"project.member.function_tags_confirmed",
		"Project member confirmed function tags",
		Stamp,
		"info",
		"project",
	),
	"project.member.removed": D(
		"project.member.removed",
		"Project member removed",
		UserMinus,
		"warning",
		"project",
	),

	"project.meeting_digest.inclusion_changed": D(
		"project.meeting_digest.inclusion_changed",
		"Meeting digest inclusion changed",
		Settings2,
		"info",
		"project",
	),

	"project.meeting_digest.action_item_toggled": D(
		"project.meeting_digest.action_item_toggled",
		"Meeting action item completion toggled",
		CheckCircle,
		"info",
		"project",
	),

	"project.document_generation.failed": D(
		"project.document_generation.failed",
		"Document generation failed",
		AlertTriangle,
		"warning",
		"project",
	),

	"project.databricks_knowledge.connected": D(
		"project.databricks_knowledge.connected",
		"Databricks knowledge connected",
		Plug,
		"info",
		"project",
	),
	"project.databricks_knowledge.disconnected": D(
		"project.databricks_knowledge.disconnected",
		"Databricks knowledge disconnected",
		Unplug,
		"warning",
		"project",
	),

	// story (6)
	"story.created": D(
		"story.created",
		"Feature created",
		BookmarkPlus,
		"info",
		"story",
	),
	"story.updated": D(
		"story.updated",
		"Feature updated",
		Pencil,
		"info",
		"story",
	),
	"story.reprioritized": D(
		"story.reprioritized",
		"AI re-prioritization run",
		WandSparkles,
		"info",
		"story",
	),
	"story.deleted": D(
		"story.deleted",
		"Feature deleted",
		Trash2,
		"warning",
		"story",
	),
	"story.status_changed": D(
		"story.status_changed",
		"Feature status changed",
		Stamp,
		"info",
		"story",
	),
	"story.pm_pushed": D(
		"story.pm_pushed",
		"Pushed to PM tool",
		Upload,
		"info",
		"story",
	),

	// document assistant conversations (6) — feature-editor AI chats
	"document_assistant.conversation.created": D(
		"document_assistant.conversation.created",
		"Assistant conversation created",
		MessageSquare,
		"info",
		"story",
	),
	"document_assistant.conversation.renamed": D(
		"document_assistant.conversation.renamed",
		"Assistant conversation renamed",
		Pencil,
		"info",
		"story",
	),
	"document_assistant.conversation.archived": D(
		"document_assistant.conversation.archived",
		"Assistant conversation archived",
		Archive,
		"info",
		"story",
	),
	"document_assistant.conversation.deleted": D(
		"document_assistant.conversation.deleted",
		"Assistant conversation deleted",
		Trash2,
		"info",
		"story",
	),
	"document_assistant.conversation.spilled": D(
		"document_assistant.conversation.spilled",
		"Assistant conversation spilled",
		Upload,
		"info",
		"story",
	),
	"document_assistant.conversation.visibility_changed": D(
		"document_assistant.conversation.visibility_changed",
		"Assistant conversation visibility changed",
		Eye,
		"info",
		"story",
	),

	// audit (3)
	"audit.viewed": D("audit.viewed", "Audit log viewed", Eye, "info", "audit"),
	"audit.exported": D(
		"audit.exported",
		"Audit log exported",
		Download,
		"info",
		"audit",
	),
	"audit.retention.purged": D(
		"audit.retention.purged",
		"Audit retention purge",
		Eraser,
		"info",
		"audit",
	),
	"audit.api_request": D(
		"audit.api_request",
		"REST API request",
		Zap,
		"info",
		"audit",
	),
	"userActivity.viewed": D(
		"userActivity.viewed",
		"User activity viewed",
		Eye,
		"info",
		"audit",
	),

	// error (8) — open namespace bridged by automatic capture middleware
	"error.permission_denied": D(
		"error.permission_denied",
		"Permission denied",
		ShieldAlert,
		"warning",
		"error",
	),
	"error.not_found": D(
		"error.not_found",
		"Resource not found",
		FileSearch,
		"warning",
		"error",
	),
	"error.validation": D(
		"error.validation",
		"Validation error",
		AlertTriangle,
		"warning",
		"error",
	),
	"error.rate_limited": D(
		"error.rate_limited",
		"Rate limited",
		Clock,
		"warning",
		"error",
	),
	"error.unavailable": D(
		"error.unavailable",
		"Service unavailable",
		AlertOctagon,
		"error",
		"error",
	),
	"error.timeout": D("error.timeout", "Timeout", Clock, "warning", "error"),
	"error.conflict": D(
		"error.conflict",
		"Conflict",
		AlertTriangle,
		"warning",
		"error",
	),
	"error.internal": D(
		"error.internal",
		"Internal error",
		AlertOctagon,
		"error",
		"error",
	),

	// incident (6)
	"incident.fired": D(
		"incident.fired",
		"Incident fired",
		AlertCircle,
		"error",
		"incident",
	),
	"incident.re_fired": D(
		"incident.re_fired",
		"Incident re-fired",
		AlertCircle,
		"error",
		"incident",
	),
	"incident.acknowledged": D(
		"incident.acknowledged",
		"Incident acknowledged",
		UserX,
		"info",
		"incident",
	),
	"incident.commented": D(
		"incident.commented",
		"Incident commented",
		MessageSquare,
		"info",
		"incident",
	),
	"incident.auto_resolved": D(
		"incident.auto_resolved",
		"Incident auto-resolved",
		CheckCircle,
		"info",
		"incident",
	),
	"incident.manual_resolved": D(
		"incident.manual_resolved",
		"Incident manually resolved",
		CheckCircle,
		"info",
		"incident",
	),

	// weave (2) — Weave/CodingRun session lifecycle. Emitted from
	// `cleanupWeaveResourcesActivity` on every workflow exit and from
	// `weaveExecutionWatchdogWorkflow` when a run exceeds its hard ceiling.
	"weave.session.terminated_on_exit": D(
		"weave.session.terminated_on_exit",
		"Weave session ended",
		LogOut,
		"info",
		"weave",
	),
	"weave.session.terminated_stale": D(
		"weave.session.terminated_stale",
		"Weave session killed (stale)",
		AlertTriangle,
		"warning",
		"weave",
	),
};

const UNKNOWN_DESCRIPTOR: ActionDescriptor = {
	key: "unknown",
	label: "Unknown action",
	icon: Zap,
	defaultSeverity: "info",
	category: "unknown",
};

/** Prefix of machine-derived, automatically-captured activity keys. */
const ACTIVITY_PREFIX = "activity.";

/**
 * Turn one path segment into prose: `updateContent` -> `Update content`,
 * `pull_request` -> `Pull request`.
 */
function humanizeSegment(segment: string): string {
	const spaced = segment
		.replace(/[_-]+/g, " ")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.trim();
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Build a readable label for an automatically-captured activity key.
 *
 * `activity.projects.create` -> `Projects · Create`.
 *
 * These keys are derived from procedure paths at write time, so there are far
 * too many to enumerate in the catalog above and new ones appear whenever a
 * procedure is added. Deriving the label the same way the key was derived keeps
 * the viewer readable without a hand-maintained list that would immediately
 * drift — and without it every one of these rows would read "Unknown action",
 * which is precisely how a complete audit log becomes an unusable one.
 */
function describeActivityAction(action: string): ActionDescriptor {
	const segments = action.slice(ACTIVITY_PREFIX.length).split(".");
	const label = segments.map(humanizeSegment).join(" · ");
	return {
		key: action,
		label: label.length > 0 ? label : "Activity",
		icon: Zap,
		defaultSeverity: "info",
		category: "activity",
	};
}

/**
 * Look up the descriptor for an action key.
 *
 * Resolution order: the curated catalog first, then the derived-activity
 * humanizer, then a neutral fallback whose `key` is the actual action so the
 * caller can still show the raw event identifier.
 */
export function describeAction(action: string): ActionDescriptor {
	const found = ACTION_CATALOG[action];
	if (found) {
		return found;
	}
	if (action.startsWith(ACTIVITY_PREFIX)) {
		return describeActivityAction(action);
	}
	return { ...UNKNOWN_DESCRIPTOR, key: action };
}

/**
 * Icon for a resource type. Falls back to a generic file icon when the
 * type is unknown or null.
 */
export function resourceIcon(type: string | null | undefined): LucideIcon {
	switch (type) {
		case "user":
			return UserPlus;
		case "project":
			return FolderPlus;
		case "story":
		case "feature":
			return BookmarkPlus;
		case "organization":
			return Building2;
		case "api_key":
			return Key;
		case "integration":
			return Plug;
		case "procedure":
			return Briefcase;
		default:
			return FileText;
	}
}

/**
 * Sorted list of action keys grouped by category — used by tests to
 * assert exhaustive coverage and by the catalog UI in dev tools to render
 * a table.
 */
export const KNOWN_ACTIONS = Object.keys(ACTION_CATALOG) as readonly string[];

/**
 * Resolve the display label for an action row.
 *
 * Three surfaces (table, metadata drawer, active-filter pills) each need this and
 * each used to inline the same "call `t()`, detect the key coming back, fall back
 * to the static label" dance. Centralised so the rule lives once.
 *
 * The important part is the FIRST branch: for a machine-derived `activity.*` key
 * there is deliberately no translation entry — there cannot be, since the keys are
 * generated from procedure paths at write time. Calling `t()` on one still
 * *returns* the right thing via the fallback, but next-intl logs a
 * `MISSING_MESSAGE` error on the way, so a page listing many activity rows filled
 * the console with errors. Skipping the lookup entirely for derived keys is the
 * fix; the humanized label is already correct.
 */
export function resolveActionLabel(
	translate: (key: string) => string,
	descriptor: ActionDescriptor,
): string {
	if (descriptor.key.startsWith(ACTIVITY_PREFIX)) {
		return descriptor.label;
	}
	const raw = translate(`settings.auditLog.actions.${descriptor.key}`);
	return typeof raw === "string" &&
		raw.startsWith("settings.auditLog.actions.")
		? descriptor.label
		: raw;
}
