"use client";

import { useChat } from "@ai-sdk/react";
import type { UIMessage } from "ai";
import { useState, useEffect, FormEvent, useCallback, useRef } from "react";
import { Loader } from "@/components/ui/loader";
import { ChatMessage } from "@/components/chat/chat-message";
import { ChatInput } from "@/components/chat/chat-input";
import { ChatSidebar } from "@/components/chat/chat-sidebar";
import { useChatHistory } from "@/hooks/use-chat-history";
import { useLocalStorage } from "@/hooks/use-local-storage";
import { useStreamingChat } from "@/hooks/use-streaming-chat";
import {
	STORAGE_KEYS,
	DEFAULT_MODEL,
	DEFAULT_FRAMEWORK,
} from "@/lib/constants";
import {
	extractTextContent,
	type TypedUIMessage,
	type UIMessagePart,
} from "@/lib/types";

export default function Chat() {
	const [selectedModel, setSelectedModel] = useLocalStorage<string>(
		STORAGE_KEYS.model,
		DEFAULT_MODEL,
	);
	const [sidebarCollapsed, setSidebarCollapsed] = useLocalStorage<boolean>(
		"data-analyst-agent:sidebar:collapsed",
		false,
	);
	const [darkMode, setDarkMode] = useLocalStorage<boolean>(
		"data-analyst-agent:darkmode",
		false,
	);
	const [selectedFramework, setSelectedFramework] = useLocalStorage<string>(
		STORAGE_KEYS.framework,
		DEFAULT_FRAMEWORK,
	);
	const [input, setInput] = useState("");
	const [pptUrl, setPptUrl] = useState<string | null>(null);
	const saveTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const [activeChatId, setActiveChatId] = useState<string | null>(null);
	const [chatSessionId, setChatSessionId] = useState<string>(
		"session-" + Date.now(),
	);
	const isLoadingExistingChat = useRef(false);

	useEffect(() => {
		if (darkMode) {
			document.documentElement.classList.add("dark");
		} else {
			document.documentElement.classList.remove("dark");
		}
	}, [darkMode]);

	const {
		chats,
		isLoadingChats,
		createChat,
		selectChat,
		deleteChat,
		saveMessages,
	} = useChatHistory();

	const useAiSdk = selectedFramework === "ai-sdk";

	const aiSdkChat = useChat({
		id: chatSessionId,
	});

	const streamingChat = useStreamingChat();

	// Choose appropriate chat hook based on framework
	const {
		messages,
		sendMessage,
		status,
		error: chatError,
	} = useAiSdk ? aiSdkChat : streamingChat;
	// setMessages is destructured separately and dispatched explicitly
	// instead of being pulled out of the ternary above: aiSdkChat.setMessages
	// and streamingChat.setMessages are two structurally different function
	// types (this monorepo's dependency tree carries two major versions of
	// "ai" — @ai-sdk/react resolves its own UIMessage against ai@5, while
	// this agent's direct "ai" dependency and useStreamingChat resolve
	// against ai@6), so a union of the two can't be invoked directly:
	// TypeScript would require the call argument to satisfy an
	// unsatisfiable intersection of both signatures. Dispatching per-branch
	// lets the streamingChat (ai@6) path type-check with no cast at all,
	// and isolates the one narrow, explicit bridge the genuine ai@5/ai@6
	// version split requires.
	const setMessages = useCallback(
		(next: UIMessage[]) => {
			if (useAiSdk) {
				aiSdkChat.setMessages(
					next as unknown as Parameters<
						typeof aiSdkChat.setMessages
					>[0],
				);
			} else {
				streamingChat.setMessages(next);
			}
		},
		[useAiSdk, aiSdkChat, streamingChat],
	);

	const isLoading = status === "submitted" || status === "streaming";
	const saveMessagesRef = useRef(saveMessages);
	saveMessagesRef.current = saveMessages;

	useEffect(() => {
		if (isLoadingExistingChat.current) {
			isLoadingExistingChat.current = false;
			return;
		}
		if (!activeChatId || messages.length === 0 || isLoading) return;

		if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
		saveTimeoutRef.current = setTimeout(() => {
			const typed: TypedUIMessage[] = messages.map((m) => ({
				id: m.id,
				role: m.role as "user" | "assistant" | "system",
				parts: (m.parts ?? []) as UIMessagePart[],
				createdAt: new Date(),
			}));
			saveMessagesRef.current(activeChatId, typed);
		}, 1000);
	}, [messages, activeChatId, isLoading]);

	useEffect(() => {
		if (!messages.length) return;
		const lastMessage = messages[messages.length - 1];
		if (lastMessage.role === "assistant") {
			const content = extractTextContent(
				(lastMessage.parts ?? []) as UIMessagePart[],
			);
			const match = content.match(
				/https:\/\/docs\.google\.com\/presentation\/d\/[a-zA-Z0-9-_]+/,
			);
			if (match) setPptUrl(match[0]);
		}
	}, [messages]);

	const handleSelectChat = useCallback(
		async (chatId: string) => {
			setActiveChatId(chatId);
			setChatSessionId("session-" + Date.now());
			const chatMessages = await selectChat(chatId);
			isLoadingExistingChat.current = true;
			setMessages(chatMessages as typeof messages);
			setPptUrl(null);
		},
		[selectChat, setMessages],
	);

	const handleNewChat = useCallback(() => {
		setActiveChatId(null);
		setChatSessionId("session-" + Date.now());
		setMessages([]);
		setInput("");
		setPptUrl(null);
	}, [setMessages]);

	const handleDeleteChat = useCallback(
		async (chatId: string) => {
			await deleteChat(chatId);
			if (chatId === activeChatId) {
				setActiveChatId(null);
				setChatSessionId("session-" + Date.now());
				setMessages([]);
				setPptUrl(null);
			}
		},
		[deleteChat, activeChatId, setMessages],
	);

	const handleSubmit = useCallback(
		async (event: FormEvent) => {
			event.preventDefault();
			if (isLoading) return;
			const trimmed = input.trim();
			if (!trimmed) return;

			let chatId = activeChatId;
			if (!chatId) {
				const newChat = await createChat(selectedModel);
				if (!newChat) return;
				chatId = newChat.id;
				setActiveChatId(chatId);
			}

			setInput("");
			await sendMessage(
				{ text: trimmed },
				{
					body: {
						model: selectedModel,
						framework: selectedFramework,
						chatId,
					},
				},
			);
		},
		[
			input,
			activeChatId,
			createChat,
			selectedModel,
			selectedFramework,
			sendMessage,
			isLoading,
		],
	);

	const quickActions = [
		{ label: "Analyze this dataset" },
		{ label: "Generate summary statistics" },
		{ label: "Find trends in the data" },
		{ label: "Create visualizations" },
	];

	const getFrameworkName = (frameworkId: string): string => {
		const frameworks: { [key: string]: string } = {
			"ai-sdk": "Vercel AI SDK",
			langchain: "LangChain",
			"openai-agents": "OpenAI Agents SDK",
			"claude-agents": "Claude Agents SDK",
		};
		return frameworks[frameworkId] || "Vercel AI SDK";
	};

	const isEmptyState = messages.length === 0 && !activeChatId;

	const sidebar = (
		<ChatSidebar
			chats={chats}
			currentChatId={activeChatId}
			onSelectChat={handleSelectChat}
			onNewChat={handleNewChat}
			onDeleteChat={handleDeleteChat}
			isCollapsed={sidebarCollapsed}
			onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
			isLoading={isLoadingChats}
		/>
	);

	if (isEmptyState) {
		return (
			<div className="h-screen w-full flex bg-ui-card font-sans overflow-hidden relative">
				{sidebar}

				<button
					onClick={() => setDarkMode(!darkMode)}
					className="absolute top-6 right-6 p-2 rounded-full hover:bg-ui-secondary transition-colors z-50"
					aria-label="Toggle dark mode"
				>
					{darkMode ? (
						<svg
							className="w-6 h-6 text-tx-primary"
							fill="currentColor"
							viewBox="0 0 24 24"
						>
							<path d="M12 3v1m0 16v1m9-9h-1m-16 0H1m15.657 5.657l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
						</svg>
					) : (
						<svg
							className="w-6 h-6 text-tx-primary"
							fill="currentColor"
							viewBox="0 0 24 24"
						>
							<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
						</svg>
					)}
				</button>

				<div className="flex-1 flex flex-col items-center justify-center p-4 max-w-3xl mx-auto">
					<h1 className="text-4xl md:text-5xl font-serif font-medium tracking-tight mb-2 text-tx-primary text-center">
						Data Analyst Agent
					</h1>
					<p className="text-sm md:text-base text-tx-secondary text-center mb-8">
						Powered by {getFrameworkName(selectedFramework)} and
						Fabric MCP
					</p>

					<ChatInput
						input={input}
						setInput={setInput}
						isLoading={isLoading}
						onSubmit={handleSubmit}
						selectedModel={selectedModel}
						setSelectedModel={setSelectedModel}
						selectedFramework={selectedFramework}
						setSelectedFramework={setSelectedFramework}
					/>

					<div className="mt-6 flex gap-2 justify-center">
						{quickActions.map((action) => (
							<button
								key={action.label}
								onClick={() => setInput(action.label)}
								className="flex items-center gap-2 px-4 py-2 bg-ui-secondary border border-ui-border rounded-full text-sm text-tx-secondary hover:bg-ui-border hover:text-tx-primary transition-all whitespace-nowrap"
							>
								<span>{action.label}</span>
							</button>
						))}
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="h-screen w-full flex bg-ui-card font-sans overflow-hidden">
			{sidebar}

			{/* Main Chat Area */}
			<div
				className={`flex-1 flex flex-col bg-ui-card relative z-10 transition-all duration-300 ${
					pptUrl ? "md:w-[400px] lg:w-[450px]" : ""
				}`}
			>
				{/* Messages with padding for button */}
				<div className="flex-1 overflow-y-auto space-y-6 scrollbar-hide pb-32 px-4 md:px-6 pt-20 relative">
					{/* Dark Mode Button - positioned absolutely within messages container */}
					<div className="absolute top-6 right-6 z-20">
						<button
							onClick={() => setDarkMode(!darkMode)}
							className="p-2 rounded-full hover:bg-ui-secondary transition-colors"
							aria-label="Toggle dark mode"
						>
							{darkMode ? (
								<svg
									className="w-6 h-6 text-tx-primary"
									fill="currentColor"
									viewBox="0 0 24 24"
								>
									<path d="M12 3v1m0 16v1m9-9h-1m-16 0H1m15.657 5.657l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z" />
								</svg>
							) : (
								<svg
									className="w-6 h-6 text-tx-primary"
									fill="currentColor"
									viewBox="0 0 24 24"
								>
									<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
								</svg>
							)}
						</button>
					</div>
					{messages.map((m) => (
						<ChatMessage key={m.id} message={m} />
					))}

					{/* Error State */}
					{chatError && (
						<div className="flex justify-start mb-6">
							<div className="max-w-[90%] rounded-2xl px-4 py-3 bg-red-50 border border-red-200">
								<div className="font-bold mb-1 font-serif text-sm text-red-800">
									Error
								</div>
								<div className="text-sm text-red-700">
									{chatError.message ||
										"Failed to get response from agent"}
								</div>
							</div>
						</div>
					)}

					{/* Loading State */}
					{isLoading &&
						messages.length > 0 &&
						messages[messages.length - 1].role === "user" && (
							<div className="flex justify-start mb-6">
								<div className="max-w-[90%] rounded-2xl px-4 py-3 bg-transparent pl-0">
									<div className="font-bold mb-1 font-serif text-sm text-[var(--color-syntax-string)]">
										Agent
									</div>
									<div className="flex items-center gap-2 py-2">
										<Loader variant="typing" size="sm" />
									</div>
								</div>
							</div>
						)}
				</div>

				{/* Input Area */}
				<div className="p-4 bg-ui-card border-t border-transparent">
					<ChatInput
						input={input}
						setInput={setInput}
						isLoading={isLoading}
						onSubmit={handleSubmit}
						selectedModel={selectedModel}
						setSelectedModel={setSelectedModel}
						selectedFramework={selectedFramework}
						setSelectedFramework={setSelectedFramework}
						compact
					/>
				</div>
			</div>

			{/* Right: Preview Pane */}
			{pptUrl && (
				<div className="hidden md:flex flex-1 bg-zinc-950 items-center justify-center relative overflow-hidden animate-in fade-in duration-500">
					<div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-[800px] h-[800px] bg-indigo-500/5 blur-[120px] rounded-full pointer-events-none" />

					<div className="w-full h-full bg-black shadow-2xl border-l border-white/10 flex flex-col overflow-hidden relative z-10">
						<div className="h-10 bg-zinc-900 border-b border-white/5 flex items-center px-4 justify-between select-none">
							<div className="flex gap-2">
								<div className="w-3 h-3 rounded-full bg-red-500/80" />
								<div className="w-3 h-3 rounded-full bg-yellow-500/80" />
								<div className="w-3 h-3 rounded-full bg-green-500/80" />
							</div>
							<div className="text-[10px] font-medium text-zinc-500 uppercase tracking-widest">
								Live Preview
							</div>
							<button
								onClick={() => setPptUrl(null)}
								className="text-zinc-500 hover:text-white transition-colors"
							>
								<svg
									xmlns="http://www.w3.org/2000/svg"
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<line x1="18" y1="6" x2="6" y2="18" />
									<line x1="6" y1="6" x2="18" y2="18" />
								</svg>
							</button>
						</div>

						<div className="flex-1 bg-white relative">
							<iframe
								src={pptUrl}
								className="absolute inset-0 w-full h-full"
								allowFullScreen
							/>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
