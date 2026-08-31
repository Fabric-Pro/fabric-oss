/**
 * The collapsed panel still says something (Fizzy #2165, review item 16).
 *
 * Collapsing used to render nothing at all: the only survivor was a pill beside
 * the project title, far from where the panel had been and shaped like a status
 * label rather than a handle — "once I collapse it, I don't know that a user
 * would know how to unexpand it."
 *
 * A rail or a tab would have restored the door alone. The strip restores the
 * information too, which is the actual complaint: readiness stopped existing on
 * collapse. A Ready project is the exception — it has nothing to ask for, and
 * the card wants that state quiet.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
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

const { readinessRef, setExpandedMock } = vi.hoisted(() => ({
	readinessRef: { current: null as unknown },
	setExpandedMock: vi.fn(),
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
	resolveProjectTabs: (tabs: readonly unknown[]) => tabs,
}));

vi.mock("next-intl", async () => {
	const { readFileSync } = await import("node:fs");
	const messages = JSON.parse(
		readFileSync("../../packages/i18n/translations/en.json", "utf8"),
	) as Record<string, unknown>;
	return {
		useTranslations: (namespace: string) => (key: string, vars?: never) => {
			const value = `${namespace}.${key}`
				.split(".")
				.reduce<unknown>(
					(node, part) =>
						node && typeof node === "object"
							? (node as Record<string, unknown>)[part]
							: undefined,
					messages,
				);
			if (typeof value !== "string") {
				return `${namespace}.${key}`;
			}
			const args = (vars ?? {}) as Record<string, unknown>;
			// Enough ICU to prove the strip renders real values: simple
			// placeholders, plus the one plural the outstanding count uses.
			return value
				.replace(
					/\{(\w+),\s*plural,\s*one\s*\{([^}]*)\}\s*other\s*\{([^}]*)\}\}/g,
					(_m, name: string, one: string, other: string) => {
						const n = Number(args[name] ?? 0);
						return (n === 1 ? one : other).replace(/#/g, String(n));
					},
				)
				.replace(/\{(\w+)\}/g, (_m, name: string) =>
					String(args[name] ?? ""),
				);
		},
	};
});

import { ProjectReadinessPanelSlot } from "../ProjectReadinessPanel";

function mountCollapsed(level: string) {
	setExpandedMock.mockClear();
	readinessRef.current = {
		projectId: "p1",
		isLoading: false,
		isExpanded: false,
		setExpanded: setExpandedMock,
		refetch: vi.fn(),
		hasInlineSlot: false,
		claimInlineSlot: vi.fn(),
		data: {
			enabled: true,
			attention: {
				changes: [],
				levelDropped: false,
				seenAt: null,
				autoExpandedAt: null,
			},
			level,
			phase: "DEVELOPMENT_EXECUTION",
			phaseSource: "set",
			completedCount: 10,
			totalCount: 17,
			canAct: true,
			recentlyCompleted: [],
			suggestPhaseTransition: false,
			items: [],
			activeGaps: [
				{ key: "prd", needLevel: "MUST", isActiveGap: true },
				{
					key: "team-members",
					needLevel: "SHOULD",
					isActiveGap: true,
				},
			],
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

describe("the collapsed readiness panel", () => {
	it("keeps the level, the progress and the next step on screen", () => {
		mountCollapsed("NOT_READY");

		expect(screen.getByText("Not ready")).toBeInTheDocument();
		expect(screen.getByText(/10 \/ 17/)).toBeInTheDocument();
		expect(
			screen.getByText(/Product Requirement Document/),
		).toBeInTheDocument();
	});

	it("counts only required items as outstanding, not every gap", () => {
		mountCollapsed("NOT_READY");

		// Two active gaps, one of them a Must. The strip reports the Must.
		expect(
			screen.getByText(/1 required item outstanding/),
		).toBeInTheDocument();
	});

	it("reopens the panel when the strip is clicked, not only its chevron", async () => {
		mountCollapsed("PARTIALLY_READY");

		await userEvent.click(screen.getByText("Partially ready"));

		expect(setExpandedMock).toHaveBeenCalledWith(true);
	});

	it("stays quiet on a Ready project", () => {
		mountCollapsed("READY");

		expect(screen.queryByText("Ready")).toBeNull();
	});
});
