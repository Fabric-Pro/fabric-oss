/**
 * Pins the three-state `enabledMcpConfigIds` contract that both chat routes
 * depend on (Fizzy #2040).
 *
 * The regression these guard against: the previous inline union folded a
 * non-array into `[]` before spreading the managed defaults, so `null`
 * ("every enabled config") and `[]` ("explicitly none") both came out as
 * "only the managed defaults". On prod 2026-08-28 that turned a six-server
 * selection into a single Excalidraw id inside
 * `orchestratorExecutionWorkflow`, and the model — correctly, given what it
 * was handed — told the user it had no Fizzy tools.
 *
 * Mutation check: dropping the `!Array.isArray(...)` guard fails
 * "leaves null untouched" and "leaves undefined untouched"; dropping the
 * `.length === 0` guard fails "leaves an explicit empty selection empty".
 */

import { describe, expect, it } from "vitest";
import { unionDefaultMcpConfigIds } from "../union-default-mcp-config-ids";

const DEFAULTS = ["default-excalidraw"];

describe("unionDefaultMcpConfigIds", () => {
	it("leaves null untouched — null means every enabled config, which already includes the defaults", () => {
		expect(unionDefaultMcpConfigIds(null, DEFAULTS)).toBeNull();
	});

	it("leaves undefined untouched for the same reason", () => {
		expect(unionDefaultMcpConfigIds(undefined, DEFAULTS)).toBeUndefined();
	});

	it("leaves an explicit empty selection empty — the user disabled every server", () => {
		expect(unionDefaultMcpConfigIds([], DEFAULTS)).toEqual([]);
	});

	it("unions the defaults into a restricted selection", () => {
		expect(
			unionDefaultMcpConfigIds(["fizzy-1", "ado-2"], DEFAULTS),
		).toEqual(["fizzy-1", "ado-2", "default-excalidraw"]);
	});

	it("does not duplicate a default the caller already selected", () => {
		expect(
			unionDefaultMcpConfigIds(
				["fizzy-1", "default-excalidraw"],
				DEFAULTS,
			),
		).toEqual(["fizzy-1", "default-excalidraw"]);
	});

	it("returns the selection unchanged when the tenant has no managed defaults", () => {
		const selection = ["fizzy-1", "ado-2"];
		expect(unionDefaultMcpConfigIds(selection, [])).toEqual(selection);
	});

	it("preserves a full six-server selection that already contains the default", () => {
		const sixServers = [
			"config-issue-tracker",
			"config-work-items",
			"config-drive",
			"config-chat",
			"config-notes",
			"default-excalidraw",
		];
		expect(unionDefaultMcpConfigIds(sixServers, DEFAULTS)).toHaveLength(6);
	});
});
