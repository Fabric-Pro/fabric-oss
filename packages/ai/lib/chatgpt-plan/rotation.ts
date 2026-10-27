import { createHash } from "node:crypto";
import {
	PlanSourceRotatedError,
	SubscriptionPlanExhaustedError,
	toSubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
import { logger } from "@repo/logs";
import type { LanguageModel, LanguageModelMiddleware } from "ai";
import {
	capturePlanCredentials,
	type PlanCredentialsUsed,
	planCredentialUsed,
} from "./credential-capture";
import {
	chatGptPlanExhaustedMessage,
	recordChatGptPlanSourceExhausted,
} from "./exhaustion-breaker";
import type { PlanCallOptions, PlanResponsesModel } from "./provider";
import { type PlanSourceRef, planSourceKey } from "./sources";

type PlanStreamResult = Awaited<ReturnType<PlanResponsesModel["doStream"]>>;
type PlanStreamPart = PlanStreamResult["stream"] extends ReadableStream<
	infer Part
>
	? Part
	: never;

const CONTINUE_ON_ANOTHER_PLAN =
	"The ChatGPT plan ran out mid-reply. Send your message again to continue on another plan.";

const CONTINUE_ON_API_BILLING =
	"The ChatGPT plans ran out mid-reply. Send your message again to continue on your organization's API billing.";

/**
 * Every plan is spent and the organization's "Use API billing" policy takes
 * the work (Fizzy #3048).
 */
export const CHATGPT_PLAN_API_BILLING = "api-billing";

export interface ChatGptPlanRotation {
	/** The source every call starts on. */
	source: PlanSourceRef;
	/**
	 * The next usable source with `exclude` ruled out, `CHATGPT_PLAN_API_BILLING`
	 * when none is but the organization's provider takes the work, or null.
	 */
	repick: (
		exclude: ReadonlySet<string>,
	) => Promise<PlanSourceRef | typeof CHATGPT_PLAN_API_BILLING | null>;
	/** A plan model for `source`. */
	build: (source: PlanSourceRef) => LanguageModel;
	/**
	 * The organization's provider model a call moves to when `repick` answers
	 * `CHATGPT_PLAN_API_BILLING`. Without it that answer ends the call as
	 * spent, as before.
	 */
	handOff?: () => Promise<LanguageModel>;
	/**
	 * Runs before the call moves to `source`; a throw (a usage limit on that
	 * account) ends the call there instead.
	 */
	beforeRotate?: (source: PlanSourceRef) => Promise<void>;
	/** Told every source the call moves to. */
	onRotated?: (source: PlanSourceRef) => void;
}

/**
 * One call's rotation: the source serving it, the sources it spent, and the
 * sign-in each source's token came from (Fizzy #3037).
 */
interface RotationCall {
	current: PlanSourceRef;
	exclude: Set<string>;
	credentials: PlanCredentialsUsed;
}

/**
 * Moves a call to the next usable plan when the one serving it is spent
 * (Fizzy #2770). Before any output the call is simply sent again on the next
 * plan — the plan fetch turns a failure before output into an error the SDK
 * does not retry — so the caller never notices. A plan that runs out after
 * output started cannot be retried in place: the stream ends with
 * `PlanSourceRotatedError` when another plan remains, for the caller (or
 * Temporal) to retry, and with `SubscriptionPlanExhaustedError` otherwise.
 * When none remains but the organization's "Use API billing" policy takes the
 * work, a call before output moves to `handOff`'s model the same way, and one
 * after output ends with `PlanSourceRotatedError`, whose retry resolves there.
 * Only a spent window rotates; any other failure, a sign-in that needs
 * reconnecting above all, is final.
 *
 * The rotation lives for one call: a model reused across requests starts
 * each on `source` with nothing ruled out, and overlapping calls never see
 * each other's (Fizzy #3025).
 */
export function createChatGptPlanRotationMiddleware(
	rotation: ChatGptPlanRotation,
): LanguageModelMiddleware {
	const startCall = (): RotationCall => ({
		current: rotation.source,
		exclude: new Set<string>(),
		credentials: new Map(),
	});
	// Every attempt notes into the call's own record, so a refusal mid-stream
	// is bound to the sign-in that served it.
	const attempt = <T>(call: RotationCall, send: () => PromiseLike<T>) =>
		capturePlanCredentials(send, call.credentials).result;

	const next = async (
		call: RotationCall,
		error: unknown,
	): Promise<PlanResponsesModel | null> => {
		if (!(error instanceof SubscriptionPlanExhaustedError)) {
			return null;
		}
		call.exclude.add(planSourceKey(call.current));
		const source = await rotation.repick(call.exclude);
		if (source === CHATGPT_PLAN_API_BILLING) {
			if (!rotation.handOff) {
				return null;
			}
			logger.info(
				"[chatgpt-plan] Every plan spent; moving the call to API billing",
				{ from: planSourceKey(call.current) },
			);
			return (await rotation.handOff()) as unknown as PlanResponsesModel;
		}
		// A source already ruled out is offered back only when nothing else is
		// left; trying it again would go round in circles.
		if (!source || call.exclude.has(planSourceKey(source))) {
			return null;
		}
		await rotation.beforeRotate?.(source);
		logger.info("[chatgpt-plan] Plan spent; moving the call to another", {
			from: createHash("sha256")
				.update(planSourceKey(call.current))
				.digest("hex")
				.slice(0, 12),
			to: createHash("sha256")
				.update(planSourceKey(source))
				.digest("hex")
				.slice(0, 12),
		});
		call.current = source;
		rotation.onRotated?.(source);
		return rotation.build(source) as unknown as PlanResponsesModel;
	};

	const endOfStream = async (
		call: RotationCall,
		part: PlanStreamPart,
	): Promise<PlanStreamPart> => {
		if ((part as { type?: string }).type !== "error") {
			return part;
		}
		const spent = toSubscriptionPlanExhaustedError(
			(part as { error?: unknown }).error,
		);
		if (!spent) {
			return part;
		}
		await recordChatGptPlanSourceExhausted(
			call.current,
			planCredentialUsed(call.credentials, call.current),
			spent,
		);
		call.exclude.add(planSourceKey(call.current));
		const another = await rotation.repick(call.exclude).catch(() => null);
		const onApiBilling =
			another === CHATGPT_PLAN_API_BILLING &&
			rotation.handOff !== undefined;
		const remains =
			onApiBilling ||
			(another !== null &&
				another !== CHATGPT_PLAN_API_BILLING &&
				!call.exclude.has(planSourceKey(another)));
		return {
			type: "error",
			error: remains
				? // Said to the person reading the reply; a Temporal activity
					// retries this error type on its own, whatever the words.
					new PlanSourceRotatedError(
						onApiBilling
							? CONTINUE_ON_API_BILLING
							: CONTINUE_ON_ANOTHER_PLAN,
					)
				: new SubscriptionPlanExhaustedError(
						chatGptPlanExhaustedMessage(spent.resetAt),
						spent.resetAt,
					),
		} as PlanStreamPart;
	};

	return {
		specificationVersion: "v4",
		wrapGenerate: async ({ doGenerate, params }) => {
			const rotationCall = startCall();
			let call: () => PromiseLike<
				Awaited<ReturnType<typeof doGenerate>>
			> = doGenerate;
			for (;;) {
				try {
					return await attempt(rotationCall, call);
				} catch (error) {
					const model = await next(rotationCall, error);
					if (!model) {
						throw error;
					}
					// `ai` and `@ai-sdk/openai` resolve separate provider-type versions.
					call = () =>
						model.doGenerate(
							params as PlanCallOptions,
						) as unknown as ReturnType<typeof doGenerate>;
				}
			}
		},
		wrapStream: async ({ doStream, params }) => {
			const rotationCall = startCall();
			let call: () => PromiseLike<Awaited<ReturnType<typeof doStream>>> =
				doStream;
			let result: Awaited<ReturnType<typeof doStream>>;
			for (;;) {
				try {
					result = await attempt(rotationCall, call);
					break;
				} catch (error) {
					const model = await next(rotationCall, error);
					if (!model) {
						throw error;
					}
					call = () =>
						model.doStream(
							params as PlanCallOptions,
						) as unknown as ReturnType<typeof doStream>;
				}
			}
			return {
				...result,
				stream: result.stream.pipeThrough(
					new TransformStream({
						async transform(part, controller) {
							controller.enqueue(
								(await endOfStream(
									rotationCall,
									part as unknown as PlanStreamPart,
								)) as unknown as typeof part,
							);
						},
					}),
				),
			};
		},
	};
}
