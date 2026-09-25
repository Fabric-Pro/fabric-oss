import {
	getTestCaseScriptRevision,
	resolveEnvironmentAuth,
} from "@repo/database";
import { createSandboxClient } from "@repo/sandbox";
import {
	describeQaScriptStep,
	expectedForQaScriptStep,
	parseQaPlaywrightScript,
	type QaPlaywrightScriptStep,
} from "@repo/utils";
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

/** One plan action's own outcome, as `TRUSTED_RUNNER` reports it. Only ever
 * PASSED or FAILED — a step the runner never reached (because an earlier one
 * failed, or the run never left setup) simply has no entry. */
interface ScriptStepReport {
	index: number;
	status: "PASSED" | "FAILED";
	message: string | null;
}

interface ScriptResult {
	status: "PASSED" | "FAILED" | "BLOCKED";
	message: string | null;
	steps?: ScriptStepReport[];
}

/**
 * A sanity ceiling on the reported step count, independent of any particular
 * plan's length — {@link qaPlaywrightScriptSchema} in `@repo/utils` caps a
 * plan at 100 steps, and `runner.cjs`'s stdout is untrusted output from a
 * sandboxed process, so this parser never allocates more than that cap no
 * matter what the process claims.
 */
const MAX_REPORTED_STEPS = 100;

/**
 * Validate the untrusted `steps` array from the runner's own JSON line.
 * Returns `undefined` — never a partial or best-effort array — for anything
 * that does not look exactly like a well-formed report, so a malformed or
 * tampered payload falls back to the single-row behaviour rather than being
 * rendered as if it were trustworthy.
 */
function parseScriptSteps(raw: unknown): ScriptStepReport[] | undefined {
	if (!Array.isArray(raw) || raw.length === 0) {
		return undefined;
	}
	const steps: ScriptStepReport[] = [];
	for (const entry of raw.slice(0, MAX_REPORTED_STEPS)) {
		if (typeof entry !== "object" || entry === null) {
			return undefined;
		}
		const candidate = entry as {
			index?: unknown;
			status?: unknown;
			message?: unknown;
		};
		if (
			typeof candidate.index !== "number" ||
			!Number.isInteger(candidate.index) ||
			(candidate.status !== "PASSED" && candidate.status !== "FAILED")
		) {
			return undefined;
		}
		steps.push({
			index: candidate.index,
			status: candidate.status,
			message:
				typeof candidate.message === "string"
					? candidate.message.slice(0, 2_000)
					: null,
		});
	}
	return steps;
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
			steps?: unknown;
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
			steps: parseScriptSteps(parsed.steps),
		};
	} catch {
		return null;
	}
}

/** A single evidence row, used wherever the plan was never reached — before
 * (or without) any per-step report, so there is nothing to break out. */
function singleRow(
	status: ScriptResult["status"],
	action: string,
	observation: string,
): AgenticStepResult {
	return {
		order: 1,
		action,
		expected: "Every action and assertion completes",
		status,
		observation,
		evidenceKey: null,
	};
}

/**
 * The one-row shape this activity always used before per-step reporting
 * existed. Still the right shape for a setup/sign-in failure — the plan was
 * never reached, so there is nothing to break into rows — and the fallback
 * for a runner build (or a malformed report) that did not send one.
 */
function fallbackSingleRow(result: ScriptResult): AgenticStepResult {
	return singleRow(
		result.status,
		// A BLOCKED result with no per-step report never left setup: it is
		// either opening the environment or signing in, never "running the
		// script" — the wording the old single row used regardless of status.
		result.status === "BLOCKED"
			? "Open the environment and sign in"
			: "Execute the saved declarative Playwright script",
		result.message ??
			(result.status === "PASSED"
				? "The scripted case completed successfully."
				: "The scripted case did not complete successfully."),
	);
}

/** Is `steps` a well-formed, in-order report the plan can be broken out
 * against? Anything else — empty, gappy, out of range, tampered — is treated
 * as absent rather than rendered as if it were trustworthy. */
function isUsableStepReport(
	steps: ScriptStepReport[] | undefined,
	planStepCount: number,
): steps is ScriptStepReport[] {
	return (
		steps !== undefined &&
		steps.length > 0 &&
		steps.length <= planStepCount &&
		steps.every((step, index) => step.index === index + 1)
	);
}

/**
 * One evidence row per plan action: PASSED for every step the runner
 * completed, the single FAILED step that stopped it (with its own
 * expected/received message), and SKIPPED for the rest of the plan — the
 * runner never attempted them, so the run cannot say anything happened.
 *
 * Falls back to {@link fallbackSingleRow} whenever the runner's report does
 * not line up with the plan it was given: the untrusted process's stdout
 * cannot be allowed to desync from `@repo/utils`'s own parse of the same
 * script.
 */
function buildScriptStepResults(
	result: ScriptResult,
	planSteps: QaPlaywrightScriptStep[],
): AgenticStepResult[] {
	if (!isUsableStepReport(result.steps, planSteps.length)) {
		return [fallbackSingleRow(result)];
	}
	const reported = result.steps;
	const rows: AgenticStepResult[] = [];
	let ended = false;
	for (let index = 0; index < planSteps.length; index += 1) {
		const order = index + 1;
		const planStep = planSteps[index];
		const action = describeQaScriptStep(planStep);
		const expected = expectedForQaScriptStep(planStep);
		const step = reported[index];
		if (ended || !step) {
			rows.push({
				order,
				action,
				expected,
				status: "SKIPPED",
				observation:
					"Not attempted — an earlier step in this case did not pass.",
				evidenceKey: null,
			});
			continue;
		}
		rows.push({
			order,
			action,
			expected,
			status: step.status,
			observation:
				step.message ??
				(step.status === "PASSED"
					? "Passed."
					: "The step did not complete successfully."),
			evidenceKey: null,
		});
		if (step.status !== "PASSED") {
			ended = true;
		}
	}
	return rows;
}

function blockedResult(
	input: Pick<RunScriptedCaseInput, "testCaseId" | "scriptRevisionId">,
	startedAt: number,
	message: string,
): RunAgenticCaseResult {
	const trimmedMessage = message.slice(0, 2_000);
	return {
		testCaseId: input.testCaseId,
		scriptRevisionId: input.scriptRevisionId,
		result: "BLOCKED",
		failureMessage: trimmedMessage,
		durationMs: Date.now() - startedAt,
		steps: [
			singleRow("BLOCKED", "Prepare the scripted run", trimmedMessage),
		],
		modelCalls: 0,
	};
}

// Exported (only) so its own tests can isolate and execute the pure helper
// functions it defines — see `__tests__/run-scripted-case.assertion-messages.test.ts`.
// It is never imported for anything but its text; nothing runs it directly.
export const TRUSTED_RUNNER = String.raw`
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

/** Origin + pathname only — never the query string or fragment, which a
 * refused off-origin redirect (an OAuth/SSO hop, typically) can carry a
 * \`code\`, \`state\`, or a token in. This is the only form a blocked URL is
 * ever kept in \`lastBlockedUrl\` or shown in a result message. */
function urlForDisplay(urlString) {
  try {
    const parsed = new URL(urlString);
    return parsed.origin + parsed.pathname;
  } catch {
    const cut = urlString.search(/[?#]/);
    return cut === -1 ? urlString : urlString.slice(0, cut);
  }
}

/** The plain-language explanation for a navigation that failed with
 * ERR_BLOCKED_BY_CLIENT, from the most recent off-origin request the route
 * handler itself refused — or "" when there is nothing to explain. A named
 * function so it can be isolated and tested the same way \`executeStep\` is. */
function describeBlockedNavigation(blockedUrl) {
  return blockedUrl
    ? "The page redirected to " +
        blockedUrl +
        ", outside this environment's origin — check the environment's base URL."
    : "";
}

/** Long enough to show a real value, short enough that several capped values
 * still fit the 2,000-char message cap alongside the surrounding sentences. */
const MAX_ASSERTION_VALUE_LENGTH = 300;

function truncateValue(value) {
  return value.length > MAX_ASSERTION_VALUE_LENGTH
    ? value.slice(0, MAX_ASSERTION_VALUE_LENGTH) + "…"
    : value;
}

/** A readable name for a step's target, so a failure never reports on an
 * anonymous element — e.g. \`role=button "Sign in"\` or \`label "Email"\`. */
function describeLocator(locator) {
  switch (locator.by) {
    case "role":
      return "role=" + locator.role + (locator.name ? ' "' + locator.name + '"' : "");
    case "label":
      return 'label "' + locator.value + '"';
    case "text":
      return 'text "' + locator.value + '"';
    case "placeholder":
      return 'placeholder "' + locator.value + '"';
    case "testId":
      return 'testId "' + locator.value + '"';
    default:
      return "the located element";
  }
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
        throw new Error(
          "Expected element to be visible: " + describeLocator(step.locator),
        );
      }
      return;
    case "assertText": {
      const text = await locate(page, step.locator).textContent({ timeout });
      if (!text || !text.includes(step.value)) {
        throw new Error(
          "Expected element text was not found.\nExpected substring: " +
            truncateValue(step.value) +
            "\nReceived: " +
            (text ? truncateValue(text) : "(the element had no text)"),
        );
      }
      return;
    }
    case "assertUrl": {
      const expectedUrl = sameOriginUrl(baseUrl, step.path);
      const actualUrl = page.url();
      if (actualUrl !== expectedUrl) {
        throw new Error(
          "Page URL did not match the expected path.\nExpected: " +
            expectedUrl +
            "\nReceived: " +
            actualUrl,
        );
      }
      return;
    }
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
  // The most recent off-origin request the route handler refused, so a
  // navigation that then fails with ERR_BLOCKED_BY_CLIENT can say WHICH side
  // must act: the environment redirected somewhere outside its own origin.
  let lastBlockedUrl = null;
  // One entry per plan step actually executed (PASSED, or the single FAILED
  // step that stopped the run) — never one for a step never reached. The
  // caller fills in SKIPPED rows for the remainder from the plan it already
  // has, and a BLOCKED run before the loop starts reports no steps at all.
  const steps = [];

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
        lastBlockedUrl = urlForDisplay(url.toString());
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
        steps.push({ index: index + 1, status: "PASSED", message: null });
      } catch (error) {
        const message =
          "Step " + (index + 1) + " failed: " + safeMessage(error);
        steps.push({ index: index + 1, status: "FAILED", message: message });
        throw new Error(message);
      }
    }
    return { status: "PASSED", message: null, steps: steps };
  } catch (error) {
    const message = safeMessage(error);
    const explanation =
      message.indexOf("ERR_BLOCKED_BY_CLIENT") !== -1
        ? describeBlockedNavigation(lastBlockedUrl)
        : "";
    return {
      status: stage === "test" ? "FAILED" : "BLOCKED",
      message: explanation ? message + "\n" + explanation : message,
      steps: steps,
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
	let planSteps: QaPlaywrightScriptStep[];
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
		const parsedScript = parseQaPlaywrightScript(revision.script);
		planSteps = parsedScript.steps;
		normalizedScript = JSON.stringify(parsedScript, null, 2);
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
			steps: buildScriptStepResults(parsed, planSteps),
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
