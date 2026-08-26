import type { Context } from "hono";

export interface TenantContext {
	userId: string;
	organizationId: string | null;
}

export interface RouteMetadata {
	tenantContext: TenantContext;
	sandboxSessionId?: string;
	workDir?: string;
	projectContext?: Record<string, unknown>;
	delegationContext?: Record<string, unknown>;
}

/**
 * Get verified tenant context from the Hono context (set by serviceAuth middleware).
 * Falls back to the metadata body only when HMAC auth is not configured (dev mode).
 */
export function getVerifiedTenant(
	c: Context,
	bodyMetadata: RouteMetadata,
): TenantContext {
	// serviceAuth sets "tenant" on the context, but the generic Hono type doesn't know that
	const verified = (c as unknown as { get(key: string): unknown }).get(
		"tenant",
	) as TenantContext | undefined;
	if (verified?.userId) {
		return verified;
	}
	return bodyMetadata.tenantContext;
}

export function extractText(message: unknown): string {
	if (typeof message === "string") {
		return message;
	}
	if (!message || typeof message !== "object") {
		return "";
	}

	const maybeMessage = message as {
		parts?: Array<{ text?: string }>;
		content?: string;
	};
	if (typeof maybeMessage.content === "string") {
		return maybeMessage.content;
	}
	if (Array.isArray(maybeMessage.parts)) {
		return maybeMessage.parts
			.map((part) => part?.text ?? "")
			.filter(Boolean)
			.join("\n");
	}

	return "";
}

export function sseTextResponse(text: string): Response {
	const payload = `data: ${JSON.stringify({ text })}\n\n`;
	return new Response(payload, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
	});
}

export function normalizeMetadata(input: unknown): RouteMetadata {
	const metadata = (
		input && typeof input === "object" ? input : {}
	) as Record<string, unknown>;
	const tenantContext = (metadata.tenantContext ?? {}) as Record<
		string,
		unknown
	>;
	return {
		tenantContext: {
			userId:
				typeof tenantContext.userId === "string"
					? tenantContext.userId
					: "",
			organizationId:
				typeof tenantContext.organizationId === "string"
					? tenantContext.organizationId
					: null,
		},
		sandboxSessionId:
			typeof metadata.sandboxSessionId === "string"
				? metadata.sandboxSessionId
				: undefined,
		workDir:
			typeof metadata.workDir === "string" ? metadata.workDir : undefined,
		projectContext:
			metadata.projectContext &&
			typeof metadata.projectContext === "object"
				? (metadata.projectContext as Record<string, unknown>)
				: undefined,
		delegationContext:
			metadata.delegationContext &&
			typeof metadata.delegationContext === "object"
				? (metadata.delegationContext as Record<string, unknown>)
				: undefined,
	};
}
