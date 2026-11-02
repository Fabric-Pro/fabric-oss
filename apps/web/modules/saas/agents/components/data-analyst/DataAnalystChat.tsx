"use client";

import { useChatgptPlanSpentAction } from "@saas/shared/components/copilot/use-chatgpt-plan-spent-action";
import { Button } from "@ui/components/button";
import { BarChart3, Database, TrendingUp } from "lucide-react";
import { useState } from "react";
import {
	Conversation,
	ConversationContent,
} from "../../../../../components/ai-elements/conversation";
import { DeferredResponse as Response } from "../../../../../components/ai-elements/deferred-response";
import { useDataAnalystChat } from "../../hooks/useDataAnalystChat";
import { ChatFailureNotice } from "../FabricChat/shared/ChatFailureNotice";
import { ChatInput } from "../FabricChat/shared/ChatInput";
import { ChatWelcome } from "../FabricChat/shared/ChatWelcome";
import { ToolCallList } from "../FabricChat/shared/ToolCallList";

const NO_REMOTE_IMAGES = { img: () => null };
const SUGGESTIONS = [
	{
		label: "Compare categories",
		value: "Chart a dataset by category",
		icon: <BarChart3 className="size-4" />,
	},
	{
		label: "Find a trend",
		value: "Show a trend by week",
		icon: <TrendingUp className="size-4" />,
	},
	{
		label: "Explore sources",
		value: "List my connected data sources",
		icon: <Database className="size-4" />,
	},
];

export function DataAnalystChat({
	organizationId,
}: {
	organizationId: string;
}) {
	const { messages, running, send, stop, reset } = useDataAnalystChat({
		organizationId,
	});
	const [input, setInput] = useState("");
	const planSpentAction = useChatgptPlanSpentAction();
	const composer = (
		<ChatInput
			value={input}
			onChange={setInput}
			onSend={() => {
				if (!input.trim() || running) {
					return;
				}
				void send(input);
				setInput("");
			}}
			isLoading={running}
			onStop={stop}
			variant="default"
			placeholder="Ask about your data…"
		/>
	);
	return (
		<div className="flex h-full min-h-0 flex-col">
			{messages.length === 0 ? (
				<ChatWelcome
					title="Data analyst"
					subtitle="Explore data from your connected integrations."
					categories={[]}
					suggestions={SUGGESTIONS}
					onSuggestionClick={setInput}
					composer={composer}
				/>
			) : (
				<>
					<div className="flex justify-end border-b px-4 py-2">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={reset}
						>
							New chat
						</Button>
					</div>
					<Conversation>
						<ConversationContent className="mx-auto w-full max-w-4xl space-y-6 p-4">
							{messages.map((message) =>
								message.role === "user" ? (
									<div
										key={message.id}
										className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-muted px-4 py-3"
									>
										{message.content}
									</div>
								) : (
									<div key={message.id} className="space-y-3">
										<ToolCallList
											toolCalls={message.turn.toolCalls}
										/>
										{message.turn.text && (
											<Response
												components={NO_REMOTE_IMAGES}
												streaming={
													message.turn.status ===
													"running"
												}
											>
												{message.turn.text}
											</Response>
										)}
										{message.turn.error && (
											<ChatFailureNotice
												error={message.turn.error}
												action={
													message.turn.planSpent
														? planSpentAction(
																message.turn
																	.planSpent,
																organizationId,
															)
														: undefined
												}
											/>
										)}
										{message.turn.status === "running" &&
											!message.turn.text && (
												<output className="text-sm text-muted-foreground">
													Analyzing…
												</output>
											)}
										{message.turn.status === "stopped" && (
											<p className="text-sm text-muted-foreground">
												Stopped
											</p>
										)}
									</div>
								),
							)}
						</ConversationContent>
					</Conversation>
					<div className="mx-auto w-full max-w-4xl px-4 pb-4">
						{composer}
					</div>
				</>
			)}
		</div>
	);
}
