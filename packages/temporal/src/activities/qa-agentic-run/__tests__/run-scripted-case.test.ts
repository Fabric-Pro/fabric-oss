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
		// A runner build that reports no per-step outcomes falls back to the
		// pre-#2234 single row rather than inventing per-step data it never
		// received.
		expect(result.steps).toEqual([
			expect.objectContaining({
				order: 1,
				action: "Execute the saved declarative Playwright script",
				status: "PASSED",
			}),
		]);
		expect(result.scriptRevisionId).toBe("revision-1");
		expect(mocks.getRevision).toHaveBeenCalledWith({
			projectId: "project-1",
			testCaseId: "case-1",
			revisionId: "revision-1",
		});
		expect(mocks.writeFile).toHaveBeenCalledTimes(3);
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

	it("writes non-secret settings to config.json, and keeps them OUT of env", async () => {
		// The remote sandbox masks every env var's VALUE wherever it appears
		// in stdout — right for a secret, wrong for a plain setting like the
		// base URL (staging evidence: every scripted-run failure message read
		// `[REDACTED]` in its place). Only credential material may travel as
		// env; everything else goes through the file the sandbox does not mask.
		await runScriptedCase(input);

		const configFileCall = mocks.writeFile.mock.calls.find((call) =>
			String(call[3]).endsWith("/config.json"),
		);
		expect(configFileCall).toBeDefined();
		const config = JSON.parse(String(configFileCall?.[4]));
		expect(config).toMatchObject({
			baseUrl: "https://app.example.com",
			signInUrl: "https://app.example.com/login",
			browser: "chromium",
			resolution: "1920x1080",
			authKind: "FORM",
			pinnedHost: "app.example.com",
			pinnedAddress: "203.0.113.10",
		});

		const execCall = mocks.exec.mock.calls[0];
		const env = (execCall?.[3] as { env: Record<string, string> }).env;
		expect(Object.keys(env).sort()).toEqual(
			[
				"FABRIC_QA_AUTH_HEADER_NAME",
				"FABRIC_QA_AUTH_SECRET",
				"FABRIC_QA_AUTH_USERNAME",
				"NODE_PATH",
			].sort(),
		);
		const envValues = JSON.stringify(env);
		expect(envValues).not.toContain("app.example.com");
		expect(envValues).not.toContain("203.0.113.10");
		expect(envValues).not.toContain("chromium");
	});

	it("destroys the sandbox and returns BLOCKED when execution fails", async () => {
		mocks.exec.mockRejectedValue(new Error("worker unavailable"));

		const result = await runScriptedCase(input);

		expect(result.result).toBe("BLOCKED");
		expect(result.failureMessage).toContain("worker unavailable");
		expect(result.steps).toEqual([
			expect.objectContaining({
				order: 1,
				action: "Prepare the scripted run",
				status: "BLOCKED",
			}),
		]);
		expect(mocks.destroySession).toHaveBeenCalledOnce();
	});

	it("reports one evidence row per plan action when the runner sends per-step results", async () => {
		mocks.getRevision.mockResolvedValue({
			id: "revision-1",
			script: JSON.stringify({
				version: 1,
				steps: [
					{ action: "goto", path: "/dashboard" },
					{
						action: "click",
						locator: {
							by: "role",
							role: "button",
							name: "Sign in",
						},
					},
					{ action: "assertUrl", path: "/dashboard/home" },
				],
			}),
		});
		mocks.exec.mockResolvedValue({
			stdout: 'FABRIC_QA_RESULT:{"status":"FAILED","message":"Step 2 failed: no such button","steps":[{"index":1,"status":"PASSED","message":null},{"index":2,"status":"FAILED","message":"Step 2 failed: no such button"}]}\n',
			stderr: "",
			exitCode: 0,
		});

		const result = await runScriptedCase(input);

		expect(result.result).toBe("FAILED");
		expect(result.steps).toEqual([
			expect.objectContaining({
				order: 1,
				action: "Go to /dashboard",
				status: "PASSED",
			}),
			expect.objectContaining({
				order: 2,
				action: 'Click button "Sign in"',
				status: "FAILED",
				observation: "Step 2 failed: no such button",
			}),
			expect.objectContaining({
				order: 3,
				action: "Assert URL is /dashboard/home",
				status: "SKIPPED",
				observation:
					"Not attempted — an earlier step in this case did not pass.",
			}),
		]);
	});

	it("falls back to a single row when the reported steps do not line up with the plan", async () => {
		mocks.getRevision.mockResolvedValue({
			id: "revision-1",
			script: JSON.stringify({
				version: 1,
				steps: [
					{ action: "goto", path: "/dashboard" },
					{ action: "assertUrl", path: "/dashboard/home" },
				],
			}),
		});
		mocks.exec.mockResolvedValue({
			stdout:
				// index 1, then 3 — a gap a well-formed report never has.
				'FABRIC_QA_RESULT:{"status":"FAILED","message":"desync","steps":[{"index":1,"status":"PASSED","message":null},{"index":3,"status":"FAILED","message":"desync"}]}\n',
			stderr: "",
			exitCode: 0,
		});

		const result = await runScriptedCase(input);

		expect(result.steps).toEqual([
			expect.objectContaining({
				order: 1,
				action: "Execute the saved declarative Playwright script",
				status: "FAILED",
			}),
		]);
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
