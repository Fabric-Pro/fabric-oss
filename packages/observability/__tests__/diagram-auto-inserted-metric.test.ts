/**
 * Excalidraw chat -> editor auto-insert Prometheus counter.
 *
 * Verifies the metric name, label set, label-value enumeration, and the
 * typed helper that the `createFromChatProcedure` calls.
 *
 * Tests share the real prom-client `register` (no mocks); the counter is
 * reset between tests so each spec sees a fresh series.
 */

import { beforeEach, describe, expect, it } from "vitest";
import {
	type DiagramAutoInsertSurface,
	diagramAutoInsertedTotal,
	incrementDiagramAutoInsertedCounter,
	register,
} from "../lib/metrics";

beforeEach(() => {
	diagramAutoInsertedTotal.reset();
});

describe("diagramAutoInsertedTotal counter", () => {
	it("uses the exact canonical metric name", () => {
		expect(
			(diagramAutoInsertedTotal as unknown as { name: string }).name,
		).toBe("diagram_auto_inserted_total");
	});

	it("registers with the single `surface` label", async () => {
		incrementDiagramAutoInsertedCounter({ surface: "nexus" });
		const exposition = await register.metrics();
		expect(exposition).toContain("diagram_auto_inserted_total{");
		expect(exposition).toContain('surface="nexus"');
	});

	it("emits a distinct series per ChatSurface enum value", async () => {
		const surfaces = [
			"nexus",
			"loom",
			"in-feature",
			"in-document",
		] as const satisfies readonly DiagramAutoInsertSurface[];

		for (const surface of surfaces) {
			incrementDiagramAutoInsertedCounter({ surface });
		}

		const exposition = await register.metrics();
		for (const surface of surfaces) {
			expect(exposition).toContain(`surface="${surface}"`);
		}
	});

	it("increments the counter by one per call", async () => {
		incrementDiagramAutoInsertedCounter({ surface: "in-feature" });
		incrementDiagramAutoInsertedCounter({ surface: "in-feature" });
		incrementDiagramAutoInsertedCounter({ surface: "in-feature" });

		const exposition = await register.metrics();
		expect(exposition).toMatch(
			/diagram_auto_inserted_total\{[^}]*surface="in-feature"[^}]*\}\s+3/,
		);
	});

	it("keeps surface series independent of each other", async () => {
		incrementDiagramAutoInsertedCounter({ surface: "nexus" });
		incrementDiagramAutoInsertedCounter({ surface: "nexus" });
		incrementDiagramAutoInsertedCounter({ surface: "loom" });

		const exposition = await register.metrics();
		expect(exposition).toMatch(
			/diagram_auto_inserted_total\{[^}]*surface="nexus"[^}]*\}\s+2/,
		);
		expect(exposition).toMatch(
			/diagram_auto_inserted_total\{[^}]*surface="loom"[^}]*\}\s+1/,
		);
	});
});
