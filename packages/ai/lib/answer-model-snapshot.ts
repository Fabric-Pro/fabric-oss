import { createHash } from "node:crypto";
import type { AIProvider } from "@repo/database";
import type { ChatGptPlanReasoningEffort } from "./chatgpt-plan/models";
import { type PlanSourceRef, planSourceKey } from "./chatgpt-plan/sources";

/** Serializable routing identity. Credentials and endpoint URLs stay in activities. */
export interface AnswerModelSnapshot {
	provider: AIProvider;
	modelString: string;
	canonicalName: string;
	configId: string | null;
	configSource: "user" | "organization" | null;
	routeHash: string;
	/**
	 * Informational, and kept for workers from before Fizzy #3381. The pinned
	 * route takes the deployment from the live config; `routeHash` includes the
	 * deployment, so the guard ties that live value to this snapshot.
	 */
	deploymentName?: string | null;
	maxOutputTokens?: number;
	contextWindow?: number;
	serviceTier?: "flex";
	personalKeyFallback?: true;
	planSource?: PlanSourceRef;
	reasoningEffort?: ChatGptPlanReasoningEffort;
	fallbackModel?: string | null;
	/** A second unusable configuration stops instead of repeatedly resolving. */
	reResolved?: true;
}
export interface AnswerRouteChange {
	cause:
		| "model_unavailable"
		| "plan_account_rotation"
		| "plan_model_fallback"
		| "api_billing_handoff";
	reason:
		| "configuration_unavailable"
		| "provider_refused"
		| "account_ineligible"
		| "plan_exhausted"
		| "model_not_served";
	from: string;
	to: string;
}
export function answerRouteHash(route: {
	provider: string | null;
	configId: string | null;
	baseUrl: string | null;
	deploymentName: string | null;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify([
				route.provider,
				route.configId,
				route.baseUrl,
				route.deploymentName,
			]),
		)
		.digest("hex");
}
export function answerRouteFingerprint(route: AnswerModelSnapshot): string {
	return createHash("sha256")
		.update(
			route.planSource
				? planSourceKey(route.planSource)
				: `${route.provider}:${route.routeHash}:${route.modelString}`,
		)
		.digest("hex")
		.slice(0, 12);
}
export class AnswerModelUnavailableError extends Error {
	constructor() {
		super("The answer's model configuration is no longer available.");
		this.name = "AnswerModelUnavailableError";
	}
}
export function isUnusableAnswerModel(error: unknown): boolean {
	const e = error as {
		statusCode?: number;
		status?: number;
		code?: string;
		cause?: unknown;
		name?: string;
	} | null;
	return (
		error instanceof AnswerModelUnavailableError ||
		e?.name === "ChatGptPlanModelNotServedError" ||
		(!!e &&
			([401, 403, 404].includes(e.statusCode ?? e.status ?? 0) ||
				[
					"model_not_found",
					"invalid_api_key",
					"model_disabled",
				].includes(e.code ?? "") ||
				(!!e.cause &&
					e.cause !== error &&
					isUnusableAnswerModel(e.cause))))
	);
}
