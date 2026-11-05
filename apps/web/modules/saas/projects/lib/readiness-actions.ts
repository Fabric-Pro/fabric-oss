import {
	DOCUMENT_TYPE_OPTIONS,
	type ProjectDocumentTypeName,
} from "@repo/utils/document-type-catalog";
import type { EditSection } from "../components/ProjectSectionEditDialog";
import type { SettingsTab } from "../components/ProjectSettingsNav";
import {
	navigateToProjectSettingsTab,
	PM_SETTINGS_ANCHOR_ID,
	REPOSITORY_SETTINGS_ANCHOR_ID,
} from "../components/settings-tab-navigation";

export const PROJECT_READINESS_ACTION_EVENT = "fabric:project-readiness-action";

const PENDING_ACTION_STORAGE_PREFIX = "fabric-project-readiness-action-";
const PENDING_ACTION_TTL_MS = 30_000;

export type ReadinessTarget =
	| { kind: "tab"; tab: string }
	| { kind: "settings"; subTab: string };

export type ReadinessDirectAction =
	| { kind: "edit-overview"; section: EditSection }
	| { kind: "create-document"; documentType: ProjectDocumentTypeName }
	| { kind: "open-context-uploader" };

export type ProjectReadinessActionEventDetail = {
	projectId: string;
	action: ReadinessDirectAction;
};

const VALID_EDIT_SECTIONS: ReadonlySet<EditSection> = new Set([
	"description",
	"goals",
	"types",
	"techStack",
	"features",
]);

const VALID_DOCUMENT_TYPES: ReadonlySet<string> = new Set(
	DOCUMENT_TYPE_OPTIONS.map((option) => option.value),
);

const OVERVIEW_EDIT_SECTIONS_BY_ITEM_KEY: Partial<Record<string, EditSection>> =
	{
		"feature-snapshot": "features",
		"tech-stack": "techStack",
	};

const DOCUMENT_TYPE_BY_ITEM_KEY: Partial<
	Record<string, ProjectDocumentTypeName>
> = {
	prd: "PRD",
	"business-case": "BUSINESS_CASE",
	proposal: "PROPOSAL",
	architecture: "ARCHITECTURE",
	"design-document": "DESIGN_SYSTEM",
	"api-spec": "API_SPEC",
	"technical-spec": "TECHNICAL_SPEC",
	"qa-strategy": "QA_STRATEGY",
};

const CONTEXT_UPLOADER_ITEM_KEYS: ReadonlySet<string> = new Set([
	"context-source",
	"additional-context-sources",
	"wiki-connected",
	"knowledge-base",
]);

const SETTINGS_ANCHOR_BY_ITEM_KEY: Partial<Record<string, string>> = {
	"pm-system-connected": PM_SETTINGS_ANCHOR_ID,
	"pm-sync-enabled": PM_SETTINGS_ANCHOR_ID,
	"terminal-statuses": PM_SETTINGS_ANCHOR_ID,
	"codebase-connected": REPOSITORY_SETTINGS_ANCHOR_ID,
	"chat-app-connected": "settings-chat-monitors",
	"work-capture-chat": "settings-chat-monitors",
	"meeting-transcripts": "settings-meeting-transcripts",
	"work-capture-transcripts": "settings-meeting-transcripts",
};

export function isOverviewEditSection(
	value: string | null,
): value is EditSection {
	return (
		typeof value === "string" &&
		VALID_EDIT_SECTIONS.has(value as EditSection)
	);
}

export function isCreatableDocumentType(
	value: string | null,
): value is ProjectDocumentTypeName {
	return typeof value === "string" && VALID_DOCUMENT_TYPES.has(value);
}

function resolveDirectActionForItem(
	itemKey: string,
): ReadinessDirectAction | null {
	const editSection = OVERVIEW_EDIT_SECTIONS_BY_ITEM_KEY[itemKey];
	if (editSection) {
		return { kind: "edit-overview", section: editSection };
	}
	const documentType = DOCUMENT_TYPE_BY_ITEM_KEY[itemKey];
	if (documentType) {
		return { kind: "create-document", documentType };
	}
	if (CONTEXT_UPLOADER_ITEM_KEYS.has(itemKey)) {
		return { kind: "open-context-uploader" };
	}
	return null;
}

/**
 * Build the addressable href for a readiness checklist CTA so both direct clicks
 * and new-tab navigations open the exact editor or settings section rather than
 * dropping the user onto a generic tab or launching an explanatory spotlight.
 */
export function buildReadinessActionHref(
	projectBasePath: string,
	target: ReadinessTarget,
	itemKey?: string,
): string {
	const params = new URLSearchParams();
	if (target.kind === "tab") {
		params.set("tab", target.tab);
		if (itemKey) {
			const action = resolveDirectActionForItem(itemKey);
			if (action?.kind === "edit-overview") {
				params.set("edit", action.section);
			} else if (action?.kind === "create-document") {
				params.set("createDoc", action.documentType);
			} else if (action?.kind === "open-context-uploader") {
				params.set("addContext", "1");
			}
		}
	} else {
		params.set("tab", "settings");
		params.set("settingsTab", target.subTab);
		const anchorId = itemKey
			? SETTINGS_ANCHOR_BY_ITEM_KEY[itemKey]
			: undefined;
		if (anchorId) {
			params.set("settingsAnchor", anchorId);
		}
	}
	return `${projectBasePath}?${params.toString()}`;
}

export function dispatchReadinessItemAction(
	projectId: string,
	target: ReadinessTarget,
	itemKey: string,
) {
	if (target.kind === "settings") {
		const anchorId = SETTINGS_ANCHOR_BY_ITEM_KEY[itemKey];
		navigateToProjectSettingsTab(
			projectId,
			target.subTab as SettingsTab,
			anchorId ? { anchorId } : undefined,
		);
		return;
	}

	const action = resolveDirectActionForItem(itemKey);
	if (!action || typeof window === "undefined") {
		return;
	}

	try {
		sessionStorage.setItem(
			`${PENDING_ACTION_STORAGE_PREFIX}${projectId}`,
			JSON.stringify({
				action,
				expiresAt: Date.now() + PENDING_ACTION_TTL_MS,
			}),
		);
	} catch {
		// Ignore storage quota / private mode failures; the event and URL still run.
	}

	window.dispatchEvent(
		new CustomEvent<ProjectReadinessActionEventDetail>(
			PROJECT_READINESS_ACTION_EVENT,
			{ detail: { projectId, action } },
		),
	);
}

export function consumePendingReadinessAction<
	K extends ReadinessDirectAction["kind"],
>(
	projectId: string,
	kind: K,
): Extract<ReadinessDirectAction, { kind: K }> | null {
	if (typeof window === "undefined") {
		return null;
	}
	const key = `${PENDING_ACTION_STORAGE_PREFIX}${projectId}`;
	try {
		const raw = sessionStorage.getItem(key);
		if (!raw) {
			return null;
		}
		const parsed = JSON.parse(raw) as {
			action?: ReadinessDirectAction;
			expiresAt?: number;
		};
		if (!parsed?.action || (parsed.expiresAt ?? 0) < Date.now()) {
			sessionStorage.removeItem(key);
			return null;
		}
		if (parsed.action.kind !== kind) {
			return null;
		}
		sessionStorage.removeItem(key);
		return parsed.action as Extract<ReadinessDirectAction, { kind: K }>;
	} catch {
		return null;
	}
}

function stripSearchParamsFromHistory(paramNames: readonly string[]) {
	if (typeof window === "undefined") {
		return;
	}
	try {
		const next = new URLSearchParams(window.location.search);
		let changed = false;
		for (const name of paramNames) {
			if (next.has(name)) {
				next.delete(name);
				changed = true;
			}
		}
		if (!changed) {
			return;
		}
		const query = next.toString();
		const nextUrl = `${window.location.pathname}${query ? `?${query}` : ""}${window.location.hash}`;
		window.history.replaceState(window.history.state, "", nextUrl);
	} catch {
		// Ignore in non-standard test/history environments.
	}
}

/**
 * Read a one-shot query parameter from `window.location.search` and strip it
 * without requiring extra `next/navigation` hook imports in leaf tab components
 * (which many unit suites partially mock).
 */
export function consumeLocationSearchParam(paramName: string): string | null {
	if (typeof window === "undefined") {
		return null;
	}
	try {
		const params = new URLSearchParams(window.location.search);
		const value = params.get(paramName);
		if (value === null) {
			return null;
		}
		const hadTabParam = params.has("tab");
		stripSearchParamsFromHistory([paramName]);
		if (hadTabParam && typeof window.requestAnimationFrame === "function") {
			window.requestAnimationFrame(() => {
				stripSearchParamsFromHistory([paramName]);
			});
		}
		return value;
	} catch {
		return null;
	}
}
