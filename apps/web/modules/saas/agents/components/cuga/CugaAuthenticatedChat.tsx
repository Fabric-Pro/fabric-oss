"use client";

/**
 * CugaAuthenticatedChat
 *
 * An authenticated chat interface for CUGA agent that uses the A2A proxy
 * with proper credential exchange. This component passes user/org credentials
 * through Fabric's authentication system.
 *
 * This component should be used in production where multi-tenant credential
 * isolation is required.
 */

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { ScrollArea } from "@ui/components/scroll-area";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import { AlertCircle, Bot, Loader2, Send, User, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
	Reasoning,
	ReasoningContent,
	ReasoningTrigger,
} from "../../../../../components/ai-elements/reasoning";
import { Response } from "../../../../../components/ai-elements/response";
import { Shimmer } from "../../../../../components/ai-elements/shimmer";

interface Message {
	id: string;
	role: "user" | "assistant";
	content: string;
	timestamp: Date;
	isError?: boolean;
	reasoning?: string;
	artifacts?: unknown[];
}

interface CugaAuthenticatedChatProps {
	agentId?: string;
	className?: string;
	/** CUGA AG-UI wrapper URL (default: from env or localhost:9999) */
	agentUrl?: string;
}

const DEFAULT_CUGA_AGENT_URL =
	process.env.NEXT_PUBLIC_CUGA_AGENT_URL || "http://localhost:9999";

export function CugaAuthenticatedChat({
	agentId: _agentId,
	className,
	agentUrl,
}: CugaAuthenticatedChatProps) {
	const { organizationId } = useOrganizationContext();
	const [messages, setMessages] = useState<Message[]>([]);
	const [input, setInput] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [contextId, setContextId] = useState<string | null>(null);
	const messagesEndRef = useRef<HTMLDivElement>(null);
	const inputRef = useRef<HTMLTextAreaElement>(null);

	// Use agent URL from prop or environment
	const cugaAgentUrl = agentUrl || DEFAULT_CUGA_AGENT_URL;

	// Auto-scroll to bottom
	useEffect(() => {
		messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages]);

	// Focus input on mount
	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	const sendMessage = useCallback(async () => {
		if (!input.trim() || isLoading) {
			return;
		}

		const userMessage: Message = {
			id: `msg-${Date.now()}`,
			role: "user",
			content: input.trim(),
			timestamp: new Date(),
		};

		setMessages((prev) => [...prev, userMessage]);
		setInput("");
		setIsLoading(true);

		try {
			// Call CUGA via authenticated A2A proxy
			// IMPORTANT: Pass null explicitly for personal context to prevent
			// session fallback which could leak org data to personal pages
			const response = await fetch("/api/agents/a2a/send", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					agentUrl: cugaAgentUrl,
					message: {
						role: "user",
						content: userMessage.content,
					},
					contextId,
					history: messages.map((m) => ({
						role: m.role,
						content: m.content,
					})),
					organizationId,
				}),
			});

			if (!response.ok) {
				const errorData = await response.json();
				throw new Error(
					errorData.error || "Failed to get response from CUGA",
				);
			}

			const data = await response.json();

			// Update context ID for multi-turn
			if (data.contextId) {
				setContextId(data.contextId);
			}

			const assistantMessage: Message = {
				id: `msg-${Date.now() + 1}`,
				role: "assistant",
				content: data.response || "",
				timestamp: new Date(),
				reasoning: data.reasoning,
				artifacts: data.artifacts,
			};

			setMessages((prev) => [...prev, assistantMessage]);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "An error occurred";
			toast.error("Error", { description: errorMessage });

			setMessages((prev) => [
				...prev,
				{
					id: `msg-${Date.now() + 1}`,
					role: "assistant",
					content: `Error: ${errorMessage}`,
					timestamp: new Date(),
					isError: true,
				},
			]);
		} finally {
			setIsLoading(false);
		}
	}, [input, isLoading, cugaAgentUrl, contextId, messages, organizationId]);

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	};

	return (
		<div className={cn("flex flex-col h-full", className)}>
			{/* Header */}
			<div className="flex items-center justify-between px-4 py-3 border-b bg-background">
				<div className="flex items-center gap-2">
					<div className="h-8 w-8 rounded-lg bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center">
						<Bot className="h-5 w-5 text-white" />
					</div>
					<div>
						<h1 className="font-semibold text-sm">
							CUGA Generalist
						</h1>
						<p className="text-xs text-muted-foreground">
							Authenticated Chat Interface
						</p>
					</div>
				</div>
				<div className="flex items-center gap-2">
					<Badge variant="secondary" className="text-xs">
						<Zap className="h-3 w-3 mr-1" />
						Multi-tenant
					</Badge>
				</div>
			</div>

			{/* Messages Area */}
			{messages.length === 0 ? (
				<div className="flex-1 flex flex-col items-center justify-center text-center text-muted-foreground p-4">
					<div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center mb-6">
						<Bot className="h-10 w-10 text-white" />
					</div>
					<h3 className="text-xl font-medium mb-3 text-foreground">
						CUGA Generalist Agent
					</h3>
					<p className="text-sm max-w-md mb-8">
						A powerful multi-agent system capable of browser
						automation, API orchestration, code execution, and
						intelligent task decomposition. Your credentials are
						securely managed.
					</p>
					<div className="flex flex-wrap gap-2 justify-center max-w-lg">
						{[
							"Search the web for recent AI news",
							"Execute a Python script",
							"Navigate to GitHub and star a repo",
						].map((suggestion) => (
							<Button
								key={suggestion}
								variant="outline"
								size="sm"
								className="text-xs"
								onClick={() => {
									setInput(suggestion);
									inputRef.current?.focus();
								}}
							>
								{suggestion}
							</Button>
						))}
					</div>
				</div>
			) : (
				<ScrollArea className="flex-1 p-4">
					<div className="space-y-4 max-w-3xl mx-auto">
						{messages.map((message) => (
							<div
								key={message.id}
								className={cn(
									"flex gap-3",
									message.role === "user"
										? "justify-end"
										: "justify-start",
								)}
							>
								{message.role === "assistant" && (
									<div className="flex-shrink-0">
										<div className="h-8 w-8 rounded-lg bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center">
											<Bot className="h-5 w-5 text-white" />
										</div>
									</div>
								)}

								<div
									className={cn(
										"rounded-lg min-w-0",
										message.role === "user"
											? "max-w-[70%] bg-muted border px-4 py-3"
											: message.isError
												? "flex-1 max-w-[85%] bg-destructive/10 border border-destructive/20 px-4 py-3"
												: "flex-1 max-w-[85%] space-y-3 overflow-hidden",
									)}
								>
									{/* Reasoning */}
									{message.reasoning && (
										<Reasoning
											isStreaming={false}
											defaultOpen={false}
										>
											<ReasoningTrigger />
											<ReasoningContent>
												{message.reasoning}
											</ReasoningContent>
										</Reasoning>
									)}

									{/* Message Content */}
									{message.content && (
										<div
											className={cn(
												message.role === "assistant" &&
													!message.isError &&
													"bg-muted rounded-lg px-4 py-3",
											)}
										>
											{message.isError ? (
												<div className="flex items-start gap-2">
													<AlertCircle className="h-4 w-4 text-destructive mt-0.5" />
													<span>
														{message.content}
													</span>
												</div>
											) : (
												<Response>
													{message.content}
												</Response>
											)}
										</div>
									)}
								</div>

								{message.role === "user" && (
									<div className="flex-shrink-0">
										<div className="h-8 w-8 rounded-lg bg-muted flex items-center justify-center">
											<User className="h-4 w-4" />
										</div>
									</div>
								)}
							</div>
						))}

						{/* Loading indicator */}
						{isLoading && (
							<div className="flex gap-3 py-4">
								<div className="flex-shrink-0">
									<div className="h-8 w-8 rounded-lg bg-gradient-to-br from-purple-500 to-blue-600 flex items-center justify-center">
										<Bot className="h-5 w-5 text-white" />
									</div>
								</div>
								<div className="bg-muted rounded-lg px-4 py-3">
									<Shimmer duration={2}>
										Processing with CUGA...
									</Shimmer>
								</div>
							</div>
						)}

						<div ref={messagesEndRef} />
					</div>
				</ScrollArea>
			)}

			{/* Input Area */}
			<div className="border-t p-4 bg-background mt-auto">
				<div className="max-w-3xl mx-auto flex gap-2">
					<Textarea
						ref={inputRef}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder="Message CUGA..."
						className="min-h-[44px] max-h-[200px] resize-none"
						disabled={isLoading}
					/>
					<Button
						onClick={sendMessage}
						disabled={!input.trim() || isLoading}
						size="icon"
						className="h-11 w-11 shrink-0"
					>
						{isLoading ? (
							<Loader2 className="h-4 w-4 animate-spin" />
						) : (
							<Send className="h-4 w-4" />
						)}
					</Button>
				</div>
			</div>
		</div>
	);
}
