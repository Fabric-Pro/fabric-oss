/**
 * A checklist item whose destination this viewer cannot reach (Fizzy #2165).
 *
 * The project tab bar is filtered per viewer — a feature flag, admin tab config
 * or a personal preference removes one — and `ProjectDetails` resolves a `?tab=`
 * naming a tab outside that set by falling back to Overview, deliberately and
 * silently. So "Explore Atlas" on a project with the Atlas tab switched off
 * registered the click and moved nothing, with no error and nothing on screen
 * explaining it.
 *
 * The guard that should have caught this validates targets against the FULL
 * static tab list, flag-gated tabs included, so it passes while the button is
 * dead. This asserts the viewer-resolved path instead: the control is withdrawn
 * and says why, rather than pretending to work.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
});

const { readinessRef, hiddenTabs } = vi.hoisted(() => ({
	readinessRef: { current: null as unknown },
	hiddenTabs: { current: new Set<string>() },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { readiness: {}, update: vi.fn() } },
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		basePath: "/app",
	}),
}));

vi.mock("../ProjectReadinessProvider", () => ({
	useProjectReadiness: () => readinessRef.current,
}));

vi.mock("@saas/projects/lib/project-tab-preferences", () => ({
	useProjectTabCustomization: () => ({ config: undefined, prefs: undefined }),
	resolveProjectTabs: (tabs: readonly { id: string }[]) =>
		tabs.filter((tab) => !hiddenTabs.current.has(tab.id)),
}));

vi.mock("next-intl", async () => {
	const { readFileSync } = await import("node:fs");
	const messages = JSON.parse(
		readFileSync("../../packages/i18n/translations/en.json", "utf8"),
	) as Record<string, unknown>;
	return {
		useTranslations: (namespace: string) => (key: string) => {
			const value = `${namespace}.${key}`
				.split(".")
				.reduce<unknown>(
					(node, part) =>
						node && typeof node === "object"
							? (node as Record<string, unknown>)[part]
							: undefined,
					messages,
				);
			return typeof value === "string" ? value : `${namespace}.${key}`;
		},
	};
});

import { ProjectReadinessPanelSlot } from "../ProjectReadinessPanel";

function mountWithAtlasItem() {
	const atlasItem = {
		key: "atlas-explored",
		category: "VALUABLE_FEATURES",
		i18nKey: "readiness.items.atlasExplored",
		ctaLabelKey: "readiness.cta.atlasExplored",
		needLevel: "SHOULD",
		isComplete: false,
		isInProgress: false,
		manualState: null,
		snoozeUntil: null,
		isVisible: true,
		isActiveGap: true,
		target: { kind: "tab", tab: "atlas" },
	};
	readinessRef.current = {
		projectId: "p1",
		isLoading: false,
		isExpanded: true,
		setExpanded: vi.fn(),
		refetch: vi.fn(),
		hasInlineSlot: false,
		claimInlineSlot: vi.fn(),
		data: {
			enabled: true,
			level: "PARTIALLY_READY",
			phase: "DEVELOPMENT_EXECUTION",
			phaseSource: "set",
			completedCount: 1,
			totalCount: 26,
			canAct: true,
			recentlyCompleted: [],
			suggestPhaseTransition: false,
			items: [atlasItem],
			activeGaps: [atlasItem],
		},
	};
	render(
		<QueryClientProvider
			client={
				new QueryClient({
					defaultOptions: { mutations: { retry: false } },
				})
			}
		>
			<ProjectReadinessPanelSlot />
		</QueryClientProvider>,
	);
}

describe("a call to action whose tab this viewer cannot see", () => {
	it("is a working link while the tab is visible", () => {
		hiddenTabs.current = new Set();
		mountWithAtlasItem();

		const cta = screen.getByRole("link", { name: "Explore Atlas" });
		expect(cta).toHaveAttribute("href", expect.stringContaining("atlas"));
	});

	it("is withdrawn, not left pointing at Overview, once the tab is hidden", () => {
		hiddenTabs.current = new Set(["atlas"]);
		mountWithAtlasItem();

		// The failure this replaces: a link that silently resolved to Overview.
		expect(
			screen.queryByRole("link", { name: "Explore Atlas" }),
		).toBeNull();
		const cta = screen.getByRole("button", { name: "Explore Atlas" });
		expect(cta).toBeDisabled();
	});
});
