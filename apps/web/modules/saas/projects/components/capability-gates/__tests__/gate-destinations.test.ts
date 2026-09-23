/**
 * Where a gate's remedy button goes (Fizzy #2204).
 *
 * Asserted on what the link DOES — the settings event it fires, the href it
 * carries — because the destination name alone says nothing about whether a
 * person lands next to the control that fixes their block.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
	NAVIGATE_TO_SETTINGS_TAB_EVENT,
	type NavigateToSettingsTabDetail,
} from "../../settings-tab-navigation";
import { gateLinkFor } from "../gate-destinations";

const PROJECT = {
	projectId: "project_example",
	basePath: "/app/example-org",
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("gateLinkFor", () => {
	it("opens the Project Management settings tab for a missing board", () => {
		const events: NavigateToSettingsTabDetail[] = [];
		const listener = (event: Event) =>
			events.push(
				(event as CustomEvent<NavigateToSettingsTabDetail>).detail,
			);
		window.addEventListener(NAVIGATE_TO_SETTINGS_TAB_EVENT, listener);

		const link = gateLinkFor("pm-settings", PROJECT);
		if (!("onSelect" in link)) {
			throw new Error("Expected an in-page settings switch");
		}
		link.onSelect();
		window.removeEventListener(NAVIGATE_TO_SETTINGS_TAB_EVENT, listener);

		expect(events).toEqual([
			{
				projectId: "project_example",
				settingsTab: "project-management",
			},
		]);
	});

	it("links a missing integration to the workspace's Integrations page", () => {
		expect(gateLinkFor("integrations", PROJECT)).toEqual({
			href: "/app/example-org/settings/integrations",
		});
	});
});
