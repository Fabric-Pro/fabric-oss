"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Loader } from "@/components/ui/loader";
import { ToolCallPreview } from "./tool-call-preview";
import { extractTextContent, type UIMessagePart } from "@/lib/types";
import type { UIMessage } from "ai";

interface ChatMessageProps {
	message: UIMessage;
}

interface ToolInvocationPart {
	type: "tool-invocation";
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	state: string;
	result?: unknown;
}

export function ChatMessage({ message }: ChatMessageProps) {
	const isUser = message.role === "user";
	const parts = (message.parts ?? []) as UIMessagePart[];
	const text = extractTextContent(parts);
	const toolParts = parts.filter(
		(p): p is ToolInvocationPart => p.type === "tool-invocation",
	);
	const fileParts = parts.filter((p) => p.type === "file");

	return (
		<div
			className={`flex ${isUser ? "justify-end" : "justify-start"} mb-6`}
		>
			<div
				className={`max-w-[90%] rounded-2xl px-4 py-3 ${
					isUser
						? "bg-ui-secondary text-tx-primary"
						: "bg-transparent pl-0"
				}`}
			>
				{text ? (
					<ReactMarkdown
						remarkPlugins={[remarkGfm]}
						className="text-tx-primary text-sm leading-relaxed space-y-1 [&_*]:font-inherit [&_strong]:font-semibold [&_em]:italic [&_code]:font-mono [&_code]:bg-ui-secondary [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_p]:mb-2 [&_ul]:pl-5 [&_ul]:mb-2 [&_ul]:list-disc [&_ol]:pl-5 [&_ol]:mb-2 [&_ol]:list-decimal [&_li]:mb-1 [&_li]:pl-1 [&_img]:max-w-full [&_img]:h-auto [&_img]:rounded-lg [&_img]:border [&_img]:border-ui-border [&_img]:mt-2 [&_img]:cursor-pointer [&_img]:hover:border-tx-primary [&_table]:w-full [&_table]:border-collapse [&_table]:my-3 [&_th]:bg-ui-secondary [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:border [&_th]:border-ui-border [&_th]:font-semibold [&_td]:px-3 [&_td]:py-2 [&_td]:border [&_td]:border-ui-border [&_tr]:hover:bg-ui-secondary/50"
						components={{
							a: ({ ...props }) => (
								<a
									{...props}
									className={`text-blue-600 hover:underline break-words ${props.className ?? ""}`}
									target="_blank"
									rel="noopener noreferrer"
								/>
							),
							img: ({ ...props }) => (
								<a
									href={
										typeof props.src === "string"
											? props.src
											: undefined
									}
									target="_blank"
									rel="noopener noreferrer"
									className="inline-block"
								>
									<img
										{...props}
										alt={props.alt || "Image"}
										className="max-w-sm h-auto rounded-lg border border-ui-border mt-2 cursor-pointer hover:border-tx-primary transition-colors"
									/>
								</a>
							),
						}}
					>
						{text}
					</ReactMarkdown>
				) : (
					!isUser &&
					toolParts.length === 0 && (
						<div className="flex items-center gap-2 py-2">
							<Loader variant="typing" size="sm" />
							<span className="text-xs text-tx-secondary">
								Thinking...
							</span>
						</div>
					)
				)}

				{fileParts.map((filePart, idx) => (
					<div key={`${filePart.url}-${idx}`} className="mt-3">
						{filePart.mimeType.startsWith("image/") ? (
							<a
								href={filePart.url}
								target="_blank"
								rel="noopener noreferrer"
								className="inline-block cursor-pointer"
							>
								<img
									src={filePart.url}
									alt="Analysis result"
									className="max-w-full h-auto rounded-lg border border-ui-border hover:border-tx-primary transition-colors"
								/>
							</a>
						) : (
							<a
								href={filePart.url}
								target="_blank"
								rel="noopener noreferrer"
								className="text-blue-600 hover:underline break-words"
							>
								Download file
							</a>
						)}
					</div>
				))}

				{toolParts.map((toolPart) => (
					<div key={toolPart.toolCallId} className="mt-2">
						<ToolCallPreview toolPart={toolPart} />
					</div>
				))}
			</div>
		</div>
	);
}
