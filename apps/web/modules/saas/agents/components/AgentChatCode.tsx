"use client";

/**
 * AgentChatCode - Code editor interface for Code Executor agent
 *
 * Features:
 * - Code editor on the LEFT side
 * - Chat interface on the RIGHT side
 * - Syntax highlighting
 * - Execution output panel
 * - AG-UI protocol for real-time updates
 */

import { CopilotKit, useCoAgent, useCopilotChat } from "@copilotkit/react-core";
import { CopilotSidebar } from "@copilotkit/react-ui";
import { CopilotAssistantMessage } from "@saas/shared/components/copilot/CopilotAssistantMessage";
import { useCopilotErrorHandler } from "@saas/shared/components/copilot/use-copilot-error-handler";
import "@copilotkit/react-ui/styles.css";
import { Badge } from "@ui/components/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Code2, Terminal } from "lucide-react";
import { useEffect, useState } from "react";
import { useHumanInLoop } from "../hooks/useHumanInLoop";
import { HITLDialog } from "./HITLDialog";
import type { ReasoningMode } from "./ReasoningModeSelector";

interface AgentChatCodeProps {
	agent: any;
	runtimeUrl: string;
	reasoningMode: ReasoningMode;
	onReasoningModeChange: (mode: ReasoningMode) => void;
}

interface AgentState {
	code?: string;
	output?: string;
	error?: string;
	isExecuting?: boolean;
}

export function AgentChatCode({ agent, runtimeUrl }: AgentChatCodeProps) {
	const onError = useCopilotErrorHandler();

	return (
		<div className="h-full w-full">
			<CopilotKit
				runtimeUrl={runtimeUrl}
				agent={agent?.agentId}
				showDevConsole={false}
				onError={onError}
			>
				<CodeEditorContent agent={agent} />
			</CopilotKit>
		</div>
	);
}

function CodeEditorContent({ agent }: { agent: any }) {
	const [code, setCode] = useState(
		"// Write your code here\nconsole.log('Hello, World!');",
	);
	const [output, setOutput] = useState("");
	const { isLoading: _isLoading } = useCopilotChat();

	const { state: agentState } = useCoAgent<AgentState>({
		name: agent?.agentId || "code_executor",
		initialState: {
			code: "",
			output: "",
			error: undefined,
			isExecuting: false,
		},
	});

	// HITL hook
	const { pendingRequest, hasActiveRequest, respond, dismiss } =
		useHumanInLoop({
			defaultTimeout: 60000,
		});

	// Update code from agent state
	useEffect(() => {
		if (agentState?.code) {
			setCode(agentState.code);
		}
	}, [agentState?.code]);

	// Update output from agent state
	useEffect(() => {
		if (agentState?.output) {
			setOutput(agentState.output);
		}
	}, [agentState?.output]);

	return (
		<>
			<div className="flex h-full">
				{/* LEFT: Code Editor */}
				<div className="flex-1 flex flex-col border-r">
					{/* Editor Toolbar */}
					<div className="border-b px-4 py-2 flex items-center justify-between bg-muted/30">
						<div className="flex items-center gap-2">
							<Code2 className="h-4 w-4" />
							<h3 className="text-sm font-medium">Code Editor</h3>
						</div>
						<div className="flex items-center gap-2">
							<Badge variant="outline" className="text-xs">
								JavaScript
							</Badge>
							{agentState?.isExecuting && (
								<Badge variant="secondary" className="text-xs">
									Executing...
								</Badge>
							)}
						</div>
					</div>

					{/* Code Editor */}
					<div className="flex-1 overflow-auto">
						<textarea
							value={code}
							onChange={(e) => setCode(e.target.value)}
							className="w-full h-full p-4 font-mono text-sm bg-background resize-none focus:outline-none"
							spellCheck={false}
						/>
					</div>

					{/* Output Panel */}
					<Tabs defaultValue="output" className="border-t">
						<div className="border-b px-4">
							<TabsList>
								<TabsTrigger value="output">
									<Terminal className="h-3 w-3 mr-2" />
									Output
								</TabsTrigger>
								<TabsTrigger value="errors">Errors</TabsTrigger>
							</TabsList>
						</div>

						<TabsContent
							value="output"
							className="p-4 max-h-64 overflow-auto"
						>
							<pre className="text-xs font-mono whitespace-pre-wrap">
								{output ||
									"No output yet. Run your code to see results."}
							</pre>
						</TabsContent>

						<TabsContent
							value="errors"
							className="p-4 max-h-64 overflow-auto"
						>
							<pre className="text-xs font-mono text-destructive whitespace-pre-wrap">
								{agentState?.error || "No errors"}
							</pre>
						</TabsContent>
					</Tabs>
				</div>

				{/* RIGHT: Chat Sidebar */}
				<div className="w-96">
					<CopilotSidebar
						AssistantMessage={CopilotAssistantMessage}
						defaultOpen={true}
						clickOutsideToClose={false}
						labels={{
							title: agent?.displayName || "Code Executor",
							initial:
								"Hi! I can help you write and execute code. What would you like to build?",
						}}
						suggestions={[
							{
								title: "Calculate",
								message:
									"Write code to calculate fibonacci numbers",
							},
							{
								title: "Transform data",
								message: "Help me transform this JSON data",
							},
							{
								title: "API call",
								message: "Make an API call to fetch user data",
							},
						]}
					>
						<div />
					</CopilotSidebar>
				</div>
			</div>

			{/* HITL Dialog */}
			<HITLDialog
				request={pendingRequest}
				open={hasActiveRequest}
				onRespond={respond}
				onDismiss={dismiss}
			/>
		</>
	);
}
