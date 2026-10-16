"use client";

import { PAGE_FRAME_HEADER } from "@repo/temporal/fabric-page-tool-definitions";
import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { type UseQueryOptions, useQuery } from "@tanstack/react-query";
import { z } from "zod";

/**
 * Browser client for Fabric's MCP gateway. The UI calls the same tools an agent
 * calls — `tools/call` on `/api/mcp-gateway`, authenticated by the session
 * cookie — so a page needs no second API for anything a tool already does.
 *
 * Every call names the organization of the page it is made from
 * (`x-organization-id`). The session's own active organization is one value
 * shared by every tab, so a call that relied on it would run in whichever
 * organization another tab touched last.
 *
 * A call the host makes for a page's script also names that page
 * (`x-fabric-page-frame`), which lets the gateway hold it to what the page
 * declared. Only the host sets it; the page has no network to set it with.
 */

const GATEWAY_PATH = "/api/mcp-gateway";
const ORGANIZATION_HEADER = "x-organization-id";

const ToolCallResultSchema = z.object({
	content: z
		.array(z.object({ type: z.string(), text: z.string().optional() }))
		.optional(),
	isError: z.boolean().optional(),
	structuredContent: z.unknown().optional(),
});
type ToolCallResult = z.infer<typeof ToolCallResultSchema>;

const RpcEnvelopeSchema = z.object({
	result: z.unknown().optional(),
	error: z.object({ code: z.number(), message: z.string() }).optional(),
});

const ToolDescriptorSchema = z.object({
	name: z.string(),
	annotations: z.object({ readOnlyHint: z.boolean().optional() }).optional(),
	/** Read with `readConfirmationPolicy`; shapes of it are the gateway's to define. */
	_meta: z.unknown().optional(),
});

/** What the tool list says about one tool; the host page decides on it. */
export type FabricToolDescriptor = z.infer<typeof ToolDescriptorSchema>;

const ToolListResultSchema = z.object({ tools: z.array(ToolDescriptorSchema) });

/** What a tool that refused says beyond the message: why, and whether to try again. */
interface FabricToolErrorDetails {
	/** A word to branch on: `version_conflict`, `busy`, `limit`, `rate_limited`, `usage_limit`. */
	reason?: string;
	retryable?: boolean;
}

export class FabricToolError extends Error {
	readonly reason?: string;
	readonly retryable?: boolean;

	constructor(
		message: string,
		readonly toolName: string,
		details: FabricToolErrorDetails = {},
	) {
		super(message);
		this.name = "FabricToolError";
		this.reason = details.reason;
		this.retryable = details.retryable;
	}
}

let nextRequestId = 1;

/** One gateway session per organization, so a switch never reuses another's. */
const sessionIds = new Map<string, string>();

interface RpcRequest {
	method: string;
	params?: unknown;
	/** What the call is about, for the error it may raise. */
	subject: string;
	/** How a failure of the call is worded: "<label> failed with HTTP 503". */
	label: string;
	organizationId?: string | null;
	/** The page the call is made for, when it is made for a page's script. */
	pageFrameId?: string;
	signal?: AbortSignal;
	/** Fabric's own tools only (`servers=fabric`). */
	fabricToolsOnly?: boolean;
	/** Keep and reuse a gateway session; without it the call has one of its own. */
	reuseSession?: boolean;
}

/** One JSON-RPC call to the gateway as the signed-in user; returns its result. */
async function rpc(request: RpcRequest): Promise<unknown> {
	const sessionKey = request.organizationId ?? "";
	const headers: Record<string, string> = {
		"content-type": "application/json",
		accept: "application/json, text/event-stream",
	};
	if (request.organizationId) {
		headers[ORGANIZATION_HEADER] = request.organizationId;
	}
	if (request.pageFrameId) {
		headers[PAGE_FRAME_HEADER] = request.pageFrameId;
	}
	const sessionId = request.reuseSession
		? sessionIds.get(sessionKey)
		: undefined;
	if (sessionId) {
		headers["mcp-session-id"] = sessionId;
	}

	const response = await fetch(
		request.fabricToolsOnly
			? `${GATEWAY_PATH}?servers=fabric`
			: GATEWAY_PATH,
		{
			method: "POST",
			credentials: "same-origin",
			headers,
			signal: request.signal,
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: nextRequestId++,
				method: request.method,
				...(request.params === undefined
					? {}
					: { params: request.params }),
			}),
		},
	);

	if (request.reuseSession) {
		const sessionHeader = response.headers.get("mcp-session-id");
		if (sessionHeader) {
			sessionIds.set(sessionKey, sessionHeader);
		}
	}
	if (!response.ok) {
		if (
			request.reuseSession &&
			(response.status === 404 || response.status === 400)
		) {
			sessionIds.delete(sessionKey);
		}
		throw new FabricToolError(
			`${request.label} failed with HTTP ${response.status}`,
			request.subject,
		);
	}

	const envelope = RpcEnvelopeSchema.safeParse(await response.json());
	if (!envelope.success) {
		throw new FabricToolError(
			`${request.label} returned an unreadable answer`,
			request.subject,
		);
	}
	if (envelope.data.error) {
		throw new FabricToolError(envelope.data.error.message, request.subject);
	}
	return envelope.data.result;
}

function parseToolPayload(toolName: string, result: ToolCallResult): unknown {
	if (result.structuredContent !== undefined) {
		if (result.isError) {
			throw toolErrorOf(toolName, result.structuredContent);
		}
		return result.structuredContent;
	}
	const text = result.content?.find((part) => part.type === "text")?.text;
	const payload = text === undefined ? undefined : parseJsonOrText(text);
	if (result.isError) {
		throw toolErrorOf(toolName, payload);
	}
	return payload;
}

function parseJsonOrText(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

const ErrorPayloadSchema = z.object({
	error: z.string(),
	reason: z.string().optional(),
	retryable: z.boolean().optional(),
});

/** The error a tool's refusal raises: its message, and the reason it gave when it gave one. */
function toolErrorOf(toolName: string, payload: unknown): FabricToolError {
	if (typeof payload === "string") {
		return new FabricToolError(payload, toolName);
	}
	const parsed = ErrorPayloadSchema.safeParse(payload);
	return parsed.success
		? new FabricToolError(parsed.data.error, toolName, {
				reason: parsed.data.reason,
				retryable: parsed.data.retryable,
			})
		: new FabricToolError(`${toolName} failed`, toolName);
}

export interface CallFabricToolOptions {
	/** The organization of the page the call is made from. */
	organizationId?: string | null;
	/** The page the call is made for, when it is made for a page's script. */
	pageFrameId?: string;
	signal?: AbortSignal;
}

/**
 * Calls one Fabric MCP tool as the signed-in user and returns its JSON payload,
 * checked against `schema` when one is given; a payload that does not fit it is
 * an error, not a value to guess at.
 */
export async function callFabricTool<T>(
	toolName: string,
	args: Record<string, unknown>,
	options: CallFabricToolOptions & { schema: z.ZodType<T> },
): Promise<T>;
export async function callFabricTool(
	toolName: string,
	args?: Record<string, unknown>,
	options?: CallFabricToolOptions,
): Promise<unknown>;
export async function callFabricTool(
	toolName: string,
	args: Record<string, unknown> = {},
	options: CallFabricToolOptions & { schema?: z.ZodType } = {},
): Promise<unknown> {
	const raw = await rpc({
		method: "tools/call",
		params: { name: toolName, arguments: args },
		subject: toolName,
		label: toolName,
		organizationId: options.organizationId,
		pageFrameId: options.pageFrameId,
		signal: options.signal,
		reuseSession: true,
	});
	const result = ToolCallResultSchema.safeParse(raw);
	if (!result.success) {
		throw new FabricToolError(`${toolName} returned no result`, toolName);
	}
	const payload = parseToolPayload(toolName, result.data);
	if (!options.schema) {
		return payload;
	}
	const checked = options.schema.safeParse(payload);
	if (!checked.success) {
		throw new FabricToolError(
			`${toolName} returned an answer this page cannot read`,
			toolName,
		);
	}
	return checked.data;
}

let toolListPromise: Promise<readonly FabricToolDescriptor[]> | null = null;

async function fetchFabricTools(
	organizationId: string | null | undefined,
): Promise<readonly FabricToolDescriptor[]> {
	// Fabric's own tools only: that is all a page may call, and it keeps every
	// connected server's tools out of the answer. A session of its own, since a
	// selection is read when a session is opened.
	const result = ToolListResultSchema.safeParse(
		await rpc({
			method: "tools/list",
			subject: "tools/list",
			label: "Listing Fabric tools",
			organizationId,
			fabricToolsOnly: true,
		}),
	);
	if (!result.success) {
		throw new FabricToolError("Fabric returned no tool list", "tools/list");
	}
	return result.data.tools;
}

/**
 * Fabric's tools with the annotations they carry, read once and kept for the
 * life of the page: the list is the same for everyone and every organization.
 * A failed read is not kept, so the next call tries again.
 */
export function listFabricTools(
	options: Pick<CallFabricToolOptions, "organizationId"> = {},
): Promise<readonly FabricToolDescriptor[]> {
	toolListPromise ??= fetchFabricTools(options.organizationId).catch(
		(error: unknown) => {
			toolListPromise = null;
			throw error;
		},
	);
	return toolListPromise;
}

/**
 * Reads a tool as the signed-in user in the organization of the page, and keeps
 * the answer under that organization: a switch to another one asks again rather
 * than showing the last one's. Waits until the page's organization is known.
 */
export function useFabricToolQuery<T>(
	toolName: string,
	args: Record<string, unknown>,
	options: Omit<
		UseQueryOptions<T, FabricToolError>,
		"queryKey" | "queryFn" | "enabled"
	> & { schema: z.ZodType<T>; enabled?: boolean },
) {
	const organizationId = useOrganizationId();
	const { schema, enabled = true, ...queryOptions } = options;
	return useQuery<T, FabricToolError>({
		queryKey: ["fabric-tool", organizationId, toolName, args],
		queryFn: ({ signal }) =>
			callFabricTool(toolName, args, { organizationId, signal, schema }),
		...queryOptions,
		enabled: organizationId !== null && enabled,
	});
}
