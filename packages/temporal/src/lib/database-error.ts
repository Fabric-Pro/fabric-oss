function property(error: unknown, key: string): unknown {
	try {
		return (error as Record<string, unknown> | null)?.[key];
	} catch {
		return undefined;
	}
}

/** A Prisma P-code, including initialization errors' `errorCode`, when present. */
function directPrismaErrorCode(error: unknown): string | null {
	for (const code of [
		property(error, "code"),
		property(error, "errorCode"),
	]) {
		if (typeof code === "string" && /^P\d{4}$/.test(code)) {
			return code;
		}
	}
	return null;
}

function isDatabaseErrorClass(name: unknown): boolean {
	return (
		typeof name === "string" &&
		(name.startsWith("PrismaClient") || name === "DriverAdapterError")
	);
}

function isDirectDatabaseError(error: unknown): boolean {
	return (
		directPrismaErrorCode(error) !== null ||
		isDatabaseErrorClass(property(error, "name"))
	);
}

/**
 * Walk native/SDK `cause` and McpClientError's `originalCause`, without reading
 * messages as provenance. Bound both depth and total work for malformed chains.
 */
function* errorCauses(error: unknown): Generator<unknown> {
	const pending = [{ error, depth: 0 }];
	const seen = new Set<unknown>();
	while (pending.length && seen.size < 32) {
		const current = pending.pop();
		if (!current || current.depth > 16 || seen.has(current.error)) {
			continue;
		}
		seen.add(current.error);
		yield current.error;
		for (const key of ["originalCause", "cause"]) {
			const cause = property(current.error, key);
			if (cause != null) {
				pending.push({ error: cause, depth: current.depth + 1 });
			}
		}
	}
}

/** A Prisma P-code on an error or its bounded native/SDK/MCP cause chain. */
export function prismaErrorCode(error: unknown): string | null {
	for (const cause of errorCauses(error)) {
		const code = directPrismaErrorCode(cause);
		if (code) {
			return code;
		}
	}
	return null;
}

/** Recognized database type/code on an error or its bounded cause chain. */
export function isDatabaseError(error: unknown): boolean {
	for (const cause of errorCauses(error)) {
		if (isDirectDatabaseError(cause)) {
			return true;
		}
	}
	return false;
}
