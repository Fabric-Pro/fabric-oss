import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { pluginNameFor } from "../src/lib/plugin/layout.js";
import {
	assignPluginName,
	setPluginNamesFile,
	slugForPlugin,
} from "../src/lib/plugin/plugin-names.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(path.join(tmpdir(), "plugin-names-"));
	setPluginNamesFile(path.join(dir, "plugin-names.json"));
});

afterEach(() => {
	setPluginNamesFile(null);
	rmSync(dir, { recursive: true, force: true });
});

describe("readable plugin names", () => {
	it("slugs a project name", () => {
		expect(slugForPlugin("Slotik")).toBe("slotik");
		expect(slugForPlugin("Checkout Rewrite 2.0")).toBe(
			"checkout-rewrite-2-0",
		);
		expect(slugForPlugin("Café Été")).toBe("cafe-ete");
		expect(slugForPlugin("Слотик")).toBeNull();
	});

	it("names a project once and keeps that name", () => {
		expect(pluginNameFor("cmvifa275000g6gpbl86wzlqn")).toBe(
			"fabric-l86wzlqn",
		);
		assignPluginName({
			projectId: "cmvifa275000g6gpbl86wzlqn",
			projectName: "Slotik",
			keep: null,
		});
		expect(pluginNameFor("cmvifa275000g6gpbl86wzlqn")).toBe("slotik");
		assignPluginName({
			projectId: "cmvifa275000g6gpbl86wzlqn",
			projectName: "Renamed",
			keep: null,
		});
		expect(pluginNameFor("cmvifa275000g6gpbl86wzlqn")).toBe("slotik");
	});

	it("gives a second project with the same name a suffix", () => {
		assignPluginName({
			projectId: "project-a",
			projectName: "Slotik",
			keep: null,
		});
		assignPluginName({
			projectId: "project-b",
			projectName: "Slotik",
			keep: null,
		});
		expect(pluginNameFor("project-b")).toBe("slotik-2");
	});

	it("keeps an installed plugin's id-based name", () => {
		assignPluginName({
			projectId: "cmvifa275000g6gpbl86wzlqn",
			projectName: "Slotik",
			keep: "fabric-l86wzlqn",
		});
		expect(pluginNameFor("cmvifa275000g6gpbl86wzlqn")).toBe(
			"fabric-l86wzlqn",
		);
	});
});
