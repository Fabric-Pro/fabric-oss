"use client";

/**
 * Custom Agent Editor with CopilotKit Integration
 *
 * This component provides a real-time collaborative editing experience
 * for AI agents using CopilotKit's predictive state updates.
 *
 * Features:
 * - Real-time state synchronization with agent
 * - Predictive state updates (agent manipulates UI directly)
 * - Frontend action integration
 * - WebSocket-based communication via AG-UI protocol
 */

import { useCoAgent } from "@copilotkit/react-core";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import { Textarea } from "@ui/components/textarea";
import { type ChangeEvent, useCallback, useEffect, useState } from "react";
import { useAgentActions } from "../hooks/useAgentActions";

/**
 * Agent state interface
 * This matches the BaseAgentState from the AI agent
 */
interface AgentEditorState {
	status: "idle" | "thinking" | "acting" | "waiting_approval" | "error";
	currentMessage?: string;
	messages: Array<{
		role: "user" | "assistant" | "system";
		content: string;
		timestamp: number;
	}>;
	activeTools: string[];
	custom?: {
		documentContent?: string;
		currentSection?: string;
		generatedSections?: Record<string, string>;
	};
}

interface CustomAgentEditorProps {
	agentId: string;
	deploymentUrl: string;
	initialState?: Partial<AgentEditorState>;
}

export function CustomAgentEditor({
	agentId,
	deploymentUrl,
	initialState,
}: CustomAgentEditorProps) {
	// Use CopilotKit's useCoAgent hook for state management
	const { state, setState } = useCoAgent<AgentEditorState>({
		name: agentId,
		initialState: {
			status: "idle",
			messages: [],
			activeTools: [],
			custom: {},
			...initialState,
		},
	});

	const ensureState = (prev?: AgentEditorState): AgentEditorState => ({
		status: prev?.status ?? "idle",
		currentMessage: prev?.currentMessage,
		messages: prev?.messages ?? [],
		activeTools: prev?.activeTools ?? [],
		custom: prev?.custom ?? {},
	});

	const updateState = useCallback(
		(updater: (prev: AgentEditorState) => AgentEditorState) => {
			setState((prev) => updater(ensureState(prev)));
		},
		[setState],
	);

	const [userInput, setUserInput] = useState("");
	const [isConnected, setIsConnected] = useState(false);

	// Register frontend actions
	useAgentActions({
		onDocumentUpdate: (content, _mode) => {
			updateState((prev) => ({
				...prev,
				custom: {
					...prev.custom,
					documentContent: content,
				},
			}));
		},
		onSectionGenerate: (sectionName, _sectionType, content) => {
			updateState((prev) => ({
				...prev,
				custom: {
					...prev.custom,
					generatedSections: {
						...prev.custom?.generatedSections,
						[sectionName]: content,
					},
				},
			}));
		},
		onUIStateUpdate: (updates) => {
			updateState((prev) => ({
				...prev,
				...updates,
			}));
		},
	});

	// Connect to agent's WebSocket endpoint
	useEffect(() => {
		const wsUrl = deploymentUrl.replace(/^http/, "ws");
		const ws = new WebSocket(`${wsUrl}/ws`);

		ws.onopen = () => {
			setIsConnected(true);
			console.log("[CustomAgentEditor] Connected to agent:", agentId);
		};

		ws.onmessage = (event) => {
			try {
				const message = JSON.parse(event.data);

				// Handle CopilotKit state delta messages
				if (message.type === "copilotkit_state_delta") {
					updateState((prev) => ({
						...prev,
						...message.delta,
					}));
				}

				// Handle regular agent messages
				if (message.type === "agent_message") {
					updateState((prev) => ({
						...prev,
						messages: [
							...prev.messages,
							{
								role: message.role,
								content: message.content,
								timestamp: Date.now(),
							},
						],
					}));
				}

				// Handle state updates
				if (message.type === "agent_state_update") {
					updateState((prev) => ({
						...prev,
						...message.state,
					}));
				}
			} catch (error) {
				console.error(
					"[CustomAgentEditor] Failed to parse message:",
					error,
				);
			}
		};

		ws.onerror = (error) => {
			console.error("[CustomAgentEditor] WebSocket error:", error);
			setIsConnected(false);
		};

		ws.onclose = () => {
			console.log("[CustomAgentEditor] Disconnected from agent");
			setIsConnected(false);
		};

		return () => {
			ws.close();
		};
	}, [agentId, deploymentUrl, updateState]);

	const handleSendMessage = () => {
		if (!userInput.trim()) {
			return;
		}

		// Add user message to state
		updateState((prev) => ({
			...prev,
			messages: [
				...prev.messages,
				{
					role: "user",
					content: userInput,
					timestamp: Date.now(),
				},
			],
		}));

		// TODO: Send message to agent via WebSocket
		// ws.send(JSON.stringify({ type: "user_message", content: userInput }));

		setUserInput("");
	};

	return (
		<div className="flex flex-col gap-4 h-full">
			{/* Connection Status */}
			<div className="flex items-center justify-between">
				<h2 className="text-2xl font-bold">Agent Editor</h2>
				<Badge variant={isConnected ? "default" : "destructive"}>
					{isConnected ? "Connected" : "Disconnected"}
				</Badge>
			</div>

			{/* Agent Status */}
			<Card>
				<CardHeader>
					<CardTitle>Agent Status</CardTitle>
					<CardDescription>
						Current agent state and activity
					</CardDescription>
				</CardHeader>
				<CardContent>
					<div className="space-y-2">
						<div className="flex items-center gap-2">
							<span className="font-medium">Status:</span>
							<Badge>{state.status}</Badge>
						</div>
						{state.activeTools.length > 0 && (
							<div className="flex items-center gap-2">
								<span className="font-medium">
									Active Tools:
								</span>
								{state.activeTools.map((tool) => (
									<Badge key={tool} variant="outline">
										{tool}
									</Badge>
								))}
							</div>
						)}
					</div>
				</CardContent>
			</Card>

			{/* Document Content (if available) */}
			{state.custom?.documentContent && (
				<Card>
					<CardHeader>
						<CardTitle>Document Content</CardTitle>
						<CardDescription>
							Real-time collaborative editing
						</CardDescription>
					</CardHeader>
					<CardContent>
						<Textarea
							value={state.custom.documentContent}
							onChange={(
								event: ChangeEvent<HTMLTextAreaElement>,
							) =>
								updateState((prev) => ({
									...prev,
									custom: {
										...prev.custom,
										documentContent: event.target.value,
									},
								}))
							}
							rows={10}
							className="font-mono"
						/>
					</CardContent>
				</Card>
			)}

			{/* Chat Interface */}
			<Card className="flex-1">
				<CardHeader>
					<CardTitle>Chat</CardTitle>
					<CardDescription>
						Communicate with the agent
					</CardDescription>
				</CardHeader>
				<CardContent className="space-y-4">
					{/* Messages */}
					<div className="space-y-2 max-h-96 overflow-y-auto">
						{state.messages.map((msg, idx) => (
							<div
								key={idx}
								className={`p-3 rounded-lg ${
									msg.role === "user"
										? "bg-primary text-primary-foreground ml-8"
										: "bg-muted mr-8"
								}`}
							>
								<div className="text-xs font-medium mb-1">
									{msg.role}
								</div>
								<div className="text-sm">{msg.content}</div>
							</div>
						))}
					</div>

					{/* Input */}
					<div className="flex gap-2">
						<Textarea
							value={userInput}
							onChange={(
								event: ChangeEvent<HTMLTextAreaElement>,
							) => setUserInput(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									handleSendMessage();
								}
							}}
							placeholder="Type a message..."
							rows={2}
						/>
						<Button
							onClick={handleSendMessage}
							disabled={!isConnected}
						>
							Send
						</Button>
					</div>
				</CardContent>
			</Card>
		</div>
	);
}
