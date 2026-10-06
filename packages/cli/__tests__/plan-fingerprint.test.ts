import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	fingerprintFileSafely: vi.fn(),
}));

vi.mock("../src/lib/instructions/safe-write.js", () => m);

import type { InstructionsLock } from "../src/lib/instructions/lock.js";
import {
	findLedgerDrift,
	hashLocalFile,
} from "../src/lib/instructions/plan.js";

beforeEach(() => {
	m.fingerprintFileSafely.mockReset();
});

describe("instruction plan fingerprints", () => {
	it("uses the bounded fingerprint reader when comparing a manifest file", async () => {
		m.fingerprintFileSafely.mockResolvedValue({
			sha256: "a".repeat(64),
			size: 8 * 1024 * 1024,
			mode: 0o100644,
		});

		expect(await hashLocalFile("/workspace", "rules/large.md")).toBe(
			"a".repeat(64),
		);
		expect(m.fingerprintFileSafely).toHaveBeenCalledWith(
			"/workspace",
			"rules/large.md",
		);
	});

	it("uses the bounded fingerprint reader when checking ledger mode and hash", async () => {
		const lock: InstructionsLock = {
			version: 1,
			projectId: "project_example",
			snapshotId: "snapshot_example",
			snapshotVersion: 1,
			digest: "b".repeat(64),
			syncedAt: "2026-10-05T00:00:00.000Z",
			files: {
				"rules/large.md": {
					sha256: "c".repeat(64),
					mode: 0o100644,
				},
			},
		};
		m.fingerprintFileSafely.mockResolvedValue({
			sha256: "c".repeat(64),
			size: 8 * 1024 * 1024,
			mode: 0o100644,
		});

		expect(await findLedgerDrift({ root: "/workspace", lock })).toEqual([]);
		expect(m.fingerprintFileSafely).toHaveBeenCalledWith(
			"/workspace",
			"rules/large.md",
		);
	});
});
