/**
 * A machine with none of the coding tools' files, for a test that runs
 * `doctor`.
 *
 * `doctor` reports whether each coding tool has the project's Fabric MCP server
 * by reading the tool's own files (`~/.claude.json`, Codex's `config.toml`) from
 * the home folder `machine.home()` names. A test that did not say what that is
 * would read the developer's real files, and its result would depend on whatever
 * server they had registered. Call from `beforeEach`, after any
 * `vi.restoreAllMocks()` that runs in `afterEach`.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { machine } from "../../src/lib/instructions/machine.js";

let emptyHome: string | undefined;

export function useEmptyMachine(): void {
	emptyHome ??= mkdtempSync(path.join(tmpdir(), "fabric-empty-home-"));
	vi.spyOn(machine, "home").mockReturnValue(emptyHome);
	vi.spyOn(machine, "env").mockReturnValue({});
}
