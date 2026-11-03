import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

const { readinessRef, setExpandedMock } = vi.hoisted(() => ({
	readinessRef: { current: null as unknown },
	setExpandedMock: vi.fn(),
}));

vi.mock("../ProjectReadinessProvider", () => ({
	useProjectReadiness: () => readinessRef.current,
}));

vi.mock("next-intl", async () => {
	const { readFileSync } = await import("node:fs");
	const messages = JSON.parse(
		readFileSync("../../packages/i18n/translations/en.json", "utf8"),
	) as Record<string, unknown>;
	return {
		useTranslations: (namespace: string) => {
			const base = namespace
				.split(".")
				.reduce<unknown>(
					(node, part) => (node as Record<string, unknown>)?.[part],
					messages,
				);
			return (key: string, values?: Record<string, unknown>) => {
				const raw = key
					.split(".")
					.reduce<unknown>(
						(node, part) =>
							(node as Record<string, unknown>)?.[part],
						base,
					);
				if (typeof raw !== "string") {
					throw new Error(`missing message: ${namespace}.${key}`);
				}
				return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
					String(values?.[name] ?? `{${name}}`),
				);
			};
		},
	};
});

import { ProjectReadinessIndicator } from "../ProjectReadinessIndicator";

function mountIndicator(
	overrides: {
		isExpanded?: boolean;
		level?: "NOT_READY" | "PARTIALLY_READY" | "READY";
		phaseSource?: "set" | "inferred";
		gapCount?: number;
		enabled?: boolean;
	} = {},
) {
	setExpandedMock.mockClear();
	const gapCount = overrides.gapCount ?? 3;
	readinessRef.current = {
		projectId: "p1",
		isLoading: false,
		isExpanded: overrides.isExpanded ?? false,
		setExpanded: setExpandedMock,
		refetch: vi.fn(),
		hasInlineSlot: false,
		claimInlineSlot: vi.fn(),
		data: {
			enabled: overrides.enabled ?? true,
			level: overrides.level ?? "NOT_READY",
			phaseSource: overrides.phaseSource ?? "inferred",
			activeGaps: Array.from({ length: gapCount }, (_, idx) => ({
				key: `gap-${idx}`,
			})),
		},
	};
	return render(<ProjectReadinessIndicator />);
}

describe("ProjectReadinessIndicator", () => {
	it("renders nothing when readiness is disabled", () => {
		const { container } = mountIndicator({ enabled: false });
		expect(container).toBeEmptyDOMElement();
	});

	it("hides duplicate assumed and gap-count details while the panel is expanded", async () => {
		const user = userEvent.setup();
		mountIndicator({
			isExpanded: true,
			level: "NOT_READY",
			phaseSource: "inferred",
			gapCount: 11,
		});

		const button = screen.getByRole("button", {
			name: "Project readiness: Not ready. Select to collapse the checklist.",
		});
		expect(button).toHaveAttribute("aria-expanded", "true");
		expect(button.textContent).not.toContain("assumed");
		expect(button.textContent).not.toContain("11");

		await user.click(button);
		expect(setExpandedMock).toHaveBeenCalledWith(false);
	});

	it("shows assumed status and open gap count when collapsed", () => {
		mountIndicator({
			isExpanded: false,
			level: "PARTIALLY_READY",
			phaseSource: "inferred",
			gapCount: 4,
		});

		const button = screen.getByRole("button", {
			name: "Project readiness: Partially ready. 4 open items. Select to expand the checklist.",
		});
		expect(button).toHaveAttribute("aria-expanded", "false");
		expect(button.textContent).toContain("assumed");
		expect(button.textContent).toContain("4");
	});

	it("uses the semantic success dot token for a Ready project", () => {
		mountIndicator({
			isExpanded: false,
			level: "READY",
			phaseSource: "set",
			gapCount: 0,
		});

		const button = screen.getByRole("button", {
			name: "Project readiness: Ready. No open items. Select to expand the checklist.",
		});
		const dot = button.querySelector("span[aria-hidden='true']");
		expect(dot?.className).toContain("bg-success");
	});
});
