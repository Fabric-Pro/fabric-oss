"use client";

/**
 * AgentChatAPI - Specialized interface for API Agent
 *
 * Features:
 * - Request/response panel (Postman-style)
 * - Endpoint input field
 * - HTTP method selector
 * - Headers editor
 * - Response viewer with syntax highlighting
 * - Chat interface for natural language API testing
 */

import { CopilotKit } from "@copilotkit/react-core";
import { CopilotSidebar } from "@copilotkit/react-ui";
import { CopilotAssistantMessage } from "@saas/shared/components/copilot/CopilotAssistantMessage";
import { useCopilotErrorHandler } from "@saas/shared/components/copilot/use-copilot-error-handler";
import "@copilotkit/react-ui/styles.css";
import { Badge } from "@ui/components/badge";
import { Button } from "@ui/components/button";
import { Input } from "@ui/components/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@ui/components/tabs";
import { Textarea } from "@ui/components/textarea";
import { Send } from "lucide-react";
import { useState } from "react";
import { useHumanInLoop } from "../hooks/useHumanInLoop";
import { HITLDialog } from "./HITLDialog";
import type { ReasoningMode } from "./ReasoningModeSelector";

interface AgentChatAPIProps {
	agent: any;
	runtimeUrl: string;
	reasoningMode: ReasoningMode;
	onReasoningModeChange: (mode: ReasoningMode) => void;
}

export function AgentChatAPI({ agent, runtimeUrl }: AgentChatAPIProps) {
	const onError = useCopilotErrorHandler();

	return (
		<div className="h-full w-full">
			<CopilotKit
				runtimeUrl={runtimeUrl}
				agent={agent?.agentId}
				showDevConsole={false}
				onError={onError}
			>
				<APIAgentContent agent={agent} />
			</CopilotKit>
		</div>
	);
}

function APIAgentContent({ agent }: { agent: any }) {
	const [method, setMethod] = useState("GET");
	const [endpoint, setEndpoint] = useState("");
	const [headers, setHeaders] = useState("{}");
	const [body, setBody] = useState("");
	const [response, setResponse] = useState<any>(null);
	const [isExecuting, setIsExecuting] = useState(false);

	// HITL hook
	const { pendingRequest, hasActiveRequest, respond, dismiss } =
		useHumanInLoop({
			defaultTimeout: 60000,
		});

	const handleExecute = async () => {
		setIsExecuting(true);
		// TODO: Integrate with API Agent execution
		setTimeout(() => {
			setResponse({
				status: 200,
				statusText: "OK",
				data: {
					message: "API execution will be integrated with the agent",
				},
			});
			setIsExecuting(false);
		}, 1000);
	};

	return (
		<>
			<div className="flex h-full">
				{/* LEFT: API Request Panel */}
				<div className="flex-1 flex flex-col border-r">
					{/* Request Builder */}
					<div className="border-b p-4 space-y-4">
						<h3 className="text-sm font-semibold">
							API Request Builder
						</h3>

						{/* Method + Endpoint */}
						<div className="flex gap-2">
							<Select value={method} onValueChange={setMethod}>
								<SelectTrigger className="w-32">
									<SelectValue />
								</SelectTrigger>
								<SelectContent>
									<SelectItem value="GET">GET</SelectItem>
									<SelectItem value="POST">POST</SelectItem>
									<SelectItem value="PUT">PUT</SelectItem>
									<SelectItem value="PATCH">PATCH</SelectItem>
									<SelectItem value="DELETE">
										DELETE
									</SelectItem>
								</SelectContent>
							</Select>
							<Input
								placeholder="https://api.example.com/endpoint"
								value={endpoint}
								onChange={(e) => setEndpoint(e.target.value)}
								className="flex-1"
							/>
							<Button
								onClick={handleExecute}
								disabled={!endpoint || isExecuting}
							>
								<Send className="h-4 w-4 mr-2" />
								Send
							</Button>
						</div>
					</div>

					{/* Request Details */}
					<Tabs
						defaultValue="headers"
						className="flex-1 flex flex-col"
					>
						<div className="border-b px-4">
							<TabsList>
								<TabsTrigger value="headers">
									Headers
								</TabsTrigger>
								<TabsTrigger value="body">Body</TabsTrigger>
							</TabsList>
						</div>

						<TabsContent value="headers" className="flex-1 p-4">
							<Textarea
								placeholder='{"Content-Type": "application/json"}'
								value={headers}
								onChange={(e) => setHeaders(e.target.value)}
								className="font-mono text-sm h-full resize-none"
							/>
						</TabsContent>

						<TabsContent value="body" className="flex-1 p-4">
							<Textarea
								placeholder='{"key": "value"}'
								value={body}
								onChange={(e) => setBody(e.target.value)}
								className="font-mono text-sm h-full resize-none"
							/>
						</TabsContent>
					</Tabs>

					{/* Response Panel */}
					{response && (
						<div className="border-t p-4 max-h-96 overflow-auto">
							<div className="flex items-center justify-between mb-3">
								<h3 className="text-sm font-semibold">
									Response
								</h3>
								<Badge
									variant={
										response.status < 400
											? "default"
											: "destructive"
									}
								>
									{response.status} {response.statusText}
								</Badge>
							</div>
							<pre className="bg-muted p-4 rounded-lg text-xs font-mono overflow-auto">
								{JSON.stringify(response.data, null, 2)}
							</pre>
						</div>
					)}
				</div>

				{/* RIGHT: Chat Sidebar */}
				<div className="w-96">
					<CopilotSidebar
						AssistantMessage={CopilotAssistantMessage}
						defaultOpen={true}
						clickOutsideToClose={false}
						labels={{
							title: agent?.displayName || "API Agent",
							initial:
								"Hi! I can help you test APIs, validate responses, and generate API documentation. What would you like to do?",
						}}
						suggestions={[
							{
								title: "Test endpoint",
								message: "Test my REST endpoint at /api/users",
							},
							{
								title: "Generate docs",
								message:
									"Generate API documentation from my OpenAPI spec",
							},
							{
								title: "Validate spec",
								message: "Validate my OpenAPI specification",
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
