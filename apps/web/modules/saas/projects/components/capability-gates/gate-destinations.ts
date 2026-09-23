/**
 * Where a gate's "go fix it" button takes the viewer — one answer for every
 * banner (Fizzy #1930).
 *
 * Each mount used to supply its own mapping, and most supplied none: Security
 * and Context passed nothing, and the document dialog mapped only two of five
 * destinations. So "No repository connected" rendered with no "Connect a
 * repository" button anywhere in the product. The banner now resolves its
 * destination here, through the provider, so a mount cannot forget one.
 *
 * Settings is an in-page tab with no route of its own, so the repository,
 * code-search and PM-board remedies switch to it and bring the right control
 * into view rather than linking; Context and Documents are tabs reached by the
 * `?tab=` deep link every other cross-page call to action uses. Integrations
 * are connected on the workspace's own settings page, not the project's.
 */

import type { GateDestination } from "../../lib/capability-gate-view";
import {
	CODE_SEARCH_SETTINGS_ANCHOR_ID,
	navigateToProjectSettingsTab,
	PM_SETTINGS_ANCHOR_ID,
	REPOSITORY_SETTINGS_ANCHOR_ID,
} from "../settings-tab-navigation";

export type GateLink = { href: string } | { onSelect: () => void };

export function gateLinkFor(
	target: GateDestination,
	project: { projectId: string; basePath: string },
): GateLink {
	const { projectId, basePath } = project;
	switch (target) {
		case "repository":
			return {
				onSelect: () =>
					navigateToProjectSettingsTab(projectId, "development", {
						anchorId: REPOSITORY_SETTINGS_ANCHOR_ID,
					}),
			};
		case "integrations":
			return { href: `${basePath}/settings/integrations` };
		case "pm-settings":
			return {
				onSelect: () =>
					navigateToProjectSettingsTab(
						projectId,
						"project-management",
						{
							anchorId: PM_SETTINGS_ANCHOR_ID,
						},
					),
			};
		case "code-search":
			return {
				onSelect: () =>
					navigateToProjectSettingsTab(projectId, "development", {
						anchorId: CODE_SEARCH_SETTINGS_ANCHOR_ID,
					}),
			};
		case "context":
		case "documents":
			return { href: `${basePath}/projects/${projectId}?tab=${target}` };
	}
}
