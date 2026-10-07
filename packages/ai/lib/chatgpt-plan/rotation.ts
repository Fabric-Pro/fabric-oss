import {
	PlanSourceRotatedError,
	SubscriptionPlanExhaustedError,
	toSubscriptionPlanExhaustedError,
} from "@repo/agent-types/chatgpt-plan-fetch";
import { logger } from "@repo/logs";
import type { LanguageModel, LanguageModelMiddleware } from "ai";
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

export interface ChatGptPlanRotation {
	/** The source the call starts on. */
	source: PlanSourceRef;
	/** The next usable source with `exclude` ruled out, or null when none is. */
	repick: (exclude: ReadonlySet<string>) => Promise<PlanSourceRef | null>;
	/** A plan model for `source`. */
	build: (source: PlanSourceRef) => LanguageModel;
	/**
	 * Runs before the call moves to `source`; a throw (a usage limit on that
	 * account) ends the call there instead.
	 */
	beforeRotate?: (source: PlanSourceRef) => Promise<void>;
	/** Told every source the call moves to. */
	onRotated?: (source: PlanSourceRef) => void;
}

/**
 * Moves a call to the next usable plan when the one serving it is spent
 * (Fizzy #2770). Before any output the call is simply sent again on the next
 * plan — the plan fetch turns a failure before output into an error the SDK
 * does not retry — so the caller never notices. A plan that runs out after
 * output started cannot be retried in place: the stream ends with
 * `PlanSourceRotatedError` when another plan remains, for the caller (or
 * Temporal) to retry, and with `SubscriptionPlanExhaustedError` otherwise.
 * Only a spent window rotates; any other failure, a sign-in that needs
 * reconnecting above all, is final.
 */
export function createChatGptPlanRotationMiddleware(
	rotation: ChatGptPlanRotation,
): LanguageModelMiddleware {
	let current = rotation.source;
	const exclude = new Set<string>();

	const next = async (error: unknown): Promise<PlanResponsesModel | null> => {
		if (!(error instanceof SubscriptionPlanExhaustedError)) {
			return null;
		}
		exclude.add(planSourceKey(current));
		const source = await rotation.repick(exclude);
		// A source already ruled out is offered back only when nothing else is
		// left; trying it again would go round in circles.
		if (!source || exclude.has(planSourceKey(source))) {
			return null;
		}
		await rotation.beforeRotate?.(source);
		logger.info("[chatgpt-plan] Plan spent; moving the call to another", {
			from: planSourceKey(current),
			to: planSourceKey(source),
		});
		current = source;
		rotation.onRotated?.(source);
		return rotation.build(source) as unknown as PlanResponsesModel;
	};

	const endOfStream = async (
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
		await recordChatGptPlanSourceExhausted(current, spent);
		exclude.add(planSourceKey(current));
		const another = await rotation.repick(exclude).catch(() => null);
		const remains =
			another !== null && !exclude.has(planSourceKey(another));
		return {
			type: "error",
			error: remains
				? // Said to the person reading the reply; a Temporal activity
					// retries this error type on its own, whatever the words.
					new PlanSourceRotatedError(CONTINUE_ON_ANOTHER_PLAN)
				: new SubscriptionPlanExhaustedError(
						chatGptPlanExhaustedMessage(spent.resetAt),
						spent.resetAt,
					),
		} as PlanStreamPart;
	};

	return {
		specificationVersion: "v4",
		wrapGenerate: async ({ doGenerate, params }) => {
			let call: () => PromiseLike<
				Awaited<ReturnType<typeof doGenerate>>
			> = doGenerate;
			for (;;) {
				try {
					return await call();
				} catch (error) {
					const model = await next(error);
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
			let call: () => PromiseLike<Awaited<ReturnType<typeof doStream>>> =
				doStream;
			let result: Awaited<ReturnType<typeof doStream>>;
			for (;;) {
				try {
					result = await call();
					break;
				} catch (error) {
					const model = await next(error);
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
