import { GoogleDriveIcon } from "@saas/workflows/lib/plugins/google-drive/icon";
import { MicrosoftTeamsIcon } from "@saas/workflows/lib/plugins/microsoft-teams/icon";
import { NotionIcon } from "@saas/workflows/lib/plugins/notion/icon";
import { SlackIcon } from "@saas/workflows/lib/plugins/slack/icon";
import {
	BlocksIcon,
	FileIcon,
	FileSpreadsheetIcon,
	FileTextIcon,
	ImageIcon,
	LinkIcon,
	MicIcon,
	TextIcon,
} from "lucide-react";
import type { ComponentType } from "react";

import { getPmToolBrandIcon } from "./stories/pm-sync/pm-tool-brand-icon";

/**
 * Icon component shape shared by lucide glyphs and our brand SVG icons. Both
 * accept a `className`, which is all the context-row renderers pass.
 */
export type ContextIconComponent = ComponentType<{ className?: string }>;

/**
 * Resolve the display icon for a context row so the wizard pending list and the
 * in-project context list mirror the Add Context dialog's per-source icons.
 * Plain types (file/link/text/image/...) use lucide glyphs; INTEGRATION rows
 * resolve to their provider's brand logo (Teams/Slack/Notion/Google Docs) or
 * the shared PM-tool brand icon (Azure DevOps/Jira/GitLab/...). Unknown
 * integrations fall back to a generic "blocks" glyph rather than a chat bubble
 * so non-chat sources don't masquerade as messaging.
 *
 * Provider matching is case-insensitive + substring-based because the raw
 * `metadata.provider` value varies by source: `MICROSOFT_TEAMS`, `SLACK`,
 * `notion`, `google-drive`, `AZURE_DEVOPS`, `JIRA`, etc.
 */
export function getContextIcon(
	type: string | null | undefined,
	provider?: string | null,
): ContextIconComponent {
	switch ((type ?? "").toUpperCase()) {
		case "FILE":
			return FileTextIcon;
		case "LINK":
			return LinkIcon;
		case "TEXT":
			return TextIcon;
		case "IMAGE":
			return ImageIcon;
		case "SPREADSHEET":
			return FileSpreadsheetIcon;
		case "DOCUMENT":
			return FileIcon;
		case "MEETING_TRANSCRIPT":
			return MicIcon;
		case "SLACK_HUDDLE_NOTES":
			return SlackIcon;
	}

	// INTEGRATION (and any other) row — resolve by provider.
	const normalized = (provider ?? "").toLowerCase();
	if (normalized.includes("team")) {
		return MicrosoftTeamsIcon;
	}
	if (normalized.includes("slack")) {
		return SlackIcon;
	}
	if (normalized.includes("notion")) {
		return NotionIcon;
	}
	if (normalized.includes("google")) {
		return GoogleDriveIcon;
	}
	// PM-backlog providers (azure-devops, jira, gitlab, linear, ...). The shared
	// helper expects the lowercase-dashed token; normalize underscores.
	const pmIcon = getPmToolBrandIcon(normalized.replace(/_/g, "-"));
	if (pmIcon) {
		return pmIcon;
	}
	return BlocksIcon;
}
