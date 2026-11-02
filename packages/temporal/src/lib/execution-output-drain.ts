import { Context } from "@temporalio/activity";

const unavailable = new WeakSet<Context>();

export function markExecutionReplayUnavailable(context: Context) {
	unavailable.add(context);
}

export function executionReplayUnavailable(context: Context) {
	return unavailable.has(context);
}

const drains = new WeakMap<Context, () => Promise<void>>();

/** Publishers register their drain without coupling activities to a transport. */
export function registerExecutionOutputDrain(
	context: Context,
	drain: () => Promise<void>,
) {
	drains.set(context, drain);
}

/** Finish buffered publication before a provider attempt or activity completes. */
export async function flushExecutionEvents(): Promise<void> {
	let context: Context;
	try {
		context = Context.current();
	} catch {
		return;
	}
	await drains.get(context)?.();
}
