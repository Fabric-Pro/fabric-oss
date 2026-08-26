/**
 * Regression guard for the auto-insert telemetry registry.
 *
 * The list of event names is the source of truth that downstream
 * dashboards + future-typed analytics providers will consume (spec
 * § 12 / Follow-up #5). A silent rename here would break those
 * dashboards, so we lock the EXACT list of 10 event names + their
 * canonical casing.
 *
 * Pure compile-time + runtime assertions. No React, no rendering.
 */

import { describe, expect, it } from "vitest";
import {
	assertExcalidrawAutoInsertEventPayload,
	EXCALIDRAW_AUTO_INSERT_EVENTS,
	type ExcalidrawAutoInsertEvent,
} from "../../../modules/analytics/events/excalidraw-auto-insert";

describe("EXCALIDRAW_AUTO_INSERT_EVENTS — surface area lock", () => {
	it("exports exactly the 10 event names from spec § 12 (verbatim)", () => {
		// Listed alphabetically so any future addition / removal is an
		// obvious diff. The spec's table lists 10 events.
		expect([...EXCALIDRAW_AUTO_INSERT_EVENTS].sort()).toEqual([
			"diagram_auto_insert_blocked",
			"diagram_auto_insert_detected_existing",
			"diagram_auto_insert_failed",
			"diagram_auto_insert_picker_opened",
			"diagram_auto_insert_picker_picked",
			"diagram_auto_insert_picker_timeout",
			"diagram_auto_inserted",
			"diagram_chat_to_editor_navigated",
			"diagram_embed_code_copied",
			"diagram_embed_code_copy_failed",
		]);
	});

	it("has no duplicates", () => {
		const unique = new Set(EXCALIDRAW_AUTO_INSERT_EVENTS);
		expect(unique.size).toBe(EXCALIDRAW_AUTO_INSERT_EVENTS.length);
	});

	it("uses snake_case names prefixed with diagram_", () => {
		// Defensive: silently renaming an event to camelCase would break
		// every downstream dashboard / SQL query that filters by exact
		// event name. The spec uses snake_case throughout § 12.
		for (const name of EXCALIDRAW_AUTO_INSERT_EVENTS) {
			expect(name).toMatch(/^diagram_[a-z][a-z0-9_]*$/);
		}
	});

	it("ExcalidrawAutoInsertEvent is a string-literal union, not just string", () => {
		// Compile-time assertion: assigning a string literal narrows
		// correctly. Runtime check confirms the constant array contains
		// the same value the type names — a regression guard against
		// the array drifting from the union.
		const sample: ExcalidrawAutoInsertEvent = "diagram_auto_inserted";
		expect(EXCALIDRAW_AUTO_INSERT_EVENTS).toContain(sample);
	});
});

describe("assertExcalidrawAutoInsertEventPayload — typed-payload helper", () => {
	it("returns the payload unchanged (identity helper)", () => {
		const payload = {
			surface: "in-document" as const,
			targetKind: "document" as const,
			projectId: "proj_1",
			diagramId: "diag_1",
			organizationId: "org_1",
		};
		const result = assertExcalidrawAutoInsertEventPayload(
			"diagram_auto_inserted",
			payload,
		);
		expect(result).toBe(payload);
	});

	it("compiles for every event name (smoke check via runtime call)", () => {
		// We only need to verify the function is callable at runtime
		// with each name — the compile-time check is the real value
		// (mismatched payload shapes are a type error). This loop is a
		// regression guard against the helper being accidentally
		// dropped or narrowed.
		assertExcalidrawAutoInsertEventPayload("diagram_auto_inserted", {
			surface: "nexus",
			targetKind: "document",
			projectId: "p",
			diagramId: "d",
			organizationId: "o",
		});
		assertExcalidrawAutoInsertEventPayload("diagram_auto_insert_failed", {
			surface: "nexus",
			failureClass: "db",
		});
		assertExcalidrawAutoInsertEventPayload(
			"diagram_chat_to_editor_navigated",
			{ surface: "nexus", diagramId: "d" },
		);
		assertExcalidrawAutoInsertEventPayload("diagram_auto_insert_blocked", {
			surface: "nexus",
			reason: "cross_project",
		});
		assertExcalidrawAutoInsertEventPayload(
			"diagram_auto_insert_picker_opened",
			{
				surface: "loom",
				projectId: "p",
				hasDocuments: true,
				hasFeatures: false,
			},
		);
		assertExcalidrawAutoInsertEventPayload(
			"diagram_auto_insert_picker_picked",
			{
				surface: "loom",
				targetKind: "feature",
				targetId: "t",
				projectId: "p",
			},
		);
		assertExcalidrawAutoInsertEventPayload(
			"diagram_auto_insert_picker_timeout",
			{ surface: "loom", projectId: "p" },
		);
		assertExcalidrawAutoInsertEventPayload("diagram_embed_code_copied", {
			surface: "in-feature",
			projectId: "p",
		});
		assertExcalidrawAutoInsertEventPayload(
			"diagram_embed_code_copy_failed",
			{
				surface: "in-feature",
				projectId: "p",
			},
		);
		assertExcalidrawAutoInsertEventPayload(
			"diagram_auto_insert_detected_existing",
			{ surface: "in-document", projectId: "p" },
		);
		expect(EXCALIDRAW_AUTO_INSERT_EVENTS).toHaveLength(10);
	});
});
