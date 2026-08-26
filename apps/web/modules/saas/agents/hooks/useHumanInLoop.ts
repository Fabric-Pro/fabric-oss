"use client";

/**
 * useHumanInLoop Hook
 *
 * Provides Human-in-the-Loop (HITL) functionality for AI agents.
 * Supports approval, input, and choice request types with timeout handling.
 */

import { useCopilotAction } from "@copilotkit/react-core";
import { useCallback, useState } from "react";
import { v4 as uuidv4 } from "uuid";

/**
 * HITL request types
 */
export type HITLRequestType = "approval" | "input" | "choice";

/**
 * Option for choice requests
 */
export interface HITLOption {
	value: string;
	label: string;
	description?: string;
	icon?: string;
}

/**
 * HITL request structure
 */
export interface HITLRequest {
	requestId: string;
	type: HITLRequestType;
	prompt: string;
	title?: string;
	context?: Record<string, unknown>;
	options?: HITLOption[];
	timeout?: number;
	defaultValue?: string;
	required?: boolean;
	createdAt: number;
}

/**
 * HITL response structure
 */
export interface HITLResponse {
	requestId: string;
	approved: boolean;
	value?: string | string[];
	respondedAt: number;
}

/**
 * Hook options
 */
export interface UseHumanInLoopOptions {
	/** Default timeout in ms (default: 60000) */
	defaultTimeout?: number;
	/** Callback when a new request is received */
	onRequest?: (request: HITLRequest) => void;
	/** Callback when a response is submitted */
	onResponse?: (response: HITLResponse) => void;
	/** Callback when a request times out */
	onTimeout?: (requestId: string) => void;
}

/**
 * Hook return type
 */
export interface UseHumanInLoopReturn {
	/** Current pending request (if any) */
	pendingRequest: HITLRequest | null;
	/** All pending requests */
	pendingRequests: HITLRequest[];
	/** Whether there's an active request */
	hasActiveRequest: boolean;
	/** Respond to the current request */
	respond: (approved: boolean, value?: string | string[]) => void;
	/** Dismiss the current request (reject) */
	dismiss: () => void;
	/** Clear all pending requests */
	clearAll: () => void;
}

/**
 * Human-in-the-Loop hook for AI agent interactions
 */
export function useHumanInLoop(
	options: UseHumanInLoopOptions = {},
): UseHumanInLoopReturn {
	const {
		defaultTimeout = 60000,
		onRequest,
		onResponse,
		onTimeout,
	} = options;

	const [pendingRequests, setPendingRequests] = useState<HITLRequest[]>([]);
	const [responseCallbacks, setResponseCallbacks] = useState<
		Map<string, (response: HITLResponse) => void>
	>(new Map());

	// Get the first pending request
	const pendingRequest = pendingRequests[0] ?? null;
	const hasActiveRequest = pendingRequests.length > 0;

	// Handle response
	const respond = useCallback(
		(approved: boolean, value?: string | string[]) => {
			if (!pendingRequest) {
				return;
			}

			const response: HITLResponse = {
				requestId: pendingRequest.requestId,
				approved,
				value,
				respondedAt: Date.now(),
			};

			// Call the stored callback
			const callback = responseCallbacks.get(pendingRequest.requestId);
			if (callback) {
				callback(response);
				setResponseCallbacks((prev) => {
					const next = new Map(prev);
					next.delete(pendingRequest.requestId);
					return next;
				});
			}

			// Remove from pending
			setPendingRequests((prev) =>
				prev.filter((r) => r.requestId !== pendingRequest.requestId),
			);

			onResponse?.(response);
		},
		[pendingRequest, responseCallbacks, onResponse],
	);

	// Dismiss current request
	const dismiss = useCallback(() => {
		respond(false);
	}, [respond]);

	// Clear all pending requests
	const clearAll = useCallback(() => {
		for (const request of pendingRequests) {
			const callback = responseCallbacks.get(request.requestId);
			if (callback) {
				callback({
					requestId: request.requestId,
					approved: false,
					respondedAt: Date.now(),
				});
			}
		}
		setPendingRequests([]);
		setResponseCallbacks(new Map());
	}, [pendingRequests, responseCallbacks]);

	// Register HITL approval action with CopilotKit
	useCopilotAction({
		name: "request_human_approval",
		description: "Request human approval before proceeding with an action",
		parameters: [
			{
				name: "prompt",
				type: "string",
				required: true,
				description: "What to ask the user",
			},
			{
				name: "title",
				type: "string",
				required: false,
				description: "Dialog title",
			},
			{
				name: "context",
				type: "object",
				required: false,
				description: "Additional context",
			},
			{
				name: "timeout",
				type: "number",
				required: false,
				description: "Timeout in ms",
			},
		],
		handler: async (args) => {
			return new Promise<{ approved: boolean }>((resolve) => {
				const requestId = uuidv4();
				const request: HITLRequest = {
					requestId,
					type: "approval",
					prompt: (args as { prompt: string }).prompt,
					title: (args as { title?: string }).title,
					context: (args as { context?: Record<string, unknown> })
						.context,
					timeout:
						(args as { timeout?: number }).timeout ??
						defaultTimeout,
					createdAt: Date.now(),
				};

				setResponseCallbacks((prev) =>
					new Map(prev).set(requestId, (response) => {
						resolve({ approved: response.approved });
					}),
				);
				setPendingRequests((prev) => [...prev, request]);
				onRequest?.(request);

				// Handle timeout
				setTimeout(() => {
					setPendingRequests((prev) => {
						const stillPending = prev.find(
							(r) => r.requestId === requestId,
						);
						if (stillPending) {
							onTimeout?.(requestId);
							resolve({ approved: false });
							return prev.filter(
								(r) => r.requestId !== requestId,
							);
						}
						return prev;
					});
				}, request.timeout);
			});
		},
	});

	// Register HITL input action with CopilotKit
	useCopilotAction({
		name: "request_human_input",
		description: "Request text input from the user",
		parameters: [
			{
				name: "prompt",
				type: "string",
				required: true,
				description: "What to ask the user",
			},
			{
				name: "title",
				type: "string",
				required: false,
				description: "Dialog title",
			},
			{
				name: "defaultValue",
				type: "string",
				required: false,
				description: "Default input value",
			},
			{
				name: "required",
				type: "boolean",
				required: false,
				description: "Whether input is required",
			},
			{
				name: "context",
				type: "object",
				required: false,
				description: "Additional context",
			},
			{
				name: "timeout",
				type: "number",
				required: false,
				description: "Timeout in ms",
			},
		],
		handler: async (args) => {
			return new Promise<{ approved: boolean; value?: string }>(
				(resolve) => {
					const requestId = uuidv4();
					const typedArgs = args as {
						prompt: string;
						title?: string;
						defaultValue?: string;
						required?: boolean;
						context?: Record<string, unknown>;
						timeout?: number;
					};
					const request: HITLRequest = {
						requestId,
						type: "input",
						prompt: typedArgs.prompt,
						title: typedArgs.title,
						defaultValue: typedArgs.defaultValue,
						required: typedArgs.required ?? false,
						context: typedArgs.context,
						timeout: typedArgs.timeout ?? defaultTimeout,
						createdAt: Date.now(),
					};

					setResponseCallbacks((prev) =>
						new Map(prev).set(requestId, (response) => {
							resolve({
								approved: response.approved,
								value: response.value as string | undefined,
							});
						}),
					);
					setPendingRequests((prev) => [...prev, request]);
					onRequest?.(request);

					// Handle timeout
					setTimeout(() => {
						setPendingRequests((prev) => {
							const stillPending = prev.find(
								(r) => r.requestId === requestId,
							);
							if (stillPending) {
								onTimeout?.(requestId);
								resolve({ approved: false });
								return prev.filter(
									(r) => r.requestId !== requestId,
								);
							}
							return prev;
						});
					}, request.timeout);
				},
			);
		},
	});

	// Register HITL choice action with CopilotKit
	useCopilotAction({
		name: "request_human_choice",
		description: "Request the user to choose from a list of options",
		parameters: [
			{
				name: "prompt",
				type: "string",
				required: true,
				description: "What to ask the user",
			},
			{
				name: "title",
				type: "string",
				required: false,
				description: "Dialog title",
			},
			{
				name: "options",
				type: "object[]",
				required: true,
				description: "Available options",
			},
			{
				name: "multiSelect",
				type: "boolean",
				required: false,
				description: "Allow multiple selections",
			},
			{
				name: "context",
				type: "object",
				required: false,
				description: "Additional context",
			},
			{
				name: "timeout",
				type: "number",
				required: false,
				description: "Timeout in ms",
			},
		],
		handler: async (args) => {
			return new Promise<{
				approved: boolean;
				value?: string | string[];
			}>((resolve) => {
				const requestId = uuidv4();
				const typedArgs = args as {
					prompt: string;
					title?: string;
					options: HITLOption[];
					multiSelect?: boolean;
					context?: Record<string, unknown>;
					timeout?: number;
				};
				const request: HITLRequest = {
					requestId,
					type: "choice",
					prompt: typedArgs.prompt,
					title: typedArgs.title,
					options: typedArgs.options,
					context: {
						...typedArgs.context,
						multiSelect: typedArgs.multiSelect,
					},
					timeout: typedArgs.timeout ?? defaultTimeout,
					createdAt: Date.now(),
				};

				setResponseCallbacks((prev) =>
					new Map(prev).set(requestId, (response) => {
						resolve({
							approved: response.approved,
							value: response.value,
						});
					}),
				);
				setPendingRequests((prev) => [...prev, request]);
				onRequest?.(request);

				// Handle timeout
				setTimeout(() => {
					setPendingRequests((prev) => {
						const stillPending = prev.find(
							(r) => r.requestId === requestId,
						);
						if (stillPending) {
							onTimeout?.(requestId);
							resolve({ approved: false });
							return prev.filter(
								(r) => r.requestId !== requestId,
							);
						}
						return prev;
					});
				}, request.timeout);
			});
		},
	});

	return {
		pendingRequest,
		pendingRequests,
		hasActiveRequest,
		respond,
		dismiss,
		clearAll,
	};
}
