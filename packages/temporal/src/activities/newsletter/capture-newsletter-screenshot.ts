/**
 * Capture one release-notes screenshot: sign in to the send's frozen capture
 * environment with the QA runner's browser, let the model drive to the screen
 * the image's brief names, mask personal data, and store the picture as the
 * image's review object.
 *
 * Runs on the `proposal-export` queue, whose slots bound how many Chromiums a
 * worker holds. Never throws: every failure is recorded on the image row with
 * a short reason (an empty slot in the review, or the previous picture kept),
 * so a capture can never fail the newsletter it belongs to.
 */
import { randomUUID } from "node:crypto";
import { getAIModelWithMetadata } from "@repo/ai";
import {
	completeNewsletterImageCapture,
	failNewsletterImageCapture,
	getBoundPromptForAgent,
	getNewsletterImageCaptureTarget,
	resolveEnvironmentAuth,
} from "@repo/database";
import {
	deleteNewsletterImageObjects,
	newsletterImageBucket,
	newsletterSendImagesPrefix,
} from "@repo/database/prisma/queries/projects/newsletter-image-publish";
import { logger } from "@repo/logs";
import { uploadFile } from "@repo/storage";
import { assertSafeOutboundUrlResolved } from "@repo/utils/url-security";
import {
	activityCancellationSignal,
	safeHeartbeat,
} from "../lib/activity-liveness";
import {
	captureScreenshot,
	closeBrowser,
	describeBrowserRefusal,
	describeNavigationFailure,
	explainBlockedNavigation,
	locate,
	openBrowser,
	performOperation,
	type RunnerBrowser,
	refusalForFetchError,
	resolveSameOriginUrl,
	settleNavigation,
	signInWithForm,
	snapshotPage,
} from "../qa-agentic-run/browser-driver";
import { decideWithModel } from "../qa-agentic-run/model-decision";
import { ActDecisionSchema } from "../qa-agentic-run/operation-decision";
import {
	runnerAuthFromEnvironment,
	scopedHeadersForAuth,
} from "../qa-agentic-run/runner-auth";
import {
	CAPTURE_JSON_CONTRACT,
	type CaptureDriver,
	runCaptureLoop,
} from "./screenshot-capture-loop";
import {
	CAPTURE_DEVICE_SCALE_FACTOR,
	CAPTURE_VIEWPORT,
	encodeNewsletterScreenshot,
	frameClip,
	visiblePart,
} from "./screenshot-framing";
import {
	hideOverlaysScript,
	maskPageScript,
	maskText,
	signInMaskTerms,
} from "./screenshot-masking";
import {
	ACTION_TIMEOUT_MS,
	describeCover,
	NAVIGATION_TIMEOUT_MS,
	performWithRecovery,
	watchPageActivity,
} from "./screenshot-page-settle";

/** Agent key + document type of the org-editable capture prompt. */
const NEWSLETTER_SCREENSHOT_PROMPT_AGENT = "newsletter_screenshot_capture";
const NEWSLETTER_SCREENSHOT_PROMPT_DOCUMENT_TYPE = "GENERAL";

/** A reason is one line in the review; anything longer is cut. */
const REASON_MAX = 300;

/** Steps of a capture kept for the log when it does not finish. */
const TRAIL_LOGGED = 20;

export interface CaptureNewsletterScreenshotInput {
	imageId: string;
	/** The highlight the picture illustrates, as the model reads it. */
	highlight: { title: string; description: string };
}

interface CaptureNewsletterScreenshotResult {
	ok: boolean;
	reason?: string;
}

function firstLine(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.split("\n")[0] ?? message;
}

/**
 * Log why a capture did not finish, with its last steps when the loop ran,
 * and record the reason on the image row.
 */
async function recordFailure(
	imageId: string,
	reason: string,
	trail?: readonly string[],
): Promise<CaptureNewsletterScreenshotResult> {
	const short =
		reason.length > REASON_MAX
			? `${reason.slice(0, REASON_MAX - 1)}…`
			: reason;
	logger.warn("[Newsletter] screenshot not captured", {
		imageId,
		reason: short,
		...(trail && { trail: trail.slice(-TRAIL_LOGGED) }),
	});
	try {
		await failNewsletterImageCapture({ imageId, reason: short });
	} catch (error) {
		logger.warn("[Newsletter] capture failure not recorded", {
			imageId,
			error: error instanceof Error ? error.name : "unknown",
		});
	}
	return { ok: false, reason: short };
}

/** Mask the page and every frame in it with the in-page `script`. */
async function maskPage(runner: RunnerBrowser, script: string): Promise<void> {
	await runner.page.evaluate(script);
	for (const frame of runner.page.frames()) {
		if (frame === runner.page.mainFrame()) {
			continue;
		}
		try {
			await frame.evaluate(script);
		} catch {
			// A frame that detached or refuses scripts keeps its content.
		}
	}
}

function pathOf(url: string): string {
	try {
		return new URL(url).pathname;
	} catch {
		return "(no page)";
	}
}

/**
 * The browser for one capture. Each page read waits for the page to settle
 * and hides overlays that would block clicks; a click that cannot land fails
 * fast, is retried once after Escape, and then says what covers its target;
 * each read and operation is written to `trail`, masked, so a capture that
 * gives up can be followed in the log.
 */
function browserDriver(
	runner: RunnerBrowser,
	baseUrl: string,
	maskTerms: readonly string[],
	trail: string[],
): CaptureDriver {
	const script = maskPageScript(maskTerms);
	const overlays = hideOverlaysScript();
	runner.page.setDefaultTimeout(ACTION_TIMEOUT_MS);
	runner.page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
	const activity = watchPageActivity(runner.page);
	return {
		snapshot: async () => {
			await activity.settle();
			try {
				await runner.page.evaluate(overlays);
			} catch {
				// A page mid-navigation keeps its overlays; the next read retries.
			}
			const snapshot = await snapshotPage(runner.page);
			trail.push(
				`read ${pathOf(runner.page.url())}: ${snapshot.length} characters`,
			);
			return snapshot;
		},
		currentUrl: () => runner.page.url(),
		perform: async (operation) => {
			const target =
				operation.kind === "click" || operation.kind === "fill"
					? locate(
							runner.page,
							operation.role,
							operation.name,
						).first()
					: null;
			const outcome = await performWithRecovery(
				runner.page,
				operation,
				() =>
					performOperation(
						runner.page,
						operation,
						baseUrl,
						runner.refusals,
					),
				async () => (target ? describeCover(target) : null),
			);
			trail.push(
				maskText(
					`${operation.kind} ${outcome.ok ? "done" : "failed"}: ${outcome.detail}`,
					maskTerms,
				),
			);
			return outcome;
		},
		mask: () => maskPage(runner, script),
		screenshot: async (target) => {
			if (!target) {
				return captureScreenshot(runner.page);
			}
			try {
				const { role, name } = target;
				const element = locate(runner.page, role, name).first();
				// Scrolling can render content the earlier mask never saw.
				await element.scrollIntoViewIfNeeded({ timeout: 10_000 });
				await maskPage(runner, script);
				const box = await element.boundingBox();
				const visible = box ? visiblePart(box) : null;
				if (!visible) {
					return null;
				}
				return await runner.page.screenshot({
					type: "png",
					clip: frameClip(visible),
					timeout: 10_000,
				});
			} catch {
				return null;
			}
		},
	};
}

/** Activity: capture the image `imageId` names. Never throws. */
export async function captureNewsletterScreenshotActivity(
	input: CaptureNewsletterScreenshotInput,
): Promise<CaptureNewsletterScreenshotResult> {
	const { imageId } = input;
	let runner: RunnerBrowser | null = null;
	try {
		const target = await getNewsletterImageCaptureTarget(imageId);
		if (!target) {
			// Removed, or already completed or failed: nothing to do.
			return {
				ok: false,
				reason: "The image is no longer being captured.",
			};
		}
		const environmentId = target.send.screenshotEnvironmentId;
		if (!environmentId) {
			return recordFailure(
				imageId,
				"No environment is set to capture screenshots from.",
			);
		}
		const environment = await resolveEnvironmentAuth({
			projectId: target.projectId,
			environmentId,
		});
		if (!environment) {
			return recordFailure(
				imageId,
				"The environment screenshots are captured from no longer exists.",
			);
		}
		const baseUrl = environment.baseUrl;
		const signInUrl = environment.signInUrl;
		if (signInUrl && !resolveSameOriginUrl(baseUrl, signInUrl)) {
			return recordFailure(
				imageId,
				"The environment's sign-in URL does not match its base URL.",
			);
		}
		try {
			await Promise.all(
				[
					...new Set(
						[baseUrl, signInUrl].filter((url): url is string =>
							Boolean(url),
						),
					),
				].map((url) => assertSafeOutboundUrlResolved(url)),
			);
		} catch (error) {
			return recordFailure(
				imageId,
				describeBrowserRefusal(refusalForFetchError(baseUrl, error)),
			);
		}

		const bound = await getBoundPromptForAgent({
			agentName: NEWSLETTER_SCREENSHOT_PROMPT_AGENT,
			documentType: NEWSLETTER_SCREENSHOT_PROMPT_DOCUMENT_TYPE,
			storyKind: null,
			userId: target.createdByUserId,
			organizationId: target.organizationId ?? undefined,
			projectId: target.projectId,
		});
		const instructions = bound?.version?.content?.trim();
		if (!instructions) {
			return recordFailure(
				imageId,
				"The screenshot prompt is not set up in this environment.",
			);
		}
		const brief = target.prompt?.trim() || input.highlight.title;

		const { model, metadata } = await getAIModelWithMetadata(
			{ taskType: "COMPLEX" },
			{
				userId: target.createdByUserId,
				organizationId: target.organizationId ?? undefined,
				projectId: target.projectId,
				jobType: "newsletter-screenshot",
			},
		);

		const auth = runnerAuthFromEnvironment(environment);
		const origin = new URL(baseUrl).origin;
		runner = await openBrowser({
			browser: "chromium",
			resolution: `${CAPTURE_VIEWPORT.width}x${CAPTURE_VIEWPORT.height}`,
			deviceScaleFactor: CAPTURE_DEVICE_SCALE_FACTOR,
			timeoutMs: 30_000,
			signal: activityCancellationSignal(),
			targetOrigin: origin,
			scopedHTTPHeaders: scopedHeadersForAuth(auth, origin),
		});
		safeHeartbeat({ phase: "newsletter-screenshot-sign-in", imageId });
		if (auth.kind === "FORM") {
			const signIn = await signInWithForm(
				runner.page,
				baseUrl,
				auth.username,
				auth.secret,
				signInUrl,
			);
			const refusal = explainBlockedNavigation(runner.refusals);
			if (!signIn.ok || refusal) {
				return recordFailure(
					imageId,
					refusal ?? `Sign-in failed: ${signIn.detail}`,
				);
			}
		} else {
			try {
				await runner.page.goto(baseUrl, {
					waitUntil: "domcontentloaded",
				});
				await settleNavigation(runner.page);
			} catch (error) {
				return recordFailure(
					imageId,
					explainBlockedNavigation(runner.refusals) ??
						describeNavigationFailure(baseUrl, error),
				);
			}
			const refusal = explainBlockedNavigation(runner.refusals);
			if (refusal) {
				return recordFailure(imageId, refusal);
			}
		}

		const maskTerms = signInMaskTerms(environment.username);
		const trail: string[] = [];
		const result = await runCaptureLoop(
			{ instructions, highlight: input.highlight, brief, maskTerms },
			browserDriver(runner, baseUrl, maskTerms, trail),
			(prompt) =>
				decideWithModel({
					model,
					metadata,
					schema: ActDecisionSchema,
					prompt,
					jsonContract: CAPTURE_JSON_CONTRACT,
					heartbeatDetails: {
						phase: "newsletter-screenshot",
						imageId,
					},
				}),
		);
		logger.info("[Newsletter] screenshot capture finished", {
			imageId,
			ok: result.ok,
			modelCalls: result.modelCalls,
			model: metadata?.canonicalName ?? null,
		});
		if (!result.ok) {
			return recordFailure(imageId, result.reason, trail);
		}

		const encoded = await encodeNewsletterScreenshot(result.png);
		if (!encoded) {
			return recordFailure(
				imageId,
				"The screenshot is too large to send even after compression.",
			);
		}
		const storageKey = `${newsletterSendImagesPrefix(target, target.sendId)}${randomUUID()}.jpg`;
		await uploadFile(storageKey, encoded.data, {
			bucket: newsletterImageBucket(),
			contentType: "image/jpeg",
			access: "private",
		});
		const completed = await completeNewsletterImageCapture({
			imageId,
			storageKey,
			bytes: encoded.data.length,
			width: encoded.width,
			height: encoded.height,
			altText: result.altText,
		});
		if (!completed.ok) {
			// Removed, failed or decided meanwhile: the new object is unused.
			await deleteNewsletterImageObjects([storageKey]);
			return {
				ok: false,
				reason: "The image changed while it was captured.",
			};
		}
		await deleteNewsletterImageObjects([completed.previousStorageKey]);
		return { ok: true };
	} catch (error) {
		logger.warn("[Newsletter] screenshot capture failed", {
			imageId,
			error: error instanceof Error ? error.name : "unknown",
		});
		return recordFailure(
			imageId,
			`The capture failed: ${firstLine(error)}`,
		);
	} finally {
		if (runner) {
			await closeBrowser(runner);
		}
	}
}
