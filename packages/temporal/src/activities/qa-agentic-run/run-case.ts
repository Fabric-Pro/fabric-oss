/**
 * Execute ONE Fabric-authored test case against a live environment — the
 * activity that makes "run" a verb Fabric can do, with no repo access and no
 * generated code, driving the case's own authored steps.
 *
 * The shape of one step is: look at the page, decide one small operation,
 * perform it, look again, and judge whether the step's `expected` actually held.
 * Two model calls, because the second question cannot be answered from the
 * pre-action snapshot — that is also why the cost estimate charges for two.
 *
 * **What this deliberately does NOT do:**
 * - The model never sees the credential. Sign-in is deterministic
 *   (`signInWithForm`) and the secret reaches exactly one function. A password
 *   in a prompt is a password in a model provider's logs.
 * - It never files anything. A failing case produces a FAILED result, which the
 *   ordinary ingestion path turns into a finding; promotion to a bug stays a
 *   person's action (the 2026-07-26 ruling).
 * - It never leaves the environment's origin — `performOperation` refuses.
 *
 * A step's verdict is the model's judgement, and the log says so: `observation`
 * is what it claims it saw, stored beside the screenshot so a human can disagree
 * with it. That is the honest posture for a non-deterministic runner: when a
 * Fabric-authored test goes red, "the product is broken" and "the runner
 * misread the page" are both live possibilities, and the log has to let a human
 * tell them apart.
 */

import { getAIModelWithMetadata } from "@repo/ai";
import { config } from "@repo/config";
import {
	getBoundPromptForAgent,
	recordRunEvidence,
	resolveEnvironmentAuth,
} from "@repo/database";
import { logger } from "@repo/logs";
import { buildTenantStoragePath, uploadFile } from "@repo/storage";
import { assertSafeOutboundUrlResolved } from "@repo/utils/url-security";
import { NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { safeHeartbeat } from "../lib/activity-liveness";
import {
	type BrowserOperation,
	captureScreenshot,
	closeBrowser,
	openBrowser,
	performOperation,
	type RunnerBrowser,
	resolveSameOriginUrl,
	signInWithForm,
	snapshotPage,
} from "./browser-driver";
import { decideWithModel, describeModelFailure } from "./model-decision";

/** Agent key + document type for the (org-editable) runner prompt. */
export const AGENTIC_RUNNER_PROMPT_AGENT = "qa_agentic_runner";
export const AGENTIC_RUNNER_PROMPT_DOCUMENT_TYPE = "GENERAL";

/**
 * Bucket evidence lands in — read from the shared config, NOT a local env var,
 * so the writer here and the signed-URL reader in the API cannot drift onto two
 * different buckets and turn every screenshot into a 404.
 */
const EVIDENCE_BUCKET = config.storage.bucketNames.qaRunEvidence;

/**
 * Hard ceiling on operations per case, independent of the cost cap.
 *
 * The cost cap bounds the BILL; this bounds the WALL CLOCK. A case whose step
 * the model can never satisfy would otherwise retry until the activity's timeout
 * kills it mid-run, losing the log of everything that already worked.
 */
const MAX_OPERATIONS_PER_CASE = 40;

export type AgenticStepStatusValue =
	| "PASSED"
	| "FAILED"
	| "BLOCKED"
	| "SKIPPED"
	| "NEEDS_REVIEW";

export interface AgenticCaseStepInput {
	order: number;
	action: string;
	expected: string;
}

export interface RunAgenticCaseInput {
	projectId: string;
	organizationId: string | null;
	userId: string;
	testCaseId: string;
	identifier: string;
	title: string;
	description: string | null;
	steps: AgenticCaseStepInput[];
	targetBaseUrl: string;
	scriptRevisionId?: string | null;
	environmentId?: string | null;
	environmentSnapshot?: {
		signInUrl: string | null;
		authKind: "NONE" | "FORM" | "TOKEN" | "HEADER";
		authUsername: string | null;
		authHeaderName: string | null;
	};
	/**
	 * Where the sign-in form lives, when it is not at `targetBaseUrl`. Null keeps
	 * the original behaviour: the form is expected at the base URL.
	 */
	signInUrl?: string | null;
	browser: string;
	resolution: string;
	/** SCREENSHOT_REQUIRED | OPTIONAL | NONE — from the project's QA policy. */
	evidencePolicy: string;
	/**
	 * Minimum model confidence (0–100) a step's verdict must carry to be recorded,
	 * from the project's QA policy. `0` disables the gate. Optional so a caller
	 * that predates the field behaves as it did — as `0`.
	 */
	confidenceThreshold?: number;
	/**
	 * The run this case belongs to, carried so stored evidence can be traced back
	 * to it. Optional: the key format has never contained a run id, so a caller
	 * that does not know one still stores evidence — it just records an empty
	 * attribution rather than refusing.
	 */
	runId?: string | null;
	/** Free-text house rules the policy carries, appended to the prompt. */
	houseRules: string | null;
	auth?:
		| { kind: "NONE" }
		| { kind: "FORM"; username: string; secret: string }
		| { kind: "TOKEN"; secret: string }
		| { kind: "HEADER"; headerName: string; secret: string };
}

type RunnerAuth = NonNullable<RunAgenticCaseInput["auth"]>;

function runnerAuthFromEnvironment(
	environment: Awaited<ReturnType<typeof resolveEnvironmentAuth>>,
): RunnerAuth {
	if (
		!environment ||
		environment.authKind === "NONE" ||
		!environment.secret
	) {
		return { kind: "NONE" };
	}
	if (environment.authKind === "FORM") {
		return environment.username
			? {
					kind: "FORM",
					username: environment.username,
					secret: environment.secret,
				}
			: { kind: "NONE" };
	}
	if (environment.authKind === "TOKEN") {
		return { kind: "TOKEN", secret: environment.secret };
	}
	if (environment.authKind === "HEADER" && environment.headerName) {
		return {
			kind: "HEADER",
			headerName: environment.headerName,
			secret: environment.secret,
		};
	}
	return { kind: "NONE" };
}

async function resolveCaseEnvironment(input: RunAgenticCaseInput): Promise<{
	targetBaseUrl: string;
	signInUrl: string | null;
	auth: RunnerAuth;
} | null> {
	if (!input.environmentId) {
		return {
			targetBaseUrl: input.targetBaseUrl,
			signInUrl: input.signInUrl ?? null,
			auth: input.auth ?? { kind: "NONE" },
		};
	}

	const environment = await resolveEnvironmentAuth({
		projectId: input.projectId,
		environmentId: input.environmentId,
	});
	if (!environment) {
		return null;
	}
	if (input.environmentSnapshot) {
		const snapshot = input.environmentSnapshot;
		if (
			environment.authKind !== snapshot.authKind ||
			environment.username !== snapshot.authUsername ||
			environment.headerName !== snapshot.authHeaderName
		) {
			return null;
		}
		return {
			targetBaseUrl: input.targetBaseUrl,
			signInUrl: snapshot.signInUrl,
			auth: runnerAuthFromEnvironment(environment),
		};
	}
	return {
		targetBaseUrl: environment.baseUrl,
		signInUrl: environment.signInUrl,
		auth: runnerAuthFromEnvironment(environment),
	};
}

export interface AgenticStepResult {
	order: number;
	action: string;
	expected: string;
	status: AgenticStepStatusValue;
	observation: string | null;
	evidenceKey: string | null;
}

export interface RunAgenticCaseResult {
	testCaseId: string;
	/** Immutable Mode B artifact used for this result; null for Mode A. */
	scriptRevisionId?: string | null;
	/** PASSED | FAILED | BLOCKED | NEEDS_REVIEW — the case-level verdict. */
	result: "PASSED" | "FAILED" | "BLOCKED" | "NEEDS_REVIEW";
	failureMessage: string | null;
	durationMs: number;
	steps: AgenticStepResult[];
	/** Model calls actually made, so the run can bill what it spent. */
	modelCalls: number;
}

/**
 * Lenient on purpose — `kind` and the target are plain strings, not enums.
 *
 * A strict `z.enum` turns "Click" or "CLICK" into a schema-rejection retry loop
 * and, on a model that keeps missing, an outright activity failure. Normalised
 * below, where anything unrecognised becomes `none` — which is a safe answer,
 * because it touches nothing and lets the assessment call decide the step.
 */
const ActDecisionSchema = z.object({
	kind: z.string().optional(),
	role: z.string().optional(),
	name: z.string().optional(),
	text: z.string().optional(),
	key: z.string().optional(),
	path: z.string().optional(),
	ms: z.number().optional(),
	reasoning: z.string().optional(),
});

const AssessDecisionSchema = z.object({
	met: z.boolean().optional(),
	observation: z.string().optional(),
	/**
	 * How sure the model is of `met`, 0–100.
	 *
	 * Optional like everything else here, and its absence is NOT read as zero:
	 * "I did not say how sure I was" and "I was not sure" are different answers,
	 * and a provider that drops the field would otherwise send every step of every
	 * project to review at once. See {@link stepStatusFor}.
	 */
	confidence: z.number().optional(),
});

/**
 * Spelled-out JSON contracts, used ONLY when a deployment ignored the schema and
 * answered in prose (see `model-decision.ts`). They describe the same shapes as
 * the schemas above in words, because the fallback's whole premise is a provider
 * that did not read the schema.
 *
 * Kept beside the schemas rather than in the org-editable prompt: an admin
 * editing how strictly their team judges an expectation must not be able to
 * break the wire format the runner parses.
 */
const ACT_JSON_CONTRACT = [
	"Reply with a single JSON object and nothing else — no prose, no markdown fence.",
	'Keys, all optional: "kind" (one of click, fill, press, goto, wait, none),',
	'"role", "name", "text", "key", "path", "ms" (a number), "reasoning".',
].join(" ");

const ASSESS_JSON_CONTRACT = [
	"Reply with a single JSON object and nothing else — no prose, no markdown fence.",
	'Keys, all optional: "met" (true or false), "observation" (one or two sentences),',
	'"confidence" (a number from 0 to 100 — how sure you are of "met", where 100 is',
	"certain and anything below 50 means you are guessing).",
].join(" ");

/** How much of the model's raw reply to keep in the log line. */
const RAW_REPLY_LOG_LIMIT = 2_000;

/**
 * The fields that actually explain a `generateObject` failure.
 *
 * Its message is the same sentence — "No object generated: could not parse the
 * response" — whether the model answered in prose, ran out of tokens midway
 * through valid JSON, or returned nothing at all. Those are three different
 * fixes, and `NoObjectGeneratedError` is the only thing that tells them apart:
 * `finishReason` separates a length cap from a format problem, `usage` settles
 * whether the prompt was too big, and `text` is what the model actually said.
 *
 * Every one of these was being discarded, which is why the first real runs on
 * staging could not be diagnosed from their own logs.
 *
 * Exported for its own tests — the whole value of this function is the payload it
 * produces, so that is what gets asserted.
 */
export function modelFailureDetail(err: unknown): Record<string, unknown> {
	if (!NoObjectGeneratedError.isInstance(err)) {
		return { errorKind: err instanceof Error ? err.name : typeof err };
	}
	return {
		errorKind: "NoObjectGeneratedError",
		finishReason: err.finishReason ?? null,
		usage: err.usage ?? null,
		rawReplyLength: err.text?.length ?? 0,
		// Truncated: a full page-shaped reply would swamp the line, and the head
		// is enough to see whether it is JSON, prose, or empty.
		rawReply: err.text?.slice(0, RAW_REPLY_LOG_LIMIT) ?? null,
	};
}

/** Map whatever the model said onto the closed operation set. */
export function normaliseOperation(
	raw: z.infer<typeof ActDecisionSchema>,
): BrowserOperation {
	const kind = (raw.kind ?? "").trim().toLowerCase();
	switch (kind) {
		case "click":
			return raw.role && raw.name
				? { kind: "click", role: raw.role, name: raw.name }
				: { kind: "none" };
		case "fill":
		case "type":
			return raw.role && raw.name
				? {
						kind: "fill",
						role: raw.role,
						name: raw.name,
						text: raw.text ?? "",
					}
				: { kind: "none" };
		case "press":
			return raw.key ? { kind: "press", key: raw.key } : { kind: "none" };
		case "goto":
		case "navigate":
			return raw.path
				? { kind: "goto", path: raw.path }
				: { kind: "none" };
		case "wait":
			return { kind: "wait", ms: raw.ms ?? 1000 };
		default:
			return { kind: "none" };
	}
}

/**
 * The org-editable instructions. Null when unseeded — the caller turns that into
 * a refusal rather than running from an inlined prompt no admin can see, the
 * same stance `analyse-test-failure.ts` takes.
 */
export async function resolveRunnerInstructions(tenant: {
	userId: string;
	organizationId?: string | null;
}): Promise<string | null> {
	const bound = await getBoundPromptForAgent({
		agentName: AGENTIC_RUNNER_PROMPT_AGENT,
		documentType: AGENTIC_RUNNER_PROMPT_DOCUMENT_TYPE,
		storyKind: null,
		userId: tenant.userId,
		organizationId: tenant.organizationId ?? undefined,
	});
	const content = bound?.version?.content?.trim();
	return content && content.length > 0 ? content : null;
}

/**
 * Read whatever number the model called "confidence" as a 0–100 percentage.
 *
 * Two conventions are in the wild and the prompt cannot stop a model picking the
 * other one: 0–100 (what we ask for) and 0–1. Reading `0.9` literally against a
 * threshold of 80 would send a *confident* step to review, so a value in (0, 1]
 * is scaled up.
 *
 * `1` is genuinely ambiguous — "1%" or "certain". It is read as certain, which
 * fails toward recording the verdict, i.e. toward the behaviour before this gate
 * existed. The opposite reading would let one ambiguous value quietly flag a
 * project's whole suite.
 *
 * Returns null for anything unusable, which the caller treats as "not reported"
 * rather than as zero.
 */
export function normaliseConfidence(raw: number | undefined): number | null {
	if (raw === undefined || !Number.isFinite(raw) || raw < 0) {
		return null;
	}
	const scaled = raw > 0 && raw <= 1 ? raw * 100 : raw;
	return Math.min(100, scaled);
}

/**
 * The status one step earns, given what the runner did and how sure the model was.
 *
 * Exported for its own tests: this is the whole of the confidence gate, and the
 * cases that matter are the ones where it must NOT fire.
 */
export function stepStatusFor(input: {
	/** Whether the browser operation itself succeeded (`outcome.ok`). */
	performed: boolean;
	met: boolean;
	/** 0–100, or null when the model did not report one. */
	confidence: number | null;
	/** 0 disables the gate. */
	threshold: number;
}): AgenticStepStatusValue {
	// An operation that could not be performed is BLOCKED, not FAILED. "The button
	// was not there" and "the button was there and did the wrong thing" are
	// different findings, and collapsing them is how a broken runner gets reported
	// as a broken product. This outranks confidence: there is no judgement to be
	// unsure about when nothing was done.
	if (!input.performed) {
		return "BLOCKED";
	}
	// A model that reported nothing keeps its verdict. Treating silence as zero
	// would mean one provider dropping an optional field sends every step of every
	// project to review — a far worse failure than the gate not firing.
	if (
		input.threshold > 0 &&
		input.confidence !== null &&
		input.confidence < input.threshold
	) {
		return "NEEDS_REVIEW";
	}
	return input.met ? "PASSED" : "FAILED";
}

function shouldCapture(evidencePolicy: string, status: AgenticStepStatusValue) {
	if (evidencePolicy === "NONE") {
		return false;
	}
	if (evidencePolicy === "SCREENSHOT_REQUIRED") {
		return true;
	}
	// OPTIONAL: capture only where a screenshot earns its storage — the steps
	// somebody will actually open. A step awaiting review is exactly such a step:
	// the person it is waiting for needs to see what the model could not settle.
	return (
		status === "FAILED" || status === "BLOCKED" || status === "NEEDS_REVIEW"
	);
}

async function storeEvidence(input: {
	projectId: string;
	organizationId: string | null;
	userId: string;
	runId: string | null;
	testCaseId: string;
	stepOrder: number;
	png: Buffer;
}): Promise<string | null> {
	const key = buildTenantStoragePath({
		organizationId: input.organizationId,
		userId: input.userId,
		sub: `qa-runs/${input.projectId}/${input.testCaseId}/step-${input.stepOrder}-${Date.now()}.png`,
	});
	try {
		await uploadFile(key, input.png, {
			bucket: EVIDENCE_BUCKET,
			contentType: "image/png",
			// Private: a screenshot of a signed-in page can contain anything the
			// customer's app shows. Read back through a short-lived signed URL.
			access: "private",
		});
		// Register it so the retention sweep can find it later.
		//
		// AFTER the upload, never before: a ledger row for an object that failed
		// to store would make the sweep report a deletion error forever. The
		// reverse order — object without a row — is the one this whole table
		// exists to prevent, so the write is guarded rather than skipped.
		try {
			await recordRunEvidence({
				bucket: EVIDENCE_BUCKET,
				storageKey: key,
				projectId: input.projectId,
				runId: input.runId ?? "",
				testCaseId: input.testCaseId,
				stepOrder: input.stepOrder,
				organizationId: input.organizationId,
				userId: input.userId,
			});
		} catch (err) {
			// An unswept object is a storage bill; a failed test run is a person's
			// afternoon. Logged loudly because it is the one way an orphan can
			// still appear, and the reconciliation job needs to know it happens.
			logger.warn("qa.agentic_run.evidence_ledger_write_failed", {
				projectId: input.projectId,
				testCaseId: input.testCaseId,
				storageKey: key,
				error: err instanceof Error ? err.message : String(err),
			});
		}
		return key;
	} catch (err) {
		// Evidence is desirable, never load-bearing. A storage outage must not
		// turn a passing test red.
		logger.warn("qa.agentic_run.evidence_upload_failed", {
			projectId: input.projectId,
			testCaseId: input.testCaseId,
			error: err instanceof Error ? err.message : String(err),
		});
		return null;
	}
}

/**
 * Activity: run one case end to end. Always returns a verdict — a thrown
 * activity would lose the log of every step that already ran, and the steps are
 * the product here.
 */
export async function runAgenticCase(
	input: RunAgenticCaseInput,
): Promise<RunAgenticCaseResult> {
	const startedAt = Date.now();
	const steps: AgenticStepResult[] = [];
	let modelCalls = 0;
	// Clamped here rather than trusted from the caller: this is the only place the
	// number decides anything, and a stored value outside 0–100 (or absent, from a
	// caller written before the field) must not silently disable or invert the gate.
	const threshold = Math.min(
		100,
		Math.max(0, input.confidenceThreshold ?? 0),
	);

	const runtimeEnvironment = await resolveCaseEnvironment(input);
	if (!runtimeEnvironment) {
		return {
			testCaseId: input.testCaseId,
			result: "BLOCKED",
			failureMessage:
				"The selected environment no longer exists, so no run was attempted.",
			durationMs: Date.now() - startedAt,
			steps: [],
			modelCalls: 0,
		};
	}
	const { targetBaseUrl, signInUrl, auth } = runtimeEnvironment;
	if (signInUrl && !resolveSameOriginUrl(targetBaseUrl, signInUrl)) {
		return {
			testCaseId: input.testCaseId,
			result: "BLOCKED",
			failureMessage:
				"The environment sign-in URL no longer matches its base URL.",
			durationMs: Date.now() - startedAt,
			steps: [],
			modelCalls: 0,
		};
	}
	try {
		await Promise.all(
			[
				...new Set(
					[targetBaseUrl, signInUrl].filter((url): url is string =>
						Boolean(url),
					),
				),
			].map((url) => assertSafeOutboundUrlResolved(url)),
		);
	} catch {
		return {
			testCaseId: input.testCaseId,
			result: "BLOCKED",
			failureMessage:
				"The environment URL does not resolve to a public address.",
			durationMs: Date.now() - startedAt,
			steps: [],
			modelCalls: 0,
		};
	}

	const instructions = await resolveRunnerInstructions({
		userId: input.userId,
		organizationId: input.organizationId,
	});
	if (!instructions) {
		return {
			testCaseId: input.testCaseId,
			result: "BLOCKED",
			failureMessage:
				"The QA runner prompt is not seeded in this environment, so no run was attempted.",
			durationMs: Date.now() - startedAt,
			steps: [],
			modelCalls: 0,
		};
	}

	const { model, metadata } = await getAIModelWithMetadata(
		{ taskType: "COMPLEX" },
		{
			userId: input.userId,
			organizationId: input.organizationId ?? undefined,
		},
	);
	logger.info("qa.agentic_run.case_started", {
		projectId: input.projectId,
		testCaseId: input.testCaseId,
		// The URL is logged; the credential is not, and there is no branch here
		// that could change that.
		targetBaseUrl,
		model: metadata?.canonicalName ?? null,
		stepCount: input.steps.length,
	});

	let runner: RunnerBrowser | null = null;
	try {
		runner = await openBrowser({
			browser: input.browser,
			resolution: input.resolution,
			timeoutMs: 30_000,
			targetOrigin: new URL(targetBaseUrl).origin,
			scopedHTTPHeaders:
				auth.kind === "TOKEN"
					? {
							origin: new URL(targetBaseUrl).origin,
							headers: { Authorization: `Bearer ${auth.secret}` },
						}
					: auth.kind === "HEADER"
						? {
								origin: new URL(targetBaseUrl).origin,
								headers: { [auth.headerName]: auth.secret },
							}
						: undefined,
		});

		// --- Sign in ---------------------------------------------------------
		if (auth.kind === "FORM") {
			const signIn = await signInWithForm(
				runner.page,
				targetBaseUrl,
				auth.username,
				auth.secret,
				signInUrl,
			);
			if (!signIn.ok) {
				return {
					testCaseId: input.testCaseId,
					result: "BLOCKED",
					failureMessage: `Sign-in failed: ${signIn.detail}`,
					durationMs: Date.now() - startedAt,
					steps: [],
					modelCalls,
				};
			}
		} else {
			try {
				await runner.page.goto(targetBaseUrl, {
					waitUntil: "domcontentloaded",
				});
			} catch (err) {
				return {
					testCaseId: input.testCaseId,
					result: "BLOCKED",
					failureMessage: `Could not open ${targetBaseUrl}: ${
						err instanceof Error ? err.message : String(err)
					}`,
					durationMs: Date.now() - startedAt,
					steps: [],
					modelCalls,
				};
			}
		}

		// --- Walk the steps ---------------------------------------------------
		const caseContext = [
			`TEST CASE ${input.identifier}: ${input.title}`,
			input.description
				? `Preconditions / notes: ${input.description}`
				: null,
			input.houseRules ? `\nHOUSE RULES:\n${input.houseRules}` : null,
		]
			.filter((l): l is string => l !== null)
			.join("\n");

		let ended = false;
		let operations = 0;

		for (const step of input.steps) {
			if (ended) {
				steps.push({
					order: step.order,
					action: step.action,
					expected: step.expected,
					status: "SKIPPED",
					observation:
						"Not attempted — an earlier step in this case did not pass.",
					evidenceKey: null,
				});
				continue;
			}

			safeHeartbeat({
				phase: "qa-agentic-step",
				testCaseId: input.testCaseId,
				step: step.order,
			});

			if (operations >= MAX_OPERATIONS_PER_CASE) {
				steps.push({
					order: step.order,
					action: step.action,
					expected: step.expected,
					status: "BLOCKED",
					observation: `Stopped after ${MAX_OPERATIONS_PER_CASE} operations in this case — the run was taking more actions than a case of this size should need.`,
					evidenceKey: null,
				});
				ended = true;
				continue;
			}

			// 1. Decide.
			const before = await snapshotPage(runner.page);
			let operation: BrowserOperation = { kind: "none" };
			const actPrompt = [
				instructions,
				"",
				caseContext,
				"",
				`STEP ${step.order}`,
				`Action to perform: ${step.action}`,
				`Expected outcome: ${step.expected}`,
				"",
				"PAGE (ARIA snapshot):",
				before,
			].join("\n");
			try {
				const decision = await decideWithModel({
					model,
					metadata,
					schema: ActDecisionSchema,
					prompt: actPrompt,
					jsonContract: ACT_JSON_CONTRACT,
					heartbeatDetails: {
						phase: "qa-agentic-act",
						testCaseId: input.testCaseId,
						step: step.order,
					},
				});
				modelCalls += decision.calls;
				operation = normaliseOperation(decision.value);
				if (decision.via === "text") {
					// Worth a line of its own: it means the deployment ignored the
					// schema request and the run only worked because of the
					// fallback. Silent recovery would hide a provider
					// misconfiguration behind a passing test.
					logger.warn("qa.agentic_run.model_call_recovered", {
						projectId: input.projectId,
						testCaseId: input.testCaseId,
						stepOrder: step.order,
						phase: "act",
						model: metadata?.canonicalName ?? null,
					});
				}
			} catch (err) {
				// Logged as well as reported: the step observation is what a person
				// reads, but it carries only the message — which is identical for
				// every cause. Without this the failure is undiagnosable from
				// production, as the first staging runs proved.
				logger.warn("qa.agentic_run.model_call_failed", {
					projectId: input.projectId,
					testCaseId: input.testCaseId,
					stepOrder: step.order,
					phase: "act",
					model: metadata?.canonicalName ?? null,
					promptChars: actPrompt.length,
					error: err instanceof Error ? err.message : String(err),
					...modelFailureDetail(err),
				});
				// A model outage ends the CASE, not the whole run — the other
				// cases may still be runnable, and a partial run with an honest
				// blocked case beats no results at all.
				steps.push({
					order: step.order,
					action: step.action,
					expected: step.expected,
					status: "BLOCKED",
					// Names the cause rather than repeating the SDK's one-size
					// sentence: whoever is testing reads this, not the logs.
					observation: `The model could not decide this step — ${describeModelFailure(err)}`,
					evidenceKey: null,
				});
				ended = true;
				continue;
			}

			// 2. Do it.
			const outcome = await performOperation(
				runner.page,
				operation,
				targetBaseUrl,
			);
			operations++;

			// 3. Judge the result against `expected`, from the page as it now is.
			const after = await snapshotPage(runner.page);
			let met = false;
			let confidence: number | null = null;
			let observation = outcome.detail;
			const assessPrompt = [
				instructions,
				"",
				caseContext,
				"",
				`STEP ${step.order}`,
				`Action that was performed: ${step.action}`,
				`What the runner did: ${outcome.detail}`,
				`Expected outcome: ${step.expected}`,
				"",
				"Decide whether the expected outcome is TRUE of the page below.",
				"",
				"PAGE (ARIA snapshot):",
				after,
			].join("\n");
			try {
				const decision = await decideWithModel({
					model,
					metadata,
					schema: AssessDecisionSchema,
					prompt: assessPrompt,
					jsonContract: ASSESS_JSON_CONTRACT,
					heartbeatDetails: {
						phase: "qa-agentic-assess",
						testCaseId: input.testCaseId,
						step: step.order,
					},
				});
				modelCalls += decision.calls;
				met = decision.value.met === true;
				confidence = normaliseConfidence(decision.value.confidence);
				observation = decision.value.observation?.trim()
					? `${outcome.detail} ${decision.value.observation.trim()}`
					: outcome.detail;
				if (confidence === null && threshold > 0) {
					// The gate is on and this model is not answering the question.
					// Logged rather than enforced: the verdict still stands (see
					// `stepStatusFor`), and this is the only way to find out that a
					// project's threshold is quietly doing nothing.
					logger.warn(
						"qa.agentic_run.assessment_confidence_missing",
						{
							projectId: input.projectId,
							testCaseId: input.testCaseId,
							stepOrder: step.order,
							model: metadata?.canonicalName ?? null,
							threshold,
							via: decision.via,
						},
					);
				}
				if (decision.via === "text") {
					logger.warn("qa.agentic_run.model_call_recovered", {
						projectId: input.projectId,
						testCaseId: input.testCaseId,
						stepOrder: step.order,
						phase: "assess",
						model: metadata?.canonicalName ?? null,
					});
				}
			} catch (err) {
				logger.warn("qa.agentic_run.model_call_failed", {
					projectId: input.projectId,
					testCaseId: input.testCaseId,
					stepOrder: step.order,
					phase: "assess",
					model: metadata?.canonicalName ?? null,
					promptChars: assessPrompt.length,
					error: err instanceof Error ? err.message : String(err),
					...modelFailureDetail(err),
				});
				met = false;
				// Zero, not null: a model that could not answer at all is the least
				// certain outcome there is. With a threshold set this becomes
				// NEEDS_REVIEW rather than a FAILED verdict the model never gave —
				// which is what this branch used to record. With the gate off it
				// still reports FAILED, exactly as before.
				confidence = 0;
				observation = `${outcome.detail} The model could not assess this step — ${describeModelFailure(err)}`;
			}

			const status = stepStatusFor({
				performed: outcome.ok,
				met,
				confidence,
				threshold,
			});

			let evidenceKey: string | null = null;
			if (shouldCapture(input.evidencePolicy, status)) {
				const png = await captureScreenshot(runner.page);
				if (png) {
					evidenceKey = await storeEvidence({
						projectId: input.projectId,
						organizationId: input.organizationId,
						userId: input.userId,
						runId: input.runId ?? null,
						testCaseId: input.testCaseId,
						stepOrder: step.order,
						png,
					});
				}
			}

			steps.push({
				order: step.order,
				action: step.action,
				expected: step.expected,
				status,
				observation,
				evidenceKey,
			});

			if (status !== "PASSED") {
				ended = true;
			}
		}

		// At most one of these exists — the loop stops the case at the first step
		// that is not PASSED — so the order below is a statement of precedence for
		// readers rather than a tie-break the runner can actually reach.
		const failed = steps.find((s) => s.status === "FAILED");
		const blocked = steps.find((s) => s.status === "BLOCKED");
		const needsReview = steps.find((s) => s.status === "NEEDS_REVIEW");
		const result = failed
			? "FAILED"
			: blocked
				? "BLOCKED"
				: needsReview
					? "NEEDS_REVIEW"
					: "PASSED";

		return {
			testCaseId: input.testCaseId,
			result,
			failureMessage: failed
				? `Step ${failed.order} — expected: ${failed.expected}\nObserved: ${failed.observation ?? "(no observation recorded)"}`
				: blocked
					? `Step ${blocked.order} could not be attempted: ${blocked.observation ?? "(no observation recorded)"}`
					: needsReview
						? `Step ${needsReview.order} was judged with too little confidence to record a verdict — expected: ${needsReview.expected}\nObserved: ${needsReview.observation ?? "(no observation recorded)"}`
						: null,
			durationMs: Date.now() - startedAt,
			steps,
			modelCalls,
		};
	} catch (err) {
		// The browser itself died (no binary in the image, OOM, crash). Reported
		// as BLOCKED with the reason rather than thrown: a thrown activity is
		// retried by Temporal, and retrying a missing browser just burns the
		// retry budget to reach the same answer more slowly.
		logger.error("qa.agentic_run.case_crashed", {
			projectId: input.projectId,
			testCaseId: input.testCaseId,
			error: err instanceof Error ? err.message : String(err),
		});
		return {
			testCaseId: input.testCaseId,
			result: "BLOCKED",
			failureMessage: `The runner could not drive a browser: ${
				err instanceof Error ? err.message : String(err)
			}`,
			durationMs: Date.now() - startedAt,
			steps,
			modelCalls,
		};
	} finally {
		if (runner) {
			await closeBrowser(runner);
		}
	}
}
