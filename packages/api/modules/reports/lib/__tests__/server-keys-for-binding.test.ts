import { describe, expect, it } from "vitest";
import { serverKeysForBinding } from "../validate-connections";

// The Fizzy Board Report template: the binding may be keyed by the data source
// `key`/provider ("fizzy") OR by the data source `id` ("task-board"). Only the
// former matches the MCP server, so the id form must map through to "fizzy" for
// the self-heal fallback to work.
const dataSources = [{ id: "task-board", provider: "fizzy" }];

describe("serverKeysForBinding", () => {
	it("maps a data-source-id binding key to its provider (task-board → fizzy)", () => {
		const keys = serverKeysForBinding("task-board", dataSources);
		expect(keys).toContain("task-board");
		expect(keys).toContain("fizzy");
	});

	it("keeps a provider-keyed binding and still includes the id", () => {
		const keys = serverKeysForBinding("fizzy", dataSources);
		expect(keys).toContain("fizzy");
		expect(keys).toContain("task-board");
	});

	it("falls back to just the binding key with no/blank template data sources", () => {
		expect(serverKeysForBinding("fizzy")).toEqual(["fizzy"]);
		expect(serverKeysForBinding("unknown", dataSources)).toEqual([
			"unknown",
		]);
	});
});
