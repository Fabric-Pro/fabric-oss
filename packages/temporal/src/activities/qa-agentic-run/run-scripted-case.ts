import {
	getTestCaseScriptRevision,
	resolveEnvironmentAuth,
} from "@repo/database";
import { createSandboxClient } from "@repo/sandbox";
import { parseQaPlaywrightScript } from "@repo/utils";
import { resolveSafeOutboundAddresses } from "@repo/utils/url-security";
import type { AgenticStepResult, RunAgenticCaseResult } from "./run-case";

/**
 * How long the sandbox may run `runner.cjs` before it is killed.
 *
 * This MUST stay comfortably below the `startToCloseTimeout` the workflow
 * proxies `runScriptedCase` with (currently 6 minutes). The gap is not slack —
 * it pays for creating the session, writing the runner and the case, and tearing
 * the session down, all of which happen inside the same activity.
 *
 * Raise this past the activity bound and the failure is silent in the worst way:
 * Temporal kills the activity mid-script, so `parseScriptResult` never sees a
 * `FABRIC_QA_RESULT:` line, and a case that was merely slow is reported as
 * infrastructure failure rather than as a timeout anyone can act on. Raise the
 * activity timeout first, then this.
 *
 * Exported so the invariant can be asserted rather than trusted — nothing else
 * ties the two numbers together, and they live in different bundles (workflow
 * code cannot import an activity's dependency graph).
 */
export const SCRIPT_TIMEOUT_SECONDS = 300;

/**
 * The workflow's `startToCloseTimeout` for this activity, in seconds, restated.
 *
 * Duplicated deliberately: the real value is a string literal in
 * `workflows/qa-agentic-run.ts`, and workflow code is bundled separately, so
 * there is no import that could keep them in step. The test that pins these two
 * together is the thing that keeps them honest.
 */
export const SCRIPTED_CASE_ACTIVITY_TIMEOUT_SECONDS = 6 * 60;
const RESULT_PREFIX = "FABRIC_QA_RESULT:";

interface EnvironmentSnapshot {
	signInUrl: string | null;
	authKind: "NONE" | "FORM" | "TOKEN" | "HEADER";
	authUsername: string | null;
	authHeaderName: string | null;
}

export interface RunScriptedCaseInput {
	projectId: string;
	organizationId: string | null;
	userId: string;
	testCaseId: string;
	scriptRevisionId: string;
	environmentId: string | null;
	targetBaseUrl: string;
	environmentSnapshot?: EnvironmentSnapshot;
	browser: string;
	resolution: string;
}

interface ScriptResult {
	status: "PASSED" | "FAILED" | "BLOCKED";
	message: string | null;
}

function commandEnvironment(
	input: RunScriptedCaseInput,
	environment: NonNullable<
		Awaited<ReturnType<typeof resolveEnvironmentAuth>>
	>,
	snapshot: EnvironmentSnapshot,
	resolvedAddress: string,
): Record<string, string> {
	return {
		FABRIC_QA_BASE_URL: input.targetBaseUrl,
		FABRIC_QA_SIGN_IN_URL: snapshot.signInUrl ?? "",
		FABRIC_QA_BROWSER: input.browser,
		FABRIC_QA_RESOLUTION: input.resolution,
		FABRIC_QA_AUTH_KIND: snapshot.authKind,
		FABRIC_QA_AUTH_USERNAME: snapshot.authUsername ?? "",
		FABRIC_QA_AUTH_HEADER_NAME: snapshot.authHeaderName ?? "",
		FABRIC_QA_AUTH_SECRET: environment.secret ?? "",
		FABRIC_QA_PINNED_HOST: new URL(input.targetBaseUrl).hostname,
		FABRIC_QA_PINNED_ADDRESS: resolvedAddress,
		NODE_PATH: "/usr/local/lib/node_modules",
	};
}

function parseScriptResult(stdout: string): ScriptResult | null {
	const line = stdout
		.split(/\r?\n/)
		.reverse()
		.find((item) => item.startsWith(RESULT_PREFIX));
	if (!line) {
		return null;
	}
	try {
		const parsed = JSON.parse(line.slice(RESULT_PREFIX.length)) as {
			status?: unknown;
			message?: unknown;
		};
		if (
			parsed.status !== "PASSED" &&
			parsed.status !== "FAILED" &&
			parsed.status !== "BLOCKED"
		) {
			return null;
		}
		return {
			status: parsed.status,
			message:
				typeof parsed.message === "string"
					? parsed.message.slice(0, 2_000)
					: null,
		};
	} catch {
		return null;
	}
}

function resultStep(result: ScriptResult): AgenticStepResult {
	return {
		order: 0,
		action: "Execute the saved declarative Playwright script",
		expected: "Every action and assertion completes",
		status: result.status,
		observation:
			result.message ??
			(result.status === "PASSED"
				? "The scripted case completed successfully."
				: "The scripted case did not complete successfully."),
		evidenceKey: null,
	};
}

function blockedResult(
	input: Pick<RunScriptedCaseInput, "testCaseId" | "scriptRevisionId">,
	startedAt: number,
	message: string,
): RunAgenticCaseResult {
	const result: ScriptResult = {
		status: "BLOCKED",
		message: message.slice(0, 2_000),
	};
	return {
		testCaseId: input.testCaseId,
		scriptRevisionId: input.scriptRevisionId,
		result: result.status,
		failureMessage: result.message,
		durationMs: Date.now() - startedAt,
		steps: [resultStep(result)],
		modelCalls: 0,
	};
}

const TRUSTED_RUNNER = String.raw`
"use strict";

const fs = require("node:fs");
const RESULT_PREFIX = "FABRIC_QA_RESULT:";

function viewport(value) {
  const match = /^(\d{3,5})x(\d{3,5})$/.exec(value || "");
  return match
    ? { width: Number(match[1]), height: Number(match[2]) }
    : { width: 1920, height: 1080 };
}

function safeMessage(error) {
  const value = error instanceof Error ? error.message : String(error);
  return value.slice(0, 2000);
}

function sameOriginUrl(baseUrl, path) {
  const url = new URL(path, baseUrl);
  if (url.origin !== new URL(baseUrl).origin) {
    throw new Error("Script navigation must stay on the environment origin.");
  }
  return url.toString();
}

function locate(page, locator) {
  switch (locator.by) {
    case "role":
      return page.getByRole(locator.role, {
        name: locator.name,
        exact: locator.exact,
      }).first();
    case "label":
      return page.getByLabel(locator.value, { exact: locator.exact }).first();
    case "text":
      return page.getByText(locator.value, { exact: locator.exact }).first();
    case "placeholder":
      return page
        .getByPlaceholder(locator.value, { exact: locator.exact })
        .first();
    case "testId":
      return page.getByTestId(locator.value).first();
    default:
      throw new Error("Unsupported locator type.");
  }
}

async function signIn(page, baseUrl, signInUrl, username, secret) {
  await page.goto(sameOriginUrl(baseUrl, signInUrl || baseUrl), {
    waitUntil: "domcontentloaded",
  });
  const usernameInput = page
    .getByLabel(/email|user ?name|login/i)
    .or(page.locator('input[type="email"], input[name*="user" i], input[name*="email" i]'))
    .first();
  const passwordInput = page
    .getByLabel(/password|passcode/i)
    .or(page.locator('input[type="password"]'))
    .first();
  await usernameInput.fill(username);
  await passwordInput.fill(secret);
  await page
    .getByRole("button", { name: /sign in|log in|continue|submit/i })
    .first()
    .click();
  await page.waitForLoadState("domcontentloaded").catch(() => {});
  if (new URL(page.url()).origin !== new URL(baseUrl).origin) {
    throw new Error("Sign-in left the environment origin.");
  }
}

async function executeStep(page, baseUrl, step) {
  const timeout = step.timeoutMs || 30_000;
  switch (step.action) {
    case "goto":
      await page.goto(sameOriginUrl(baseUrl, step.path), {
        waitUntil: "domcontentloaded",
        timeout,
      });
      return;
    case "click":
      await locate(page, step.locator).click({ timeout });
      return;
    case "fill":
      await locate(page, step.locator).fill(step.value, { timeout });
      return;
    case "press":
      await locate(page, step.locator).press(step.key, { timeout });
      return;
    case "selectOption":
      await locate(page, step.locator).selectOption(step.value, { timeout });
      return;
    case "check":
      await locate(page, step.locator).check({ timeout });
      return;
    case "uncheck":
      await locate(page, step.locator).uncheck({ timeout });
      return;
    case "assertVisible":
      if (!(await locate(page, step.locator).isVisible({ timeout }))) {
        throw new Error("Expected element to be visible.");
      }
      return;
    case "assertText": {
      const text = await locate(page, step.locator).textContent({ timeout });
      if (!text || !text.includes(step.value)) {
        throw new Error("Expected element text was not found.");
      }
      return;
    }
    case "assertUrl":
      if (page.url() !== sameOriginUrl(baseUrl, step.path)) {
        throw new Error("Page URL did not match the expected path.");
      }
      return;
    default:
      throw new Error("Unsupported scripted action.");
  }
}

async function main() {
  const baseUrl = process.env.FABRIC_QA_BASE_URL;
  const signInUrl = process.env.FABRIC_QA_SIGN_IN_URL;
  const browserName = process.env.FABRIC_QA_BROWSER || "chromium";
  const resolution = process.env.FABRIC_QA_RESOLUTION || "1920x1080";
  const authKind = process.env.FABRIC_QA_AUTH_KIND || "NONE";
  const username = process.env.FABRIC_QA_AUTH_USERNAME || "";
  const headerName = process.env.FABRIC_QA_AUTH_HEADER_NAME || "";
  const secret = process.env.FABRIC_QA_AUTH_SECRET || "";
  const pinnedHost = process.env.FABRIC_QA_PINNED_HOST || "";
  const pinnedAddress = process.env.FABRIC_QA_PINNED_ADDRESS || "";
  let browser;
  let stage = "setup";

  try {
    if (!baseUrl) {
      throw new Error("The environment has no target URL.");
    }
    const script = JSON.parse(fs.readFileSync("./case.json", "utf8"));
    const playwright = require("playwright");
    const engine =
      browserName === "firefox"
        ? playwright.firefox
        : browserName === "webkit"
          ? playwright.webkit
          : playwright.chromium;
    browser = await engine.launch({
      headless: true,
      args:
        browserName === "chromium" && pinnedHost && pinnedAddress
          ? ["--host-resolver-rules=MAP " + pinnedHost + " " + pinnedAddress]
          : [],
    });
    const context = await browser.newContext({ viewport: viewport(resolution) });
    const targetOrigin = new URL(baseUrl).origin;

    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (
        (url.protocol === "http:" || url.protocol === "https:") &&
        url.origin !== targetOrigin
      ) {
        await route.abort("blockedbyclient");
        return;
      }
      const headers = { ...request.headers() };
      if (url.origin === targetOrigin) {
        if (authKind === "TOKEN" && secret) {
          headers.Authorization = "Bearer " + secret;
        } else if (authKind === "HEADER" && headerName && secret) {
          headers[headerName] = secret;
        }
      }
      await route.continue({ headers });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(30_000);
    if (authKind === "FORM") {
      if (!username || !secret) {
        throw new Error("The form credential is incomplete.");
      }
      await signIn(page, baseUrl, signInUrl, username, secret);
    } else {
      await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
    }

    stage = "test";
    for (let index = 0; index < script.steps.length; index += 1) {
      try {
        await executeStep(page, baseUrl, script.steps[index]);
      } catch (error) {
        throw new Error("Step " + (index + 1) + " failed: " + safeMessage(error));
      }
    }
    return { status: "PASSED", message: null };
  } catch (error) {
    return {
      status: stage === "test" ? "FAILED" : "BLOCKED",
      message: safeMessage(error),
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

main()
  .then((result) => {
    process.stdout.write(RESULT_PREFIX + JSON.stringify(result) + "\n");
  })
  .catch((error) => {
    process.stdout.write(
      RESULT_PREFIX +
        JSON.stringify({ status: "BLOCKED", message: safeMessage(error) }) +
        "\n",
    );
  });
`;

function currentSnapshot(
	environment: NonNullable<
		Awaited<ReturnType<typeof resolveEnvironmentAuth>>
	>,
): EnvironmentSnapshot {
	return {
		signInUrl: environment.signInUrl,
		authKind: environment.authKind,
		authUsername: environment.username,
		authHeaderName: environment.headerName,
	};
}

function environmentMatchesSnapshot(
	environment: NonNullable<
		Awaited<ReturnType<typeof resolveEnvironmentAuth>>
	>,
	snapshot: EnvironmentSnapshot,
	targetBaseUrl: string,
): boolean {
	return (
		environment.baseUrl === targetBaseUrl &&
		environment.signInUrl === snapshot.signInUrl &&
		environment.authKind === snapshot.authKind &&
		environment.username === snapshot.authUsername &&
		environment.headerName === snapshot.authHeaderName
	);
}

/**
 * Execute one immutable declarative Playwright revision in an isolated sandbox.
 *
 * Only the trusted interpreter is executable. The customer-authored artifact is
 * validated JSON, so it has no access to Node, Playwright internals, credentials,
 * stdout verdicts, or arbitrary network APIs.
 */
export async function runScriptedCase(
	input: RunScriptedCaseInput,
): Promise<RunAgenticCaseResult> {
	const startedAt = Date.now();
	if (!input.environmentId) {
		return blockedResult(
			input,
			startedAt,
			"The scripted runner requires a saved environment.",
		);
	}
	if (input.browser !== "chromium") {
		return blockedResult(
			input,
			startedAt,
			"The scripted runner currently supports Chromium only.",
		);
	}
	const [revision, environment] = await Promise.all([
		getTestCaseScriptRevision({
			projectId: input.projectId,
			testCaseId: input.testCaseId,
			revisionId: input.scriptRevisionId,
		}),
		resolveEnvironmentAuth({
			projectId: input.projectId,
			environmentId: input.environmentId,
		}),
	]);
	if (!revision) {
		return blockedResult(
			input,
			startedAt,
			"The selected script revision no longer exists.",
		);
	}
	if (!environment) {
		return blockedResult(
			input,
			startedAt,
			"The selected environment no longer exists.",
		);
	}
	const snapshot = input.environmentSnapshot ?? currentSnapshot(environment);
	if (
		input.environmentSnapshot &&
		!environmentMatchesSnapshot(
			environment,
			input.environmentSnapshot,
			input.targetBaseUrl,
		)
	) {
		return blockedResult(
			input,
			startedAt,
			"The environment authentication settings changed after dispatch. Start a new run.",
		);
	}

	let normalizedScript: string;
	let resolvedAddress: string;
	try {
		const addresses = await resolveSafeOutboundAddresses(
			input.targetBaseUrl,
		);
		const firstAddress = addresses[0];
		if (!firstAddress) {
			throw new Error("Target resolved to no public address");
		}
		resolvedAddress = firstAddress;
		if (snapshot.signInUrl) {
			await resolveSafeOutboundAddresses(snapshot.signInUrl);
			if (
				new URL(snapshot.signInUrl).origin !==
				new URL(input.targetBaseUrl).origin
			) {
				throw new Error("Sign-in origin mismatch");
			}
		}
		normalizedScript = JSON.stringify(
			parseQaPlaywrightScript(revision.script),
			null,
			2,
		);
	} catch {
		return blockedResult(
			input,
			startedAt,
			"The saved target or script is no longer valid.",
		);
	}

	const client = createSandboxClient();
	let sessionId: string | null = null;
	try {
		const session = await client.createSession(
			input.userId,
			input.organizationId ?? undefined,
			{},
		);
		sessionId = session.sessionId;
		await Promise.all([
			client.writeFile(
				session.sessionId,
				input.userId,
				input.organizationId ?? undefined,
				`${session.workDir}/runner.cjs`,
				TRUSTED_RUNNER,
			),
			client.writeFile(
				session.sessionId,
				input.userId,
				input.organizationId ?? undefined,
				`${session.workDir}/case.json`,
				normalizedScript,
			),
		]);
		const execution = await client.exec(
			session.sessionId,
			input.userId,
			input.organizationId ?? undefined,
			{
				command: "node runner.cjs",
				cwd: session.workDir,
				timeout: SCRIPT_TIMEOUT_SECONDS,
				env: commandEnvironment(
					input,
					environment,
					snapshot,
					resolvedAddress,
				),
			},
		);
		const parsed = parseScriptResult(execution.stdout);
		if (!parsed) {
			const detail =
				execution.stderr.trim() ||
				`The sandbox exited with code ${execution.exitCode} without a result.`;
			return blockedResult(input, startedAt, detail);
		}
		return {
			testCaseId: input.testCaseId,
			scriptRevisionId: input.scriptRevisionId,
			result: parsed.status,
			failureMessage: parsed.status === "PASSED" ? null : parsed.message,
			durationMs: Date.now() - startedAt,
			steps: [resultStep(parsed)],
			modelCalls: 0,
		};
	} catch (error) {
		return blockedResult(
			input,
			startedAt,
			`The sandbox runner failed: ${
				error instanceof Error ? error.message : String(error)
			}`,
		);
	} finally {
		if (sessionId) {
			await client
				.destroySession(
					sessionId,
					input.userId,
					input.organizationId ?? undefined,
				)
				.catch(() => {});
		}
	}
}
