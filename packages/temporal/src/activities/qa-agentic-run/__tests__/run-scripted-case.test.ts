import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	getRevision: vi.fn(),
	resolveEnvironmentAuth: vi.fn(),
	resolveSafeOutboundAddresses: vi.fn(),
	createSession: vi.fn(),
	writeFile: vi.fn(),
	exec: vi.fn(),
	destroySession: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getTestCaseScriptRevision: mocks.getRevision,
	resolveEnvironmentAuth: mocks.resolveEnvironmentAuth,
}));

vi.mock("@repo/utils/url-security", () => ({
	resolveSafeOutboundAddresses: mocks.resolveSafeOutboundAddresses,
}));

vi.mock("@repo/sandbox", () => ({
	createSandboxClient: () => ({
		createSession: mocks.createSession,
		writeFile: mocks.writeFile,
		exec: mocks.exec,
		destroySession: mocks.destroySession,
	}),
}));

import {
	runScriptedCase,
	SCRIPT_TIMEOUT_SECONDS,
	SCRIPTED_CASE_ACTIVITY_TIMEOUT_SECONDS,
} from "../run-scripted-case";

const input = {
	projectId: "project-1",
	organizationId: "org-1",
	userId: "user-1",
	testCaseId: "case-1",
	scriptRevisionId: "revision-1",
	environmentId: "environment-1",
	targetBaseUrl: "https://app.example.com",
	environmentSnapshot: {
		signInUrl: "https://app.example.com/login",
		authKind: "FORM" as const,
		authUsername: "qa@example.com",
		authHeaderName: null,
	},
	browser: "chromium",
	resolution: "1920x1080",
};

describe("runScriptedCase", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.getRevision.mockResolvedValue({
			id: "revision-1",
			script: JSON.stringify({
				version: 1,
				steps: [{ action: "goto", path: "/dashboard" }],
			}),
		});
		mocks.resolveSafeOutboundAddresses.mockResolvedValue(["203.0.113.10"]);
		mocks.resolveEnvironmentAuth.mockResolvedValue({
			authKind: "FORM",
			username: "qa@example.com",
			headerName: null,
			secret: "credential-value",
			baseUrl: "https://app.example.com",
			signInUrl: "https://app.example.com/login",
			isProduction: false,
		});
		mocks.createSession.mockResolvedValue({
			sessionId: "session-1",
			workDir: "/workspace",
		});
		mocks.exec.mockResolvedValue({
			stdout: 'FABRIC_QA_RESULT:{"status":"PASSED","message":null}\n',
			stderr: "",
			exitCode: 0,
		});
		mocks.destroySession.mockResolvedValue(undefined);
	});

	it("keeps the credential out of files and supplies it only to the bounded command", async () => {
		const result = await runScriptedCase(input);

		expect(result.result).toBe("PASSED");
		expect(result.scriptRevisionId).toBe("revision-1");
		expect(mocks.getRevision).toHaveBeenCalledWith({
			projectId: "project-1",
			testCaseId: "case-1",
			revisionId: "revision-1",
		});
		expect(mocks.writeFile).toHaveBeenCalledTimes(2);
		for (const call of mocks.writeFile.mock.calls) {
			expect(String(call[4])).not.toContain("credential-value");
		}
		expect(mocks.exec).toHaveBeenCalledWith(
			"session-1",
			"user-1",
			"org-1",
			expect.objectContaining({
				command: "node runner.cjs",
				timeout: 300,
				env: expect.objectContaining({
					FABRIC_QA_AUTH_SECRET: "credential-value",
				}),
			}),
		);
		expect(JSON.stringify(input)).not.toContain("credential-value");
		expect(mocks.destroySession).toHaveBeenCalledWith(
			"session-1",
			"user-1",
			"org-1",
		);
		const caseFileCall = mocks.writeFile.mock.calls.find((call) =>
			String(call[3]).endsWith("/case.json"),
		);
		expect(caseFileCall?.[4]).toContain('"action": "goto"');
		expect(caseFileCall?.[4]).not.toContain("module.exports");
	});

	it("destroys the sandbox and returns BLOCKED when execution fails", async () => {
		mocks.exec.mockRejectedValue(new Error("worker unavailable"));

		const result = await runScriptedCase(input);

		expect(result.result).toBe("BLOCKED");
		expect(result.failureMessage).toContain("worker unavailable");
		expect(mocks.destroySession).toHaveBeenCalledOnce();
	});

	it("rejects a cross-origin sign-in target before creating a sandbox", async () => {
		mocks.resolveEnvironmentAuth.mockResolvedValue({
			authKind: "FORM",
			username: "qa@example.com",
			headerName: null,
			secret: "credential-value",
			baseUrl: "https://app.example.com",
			signInUrl: "https://login.example.net",
			isProduction: false,
		});

		const result = await runScriptedCase({
			...input,
			environmentSnapshot: {
				...input.environmentSnapshot,
				signInUrl: "https://login.example.net",
			},
		});

		expect(result.result).toBe("BLOCKED");
		expect(result.failureMessage).toContain("target or script");
		expect(mocks.createSession).not.toHaveBeenCalled();
	});

	it("blocks a queued run when its snapshotted auth configuration changed", async () => {
		mocks.resolveEnvironmentAuth.mockResolvedValue({
			authKind: "TOKEN",
			username: null,
			headerName: null,
			secret: "credential-value",
			baseUrl: "https://app.example.com",
			signInUrl: null,
			isProduction: false,
		});

		const result = await runScriptedCase(input);

		expect(result.result).toBe("BLOCKED");
		expect(result.failureMessage).toContain(
			"authentication settings changed",
		);
		expect(mocks.createSession).not.toHaveBeenCalled();
	});

	it("never executes an invalid or code-shaped saved artifact", async () => {
		mocks.getRevision.mockResolvedValue({
			id: "revision-1",
			script: 'module.exports = async () => fetch("https://evil.test")',
		});

		const result = await runScriptedCase(input);

		expect(result.result).toBe("BLOCKED");
		expect(mocks.createSession).not.toHaveBeenCalled();
	});
});

/**
 * Two numbers in different bundles that must stay in a relationship, with
 * nothing in the type system tying them together. The workflow declares the
 * activity's `startToCloseTimeout` as a string literal and workflow code cannot
 * import an activity's dependency graph, so this test IS the coupling.
 */
describe("scripted-case timeout budget", () => {
	it("kills the script before Temporal kills the activity", () => {
		// Not merely "less than": the remainder pays for creating the sandbox
		// session, writing runner.cjs and case.json, and destroying the session,
		// all inside the same activity.
		expect(SCRIPT_TIMEOUT_SECONDS).toBeLessThanOrEqual(
			SCRIPTED_CASE_ACTIVITY_TIMEOUT_SECONDS - 30,
		);
	});

	it("leaves a script budget worth having", () => {
		// The inverse mistake: trimming the exec cap to buy headroom until a
		// legitimate suite cannot finish. If a real script needs more than this,
		// raise the ACTIVITY timeout first and this one after.
		expect(SCRIPT_TIMEOUT_SECONDS).toBeGreaterThanOrEqual(120);
	});
});
