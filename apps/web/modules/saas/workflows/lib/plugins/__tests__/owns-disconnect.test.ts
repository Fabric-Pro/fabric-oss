/**
 * `ownsDisconnect` decides whether the workflow integration settings page adds
 * its generic footer Disconnect for a plugin. That footer only deletes the
 * stored rows, so a plugin whose settings component runs its own
 * provider-specific disconnect must declare it, or a connected user gets a
 * second, misleading button. This pins the exact set of owners and keeps the
 * flag off plugins that have no settings component. A custom settings component
 * WITHOUT its own disconnect is allowed and simply leaves the flag unset, so
 * there is deliberately no rule that every settings component must declare it.
 */

import { describe, expect, it } from "vitest";

import { getAllIntegrations } from "../../plugins";
import type { IntegrationType } from "../types";

/**
 * Plugins whose settings component renders its own Disconnect, with the call it
 * makes. GitLab and GitHub call a provider-specific procedure; the rest render
 * the shared `OAuthSettings` (`integrations.oauth.disconnect`) or, for Slack,
 * their own wrapper around it.
 */
const OWNS_DISCONNECT: IntegrationType[] = [
	"ASANA",
	"GITHUB",
	"GITLAB",
	"GOOGLE_DRIVE",
	"HUBSPOT",
	"INTERCOM",
	"LINEAR",
	"MICROSOFT_GRAPH",
	"NOTION",
	"SLACK",
];

describe("plugin ownsDisconnect declaration", () => {
	it("is set for exactly the plugins that own their disconnect", () => {
		const declared = getAllIntegrations()
			.filter((plugin) => plugin.ownsDisconnect)
			.map((plugin) => plugin.type)
			.sort();
		expect(declared).toEqual([...OWNS_DISCONNECT].sort());
	});

	it("is never set on a plugin that has no settings component to own it", () => {
		const orphaned = getAllIntegrations()
			.filter(
				(plugin) =>
					plugin.ownsDisconnect &&
					!plugin.SettingsComponent &&
					!plugin.settingsComponent,
			)
			.map((plugin) => plugin.type);
		expect(orphaned).toEqual([]);
	});
});
