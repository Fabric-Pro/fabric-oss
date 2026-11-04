import { beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock fns referenced by the vi.mock factories below.
const { mockListRemote, mockGetRepos, mockGetCheckpoint, mockResolveAuth } =
	vi.hoisted(() => ({
		mockListRemote: vi.fn(),
		mockGetRepos: vi.fn(),
		mockGetCheckpoint: vi.fn(),
		mockResolveAuth: vi.fn(),
	}));

// `simpleGit()` → an object with the methods the activity calls.
vi.mock("simple-git", () => ({
	simpleGit: () => ({
		listRemote: mockListRemote,
		env() {
			return this;
		},
	}),
}));
vi.mock("@repo/database", () => ({
	getProjectReposForCodeSearch: mockGetRepos,
	getScanCheckpoint: mockGetCheckpoint,
}));
// Stub the clone-auth resolver so the test never touches real repo auth.
vi.mock("../semgrep-scan", () => ({
	resolveCloneAuth: mockResolveAuth,
}));

import {
	decideCodeScanMode,
	parseLsRemoteSha,
	resolveScanCommitActivity,
} from "../resolve-scan-commit";

const HEAD = "abc123def4567890abc123def4567890abc12345";

beforeEach(() => {
	vi.clearAllMocks();
	mockGetRepos.mockResolvedValue([{ owner: "o", repo: "r" }]);
	mockResolveAuth.mockResolvedValue({
		url: "https://github.example/o/r.git",
		env: {},
	});
	mockListRemote.mockResolvedValue(`${HEAD}\trefs/heads/main`);
	mockGetCheckpoint.mockResolvedValue(null);
});

describe("parseLsRemoteSha", () => {
	it("extracts the leading SHA from `git ls-remote` output", () => {
		expect(parseLsRemoteSha(`${HEAD}\trefs/heads/main`)).toBe(HEAD);
	});

	it("skips blank leading lines and tolerates CRLF", () => {
		expect(parseLsRemoteSha(`\r\n  \n${HEAD}\trefs/heads/dev\r\n`)).toBe(
			HEAD,
		);
	});

	it("returns null for empty / non-SHA / non-string input", () => {
		expect(parseLsRemoteSha("")).toBeNull();
		expect(parseLsRemoteSha("not-a-sha\trefs/heads/x")).toBeNull();
		// @ts-expect-error — defensive: tolerate a non-string at runtime.
		expect(parseLsRemoteSha(undefined)).toBeNull();
	});
});

describe("decideCodeScanMode — DIFF only when incremental with a base + target", () => {
	it("DIFF when INCREMENTAL + baseSha + targetSha + !forceFull", () => {
		expect(
			decideCodeScanMode({
				mode: "INCREMENTAL",
				baseSha: "base",
				targetSha: "head",
			}),
		).toBe("DIFF");
	});

	it("FULL without a baseSha (first scan of the branch)", () => {
		expect(
			decideCodeScanMode({
				mode: "INCREMENTAL",
				baseSha: null,
				targetSha: "head",
			}),
		).toBe("FULL");
	});

	it("FULL without a targetSha (couldn't resolve HEAD)", () => {
		expect(
			decideCodeScanMode({
				mode: "INCREMENTAL",
				baseSha: "base",
				targetSha: null,
			}),
		).toBe("FULL");
	});

	it("FULL when forceFull, and FULL for a non-incremental scan", () => {
		expect(
			decideCodeScanMode({
				mode: "INCREMENTAL",
				baseSha: "base",
				targetSha: "head",
				forceFull: true,
			}),
		).toBe("FULL");
		expect(
			decideCodeScanMode({
				mode: "FULL",
				baseSha: "base",
				targetSha: "head",
			}),
		).toBe("FULL");
	});
});

describe("resolveScanCommitActivity — decision table", () => {
	const base = {
		projectId: "p1",
		organizationId: null,
		branch: "main",
	} as const;

	it("INCREMENTAL + baseSha + targetSha → DIFF", async () => {
		mockGetCheckpoint.mockResolvedValue({ commitSha: "basesha" });
		const out = await resolveScanCommitActivity({
			...base,
			mode: "INCREMENTAL",
		});
		expect(out).toEqual({
			branch: "main",
			targetSha: HEAD,
			baseSha: "basesha",
			codeScanMode: "DIFF",
		});
	});

	it("no checkpoint (no baseSha) → FULL with the resolved target", async () => {
		mockGetCheckpoint.mockResolvedValue(null);
		const out = await resolveScanCommitActivity({
			...base,
			mode: "INCREMENTAL",
		});
		expect(out.baseSha).toBeNull();
		expect(out.targetSha).toBe(HEAD);
		expect(out.codeScanMode).toBe("FULL");
	});

	it("forceFull pins codeScanMode to FULL even with a base + target", async () => {
		mockGetCheckpoint.mockResolvedValue({ commitSha: "basesha" });
		const out = await resolveScanCommitActivity({
			...base,
			mode: "INCREMENTAL",
			forceFull: true,
		});
		expect(out.codeScanMode).toBe("FULL");
		expect(out.baseSha).toBe("basesha");
		expect(out.targetSha).toBe(HEAD);
	});

	it("ls-remote throws → FULL with a null targetSha (never throws)", async () => {
		mockGetCheckpoint.mockResolvedValue({ commitSha: "basesha" });
		mockListRemote.mockRejectedValue(new Error("network"));
		const out = await resolveScanCommitActivity({
			...base,
			mode: "INCREMENTAL",
		});
		expect(out).toEqual({
			branch: "main",
			targetSha: null,
			baseSha: null,
			codeScanMode: "FULL",
		});
	});

	it("no connected repo → FULL, targetSha null (no ls-remote attempted)", async () => {
		mockGetRepos.mockResolvedValue([]);
		mockGetCheckpoint.mockResolvedValue({ commitSha: "basesha" });
		const out = await resolveScanCommitActivity({
			...base,
			mode: "INCREMENTAL",
		});
		expect(mockListRemote).not.toHaveBeenCalled();
		expect(out.targetSha).toBeNull();
		expect(out.codeScanMode).toBe("FULL");
	});

	it("blank branch short-circuits to FULL without any lookups", async () => {
		const out = await resolveScanCommitActivity({
			...base,
			branch: "   ",
			mode: "INCREMENTAL",
		});
		expect(out).toEqual({
			branch: "   ",
			targetSha: null,
			baseSha: null,
			codeScanMode: "FULL",
		});
		expect(mockGetRepos).not.toHaveBeenCalled();
		expect(mockGetCheckpoint).not.toHaveBeenCalled();
	});
});
