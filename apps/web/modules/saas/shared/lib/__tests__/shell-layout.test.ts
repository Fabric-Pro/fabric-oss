/**
 * Drift guard for the shell's shared geometry.
 *
 * `NavBar` owns the sidebar width; `shell-layout.ts` restates it so the content
 * column and the floating dock can clear it. This test ties the two together by
 * reading `NavBar.tsx` as source text, so changing the sidebar width without
 * updating the module fails here instead of surfacing as a banner that sits on
 * the navigation.
 *
 * The raw-source technique is borrowed from
 * `apps/web/__tests__/modules/saas/get-started/drift.test.ts`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	isFullBleedRoute,
	SHELL_DOCK_LAYER_CLASS,
	SIDEBAR_WIDTHS_PX,
	shellContentOffsetClass,
	shellDockOffsetClass,
} from "../shell-layout";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../../../../../..");

const navSource = readFileSync(
	path.resolve(
		repoRoot,
		"apps/web/modules/saas/shared/components/NavBar.tsx",
	),
	"utf8",
);

/** Every responsive width NavBar applies to itself, as declared in source. */
function navSidebarWidths(): number[] {
	const matches = navSource.matchAll(/md:w-\[(\d+)px\]/g);

	return [...matches].map((match) => Number(match[1])).sort((a, b) => a - b);
}

describe("shell-layout sidebar widths", () => {
	it("matches the widths NavBar actually applies", () => {
		expect(navSidebarWidths()).toEqual([
			SIDEBAR_WIDTHS_PX.collapsed,
			SIDEBAR_WIDTHS_PX.expanded,
		]);
	});

	it("keeps each width on the state NavBar applies it to", () => {
		// The set alone is not enough: swapping the two in NavBar would leave
		// the sorted set identical and invert every offset in the shell. Tie
		// each width to the `showLabels` arm it is written against.
		const lineFor = (width: number) =>
			navSource
				.split("\n")
				.find((line) => line.includes(`md:w-[${width}px]`)) ?? "";

		expect(lineFor(SIDEBAR_WIDTHS_PX.expanded)).toContain("showLabels");
		expect(lineFor(SIDEBAR_WIDTHS_PX.expanded)).not.toContain(
			"!showLabels",
		);
		expect(lineFor(SIDEBAR_WIDTHS_PX.collapsed)).toContain("!showLabels");
	});

	it("keeps the content margin and the dock edge on the same axis values", () => {
		for (const isCollapsed of [true, false]) {
			const width = isCollapsed
				? SIDEBAR_WIDTHS_PX.collapsed
				: SIDEBAR_WIDTHS_PX.expanded;

			expect(shellContentOffsetClass(isCollapsed)).toBe(
				`md:ml-[${width}px]`,
			);
			expect(shellDockOffsetClass(isCollapsed)).toBe(
				`md:left-[${width}px]`,
			);
		}
	});
});

describe("advisory dock layer", () => {
	it("sits in the 31-49 band, clear of the sidebar and below every overlay", () => {
		const layer = Number(SHELL_DOCK_LAYER_CLASS.replace("z-", ""));

		// NavBar is z-30 and every Radix surface (dialog, sheet, popover,
		// dropdown, select, tooltip) is z-50.
		expect(layer).toBeGreaterThan(30);
		expect(layer).toBeLessThan(50);
	});

	it("does not tie with the sidebar again", () => {
		// It was z-30 before Fizzy #2489 — the same layer as NavBar, separated
		// only by position and DOM order. Without this the revert is silent.
		expect(SHELL_DOCK_LAYER_CLASS).not.toBe("z-30");

		const navSidebarLayers = [...navSource.matchAll(/md:z-(\d+)/g)].map(
			(match) => Number(match[1]),
		);
		expect(navSidebarLayers).not.toContain(
			Number(SHELL_DOCK_LAYER_CLASS.replace("z-", "")),
		);
	});
});

describe("isFullBleedRoute", () => {
	const org = "/app/example-org";

	it.each([
		`${org}/projects/proj-1/documents/doc-1`,
		`${org}/projects/proj-1/stories/story-1`,
		`${org}/agents/document-generator`,
		`${org}/agents/task-planner`,
		`${org}/agents/fabric-ai`,
		`${org}/agents/agent-1/try`,
		`${org}/agents/agent-1/enhance`,
		`${org}/prompts/prompt-1/enhance`,
	])("matches the viewport-fixed route %s", (pathname) => {
		expect(isFullBleedRoute(pathname)).toBe(true);
	});

	/**
	 * These stay inside the content column — AppWrapper treats `/chatbot`,
	 * `/nexus` and kanban as full-HEIGHT routes, which own their scrolling but
	 * do not paint over the viewport. Substituting one predicate for the other
	 * would hide the notice here and leave it invisible on the routes above.
	 *
	 * `/workflows/wf-1` is listed as an ordinary org route: AppWrapper anchors
	 * its canvas check at `^/app/workflows/`, which an organization path never
	 * matches.
	 */
	it.each([
		`${org}/workflows/wf-1`,
		`${org}/chatbot`,
		`${org}/nexus`,
		`${org}/projects/proj-1/kanban`,
	])("rejects the in-column route %s", (pathname) => {
		expect(isFullBleedRoute(pathname)).toBe(false);
	});

	it.each([
		`${org}/projects/proj-1/documents`,
		`${org}/projects/proj-1`,
		`${org}/agents`,
		`${org}/start`,
		`${org}/prompts/prompt-1`,
	])("rejects the ordinary route %s", (pathname) => {
		expect(isFullBleedRoute(pathname)).toBe(false);
	});

	it("treats a missing pathname as not full bleed", () => {
		expect(isFullBleedRoute(null)).toBe(false);
		expect(isFullBleedRoute(undefined)).toBe(false);
	});
});
