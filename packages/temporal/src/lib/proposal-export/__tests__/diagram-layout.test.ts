/**
 * The Proposal export's diagram layout thread (Fizzy #2946): layout runs off
 * the worker's event loop, a diagram past its time limit is abandoned by
 * terminating the thread, and the next diagram gets a fresh one. A stand-in
 * engine module on disk stands for beautiful-mermaid where the test needs
 * an engine that loops forever or throws; one test runs the real engine.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { beautifulMermaidEntryUrl, openDiagramLayout } from "../diagram-layout";

const directory = mkdtempSync(join(tmpdir(), "diagram-layout-"));
const standIn = join(directory, "engine.mjs");
writeFileSync(
	standIn,
	[
		"export function renderMermaidSVG(source) {",
		'\tif (source.includes("LOOP")) { for (;;) {} }',
		'\tif (source.includes("THROW")) { throw new Error("refused"); }',
		'\tif (source.includes("EXIT")) { process.exit(1); }',
		'\tif (source.includes("LATE")) { setTimeout(() => { throw new Error("late"); }, 20); }',
		'\treturn "<svg data-source=\\"" + source + "\\"></svg>";',
		"}",
	].join("\n"),
);
const STAND_IN_URL = pathToFileURL(standIn).href;

afterAll(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe("openDiagramLayout", () => {
	it("lays a diagram out in its thread and answers with the SVG", async () => {
		const layout = openDiagramLayout(STAND_IN_URL);
		try {
			expect(await layout.render("flowchart LR", {}, 5_000)).toBe(
				'<svg data-source="flowchart LR"></svg>',
			);
		} finally {
			await layout.close();
		}
	});

	it("answers null when the engine refuses the source", async () => {
		const layout = openDiagramLayout(STAND_IN_URL);
		try {
			expect(await layout.render("THROW", {}, 5_000)).toBeNull();
			// The thread is still usable.
			expect(await layout.render("next", {}, 5_000)).toContain("next");
		} finally {
			await layout.close();
		}
	});

	it("abandons a diagram past its limit without stalling this thread, then carries on", async () => {
		const layout = openDiagramLayout(STAND_IN_URL);
		let ticks = 0;
		const ticker = setInterval(() => {
			ticks++;
		}, 20);
		try {
			const started = Date.now();
			expect(await layout.render("LOOP", {}, 400)).toBeNull();
			const elapsed = Date.now() - started;
			expect(elapsed).toBeGreaterThanOrEqual(350);
			expect(elapsed).toBeLessThan(5_000);
			// The event loop kept running while the thread spun.
			expect(ticks).toBeGreaterThan(5);
			// A fresh thread takes the next diagram.
			expect(await layout.render("after", {}, 5_000)).toContain("after");
		} finally {
			clearInterval(ticker);
			await layout.close();
		}
	});

	it("answers null when the thread ends mid-diagram, then carries on in a fresh one", async () => {
		const layout = openDiagramLayout(STAND_IN_URL);
		try {
			const started = Date.now();
			expect(await layout.render("EXIT", {}, 5_000)).toBeNull();
			expect(Date.now() - started).toBeLessThan(4_000);
			expect(await layout.render("after", {}, 5_000)).toContain("after");
		} finally {
			await layout.close();
		}
	});

	it("survives a thread that fails after its diagram was answered", async () => {
		const layout = openDiagramLayout(STAND_IN_URL);
		try {
			expect(await layout.render("LATE", {}, 5_000)).toContain("LATE");
			// The thread throws once nothing waits on it; unheard, that
			// error would fail this test run as an uncaught exception.
			await new Promise((resolve) => setTimeout(resolve, 300));
			expect(await layout.render("after", {}, 5_000)).toContain("after");
		} finally {
			await layout.close();
		}
	});

	it("answers null at once when no time is left", async () => {
		const layout = openDiagramLayout(STAND_IN_URL);
		try {
			expect(await layout.render("flowchart LR", {}, 0)).toBeNull();
		} finally {
			await layout.close();
		}
	});

	it("answers null for every diagram when the engine cannot load", async () => {
		const layout = openDiagramLayout(
			pathToFileURL(join(directory, "missing.mjs")).href,
		);
		try {
			expect(await layout.render("flowchart LR", {}, 5_000)).toBeNull();
		} finally {
			await layout.close();
		}
	});

	it("lays a flowchart out with the real engine, as the page's engine draws it", async () => {
		const layout = openDiagramLayout(beautifulMermaidEntryUrl());
		try {
			const svg = await layout.render(
				"flowchart LR\n  A[Discovery] --> B[Build]",
				{ bg: "#ffffff", fg: "#111827" },
				10_000,
			);
			expect(svg).toMatch(/^<svg\b/);
			expect(svg).toContain("Discovery");
		} finally {
			await layout.close();
		}
	});
});
