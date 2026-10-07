/**
 * Marks the work done inside one person's own browser request as interactive,
 * so it may run on that person's ChatGPT plan (Fizzy #2939) without every AI
 * call site having to say so.
 *
 * Set by the oRPC session middleware and by the chat and generation routes,
 * whose sessions come from browser cookies alone (an API key, an organization
 * key or an agent's bearer token never becomes one), and inside a Temporal run
 * a person started (`AiInteractiveActivityInboundInterceptor`). Nothing else
 * sets it — crons, webhooks, MCP and API-key routes, agent ai-config — so
 * those calls stay on the organization's provider.
 *
 * It also records impersonation: while an admin acts as a member, the plan
 * gate refuses the member's plan for every call, even one marked
 * plan-eligible, and no Temporal run or AI token started there is marked.
 */
import { AsyncLocalStorage } from "node:async_hooks";

interface AiInteractiveContext {
	readonly userId: string;
	/**
	 * An admin is acting as this user. Their clicks are not the user's own
	 * work, so nothing in the request may run on the user's plan — not even a
	 * call its caller marked plan-eligible.
	 */
	readonly impersonated?: boolean;
}

const interactiveStorage = new AsyncLocalStorage<AiInteractiveContext>();

export function runWithAiInteractiveContext<T>(
	context: AiInteractiveContext,
	fn: () => T,
): T {
	return interactiveStorage.run(freeze(context), fn);
}

/**
 * For a Next.js route handler, which has no wrapper to run inside: marks the
 * rest of the CURRENT handler, from this call on, as this person's request.
 * Call it in the handler's own body right after the session is read — never
 * from a helper, whose context the handler does not inherit.
 */
export function enterAiInteractiveContext(context: AiInteractiveContext): void {
	interactiveStorage.enterWith(freeze(context));
}

function freeze(context: AiInteractiveContext): AiInteractiveContext {
	return Object.freeze({
		userId: context.userId,
		impersonated: context.impersonated === true,
	});
}

/**
 * Whether this call runs inside `userId`'s own interactive request. A request
 * by one person never makes a call for another person interactive, and an
 * impersonated request is nobody's own.
 */
export function isAiInteractiveRequestFor(userId: string): boolean {
	const store = interactiveStorage.getStore();
	return store?.userId === userId && store.impersonated !== true;
}

/** Whether an admin is acting as someone in the current request. */
export function isAiImpersonatedRequest(): boolean {
	return interactiveStorage.getStore()?.impersonated === true;
}

/** The member an admin is acting as in the current request, if any. */
export function aiImpersonatedUserId(): string | undefined {
	const store = interactiveStorage.getStore();
	return store?.impersonated === true ? store.userId : undefined;
}
