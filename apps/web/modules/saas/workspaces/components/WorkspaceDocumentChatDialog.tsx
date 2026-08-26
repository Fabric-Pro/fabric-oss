"use client";

/**
 * Workspace Document Chat Dialog
 *
 * A dialog that allows users to chat with documents in a workspace using RAG.
 * Uses vector search to find relevant document chunks and AI to answer questions.
 */

import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { ScrollArea } from "@ui/components/scroll-area";
import {
	ChevronDownIcon,
	ChevronRightIcon,
	FileTextIcon,
	Loader2Icon,
	Maximize2Icon,
	MessageCircleIcon,
	Minimize2Icon,
	SendIcon,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Response } from "../../../../components/ai-elements/response";

interface WorkspaceDocumentChatDialogProps {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	workspaceId: string;
	workspaceName: string;
	documentCount: number;
	organizationId?: string | null;
}

interface SourceReference {
	filename: string;
	pageNumber?: number;
	chunkIndex: number;
	score: number;
	content: string;
}

interface ChatMessage {
	role: "user" | "assistant";
	content: string;
	sources?: SourceReference[];
	timestamp: Date;
	isError?: boolean;
}

export function WorkspaceDocumentChatDialog({
	open,
	onOpenChange,
	workspaceId,
	workspaceName,
	documentCount,
	organizationId,
}: WorkspaceDocumentChatDialogProps) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [input, setInput] = useState("");
	const [isLoading, setIsLoading] = useState(false);
	const [expandedSources, setExpandedSources] = useState<Set<string>>(
		new Set(),
	);
	const [isFullscreen, setIsFullscreen] = useState(false);
	const scrollRef = useRef<HTMLDivElement>(null);

	// Scroll to bottom on new messages
	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
		}
	}, [messages]);

	// Reset when dialog closes
	useEffect(() => {
		if (!open) {
			setMessages([]);
			setInput("");
		}
	}, [open]);

	const toggleSourceExpanded = (id: string) => {
		setExpandedSources((prev) => {
			const next = new Set(prev);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	};

	const sendMessage = async () => {
		if (!input.trim() || isLoading) {
			return;
		}

		const userMessage: ChatMessage = {
			role: "user",
			content: input.trim(),
			timestamp: new Date(),
		};

		setMessages((prev) => [...prev, userMessage]);
		setInput("");
		setIsLoading(true);

		try {
			const response = await fetch("/api/workspaces/chat", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					workspaceId,
					organizationId,
					message: userMessage.content,
					history: messages.map((m) => ({
						role: m.role,
						content: m.content,
					})),
				}),
			});

			if (!response.ok) {
				const errorData = await response.json();
				throw new Error(errorData.error || "Failed to get response");
			}

			const data = await response.json();

			// Add assistant response with sources
			setMessages((prev) => [
				...prev,
				{
					role: "assistant",
					content:
						data.response ||
						"I couldn't find relevant information in the documents.",
					sources: data.sources,
					timestamp: new Date(),
				},
			]);
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : "An error occurred";
			toast.error("Chat error", { description: errorMessage });
			setMessages((prev) => [
				...prev,
				{
					role: "assistant",
					content: `Error: ${errorMessage}`,
					timestamp: new Date(),
					isError: true,
				},
			]);
		} finally {
			setIsLoading(false);
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			sendMessage();
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent
				className={`flex flex-col p-0 ${
					isFullscreen
						? "max-w-none w-screen h-screen rounded-none"
						: "max-w-2xl h-[80vh]"
				}`}
			>
				{/* Header */}
				<DialogHeader className="px-6 py-4 border-b shrink-0">
					{/* pr-8 reserves space for the DialogContent close (X) button at right-4 top-4 */}
					<div className="flex items-center gap-3 pr-8">
						<div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
							<FileTextIcon className="w-5 h-5 text-primary" />
						</div>
						<div className="flex-1 min-w-0">
							<DialogTitle className="text-lg">
								Chat with Documents
							</DialogTitle>
							<DialogDescription className="text-xs truncate">
								{workspaceName}
							</DialogDescription>
						</div>
						{/* Document Count */}
						<Badge variant="secondary" className="shrink-0">
							<FileTextIcon className="mr-1 size-3" />
							{documentCount} documents
						</Badge>
						{/* Fullscreen Toggle */}
						<Button
							variant="ghost"
							size="icon"
							className="shrink-0 rounded-sm opacity-70 hover:opacity-100"
							onClick={() => setIsFullscreen(!isFullscreen)}
							title={
								isFullscreen ? "Exit fullscreen" : "Fullscreen"
							}
						>
							{isFullscreen ? (
								<Minimize2Icon className="size-4" />
							) : (
								<Maximize2Icon className="size-4" />
							)}
						</Button>
					</div>
				</DialogHeader>

				{/* Messages Area */}
				<ScrollArea className="flex-1 px-6 py-4" ref={scrollRef}>
					{messages.length === 0 ? (
						<div className="flex flex-col items-center justify-center h-full text-center py-12">
							<MessageCircleIcon className="size-12 text-muted-foreground mb-4" />
							<h3 className="font-semibold mb-2">
								Ask anything about your documents
							</h3>
							<p className="text-sm text-muted-foreground max-w-sm mb-6">
								I can search through {documentCount} documents
								in this workspace to answer your questions.
							</p>
							{/* Suggested Questions */}
							<div className="flex flex-wrap gap-2 justify-center max-w-md">
								{[
									"Summarize the main topics",
									"What are the key points?",
									"Find information about...",
								].map((suggestion) => (
									<Button
										key={suggestion}
										variant="outline"
										size="sm"
										onClick={() => setInput(suggestion)}
										className="text-xs"
									>
										{suggestion}
									</Button>
								))}
							</div>
						</div>
					) : (
						<div className="space-y-4">
							{messages.map((message, idx) => (
								<div
									key={idx}
									className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
								>
									<div
										className={`max-w-[85%] rounded-lg px-4 py-3 ${
											message.role === "user"
												? "bg-primary text-primary-foreground"
												: message.isError
													? "bg-destructive/10 border border-destructive/20"
													: "bg-muted"
										}`}
									>
										{/* Source References Section */}
										{message.sources &&
											message.sources.length > 0 && (
												<div className="mb-3 space-y-2">
													<p className="text-xs text-muted-foreground font-medium">
														Sources (
														{message.sources.length}
														)
													</p>
													{message.sources.map(
														(source, srcIdx) => {
															const id = `${idx}-${srcIdx}`;
															const isExpanded =
																expandedSources.has(
																	id,
																);
															return (
																<div
																	key={srcIdx}
																	className="bg-background/50 rounded-md border text-sm"
																>
																	<button
																		type="button"
																		onClick={() =>
																			toggleSourceExpanded(
																				id,
																			)
																		}
																		className="w-full flex items-center gap-2 px-3 py-2 hover:bg-muted/50 transition-colors"
																	>
																		{isExpanded ? (
																			<ChevronDownIcon className="size-4 shrink-0" />
																		) : (
																			<ChevronRightIcon className="size-4 shrink-0" />
																		)}
																		<FileTextIcon className="size-4 text-primary shrink-0" />
																		<span className="font-mono text-xs truncate flex-1 text-left">
																			{
																				source.filename
																			}
																			{source.pageNumber !==
																				undefined && (
																				<span className="text-muted-foreground">
																					{" "}
																					(p.
																					{
																						source.pageNumber
																					}
																					)
																				</span>
																			)}
																		</span>
																		<Badge
																			variant="outline"
																			className="text-xs shrink-0"
																		>
																			{Math.round(
																				source.score *
																					100,
																			)}
																			%
																		</Badge>
																	</button>
																	{isExpanded && (
																		<div className="px-3 pb-3">
																			<div className="overflow-x-auto">
																				<pre className="text-xs bg-muted rounded p-2 max-h-32 whitespace-pre-wrap">
																					{source.content.slice(
																						0,
																						500,
																					)}
																					{source
																						.content
																						.length >
																						500 &&
																						"..."}
																				</pre>
																			</div>
																		</div>
																	)}
																</div>
															);
														},
													)}
												</div>
											)}

										{/* Message Content */}
										{message.role === "user" ? (
											<p className="text-sm whitespace-pre-wrap">
												{message.content}
											</p>
										) : (
											<Response className="text-sm [&_pre]:text-xs [&_code]:text-xs">
												{message.content}
											</Response>
										)}
									</div>
								</div>
							))}
							{isLoading && (
								<div className="flex justify-start">
									<div className="bg-muted rounded-lg px-4 py-3 flex items-center gap-2">
										<Loader2Icon className="size-4 animate-spin" />
										<span className="text-sm text-muted-foreground">
											Searching documents...
										</span>
									</div>
								</div>
							)}
						</div>
					)}
				</ScrollArea>

				{/* Input Area */}
				<div className="px-6 py-4 border-t shrink-0">
					<div className="flex gap-2">
						<Input
							value={input}
							onChange={(e) => setInput(e.target.value)}
							onKeyDown={handleKeyDown}
							placeholder="Ask about your documents..."
							disabled={isLoading}
							className="flex-1"
						/>
						<Button
							onClick={sendMessage}
							disabled={!input.trim() || isLoading}
						>
							{isLoading ? (
								<Loader2Icon className="size-4 animate-spin" />
							) : (
								<SendIcon className="size-4" />
							)}
						</Button>
					</div>
					<p className="text-xs text-muted-foreground mt-2">
						Press Enter to send
					</p>
				</div>
			</DialogContent>
		</Dialog>
	);
}
