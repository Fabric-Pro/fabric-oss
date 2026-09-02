/**
 * What the two tab-customization surfaces say about a tab nobody can turn on.
 *
 * Layer 0 — the deployment feature flag — is documented as invisible
 * everywhere: bar, dialog, admin panel, Get Started. Both surfaces used to
 * leak it. The dialog listed a flag-disabled tab as "Hidden by project admin"
 * and the admin panel drew it a switch that saved an override the resolver
 * then ignored. Both told a project admin they could enable something no
 * admin can, which is the complaint that opened this ticket.
 */

import { render, screen } from "@testing-library/react";
import { BotIcon, MapIcon, NetworkIcon } from "lucide-react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CustomizeProjectTabsDialog } from "../CustomizeProjectTabsDialog";
import { ProjectTabVisibilitySettings } from "../ProjectTabVisibilitySettings";

// `atlas` is feature-gated (NEXT_PUBLIC_FABRIC_FEATURE_ATLAS); the other two
// are not, so they stand in for "ordinary tab" either side of it.
const TABS = [
	{ id: "overview", label: "Overview", icon: MapIcon },
	{ id: "documents", label: "Documents", icon: BotIcon },
	{ id: "atlas", label: "Atlas", icon: NetworkIcon },
];

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("a tab this deployment does not offer", () => {
	it("is not listed as admin-hidden in the customize dialog", () => {
		vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_ATLAS", "false");

		render(
			<CustomizeProjectTabsDialog
				open
				onOpenChange={() => {}}
				tabs={TABS}
				config={null}
				prefs={null}
				onSave={() => {}}
				saving={false}
			/>,
		);

		expect(screen.queryByText("Atlas")).toBeNull();
		expect(screen.queryByText(/Unavailable in this project/i)).toBeNull();
	});

	it("gets no switch in the admin panel, because saving one would do nothing", () => {
		vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_ATLAS", "false");

		render(
			<ProjectTabVisibilitySettings
				tabs={TABS}
				config={null}
				canEdit
				onSave={() => {}}
				saving={false}
			/>,
		);

		expect(screen.getByText("Documents")).toBeInTheDocument();
		expect(screen.queryByText("Atlas")).toBeNull();
	});
});

describe("a tab an admin actually hid", () => {
	it("is listed in the dialog with the route to turning it back on", () => {
		vi.stubEnv("NEXT_PUBLIC_FABRIC_FEATURE_ATLAS", "true");

		render(
			<CustomizeProjectTabsDialog
				open
				onOpenChange={() => {}}
				tabs={TABS}
				config={{ overrides: { atlas: false } }}
				prefs={null}
				onSave={() => {}}
				saving={false}
			/>,
		);

		expect(screen.getByText("Atlas")).toBeInTheDocument();
		expect(screen.getByText("Hidden by project admin")).toBeInTheDocument();
		expect(
			screen.getByText(/Settings → General → Tab visibility/),
		).toBeInTheDocument();
	});
});
