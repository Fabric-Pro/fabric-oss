import { AsyncLocalStorage } from "node:async_hooks";
import type { AiCallPurpose } from "./call-purpose";

const purposeStorage = new AsyncLocalStorage<AiCallPurpose | undefined>();

/** Attribute a reused model or a shared embedding path without resolving it again. */
export function runWithAiCallPurpose<T>(
	purpose: AiCallPurpose | undefined,
	fn: () => T,
): T {
	return purposeStorage.run(purpose, fn);
}

/** Read only by usage logging; this scope does not supply routing context. */
export function currentAiCallPurpose(): AiCallPurpose | undefined {
	return purposeStorage.getStore();
}
