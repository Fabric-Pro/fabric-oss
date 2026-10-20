interface ServedModelIdentity {
	provider?: string;
	model: string;
}

const servedModels = new WeakMap<object, ServedModelIdentity>();

export function recordServedModel(
	instance: object,
	identity: ServedModelIdentity,
): void {
	servedModels.set(instance, { ...identity });
}

export function servedModelIdentity(
	instance: unknown,
): ServedModelIdentity | undefined {
	return instance !== null &&
		(typeof instance === "object" || typeof instance === "function")
		? servedModels.get(instance)
		: undefined;
}
