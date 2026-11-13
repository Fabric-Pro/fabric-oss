"use client";

/**
 * CreatePlanForm - Form for creating a new weave plan
 * Includes AI-powered refinement and template support.
 */

import { AnsweredByModel } from "@saas/agents/components/FabricChat/shared/AnsweredByModel";

import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@ui/components/collapsible";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { ScrollArea } from "@ui/components/scroll-area";
import { Textarea } from "@ui/components/textarea";
import {
	BookmarkIcon,
	CheckCircle2Icon,
	CheckIcon,
	ChevronDownIcon,
	Loader2Icon,
	MessageSquareIcon,
	SendIcon,
	SparklesIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useWeaveRefinement } from "../hooks/useWeaveRefinement";

const BUBBLE_CLASSES = "text-sm rounded-md px-3 py-2 whitespace-pre-wrap";
const ASSISTANT_BUBBLE_CLASSES =
	"bg-card text-muted-foreground mr-6 border border-border";

interface CreatePlanFormProps {
	onSubmit: (data: {
		name: string;
		description?: string;
		message: string;
	}) => void;
	isSubmitting: boolean;
	projectId: string;
	storyId?: string;
	taskId?: string;
}

export function CreatePlanForm({
	onSubmit,
	isSubmitting,
	projectId,
	storyId: _storyId,
	taskId: _taskId,
}: CreatePlanFormProps) {
	const { basePath, organizationId } = useOrganizationContext();
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [message, setMessage] = useState("");

	// Refinement chat state
	const [showRefinement, setShowRefinement] = useState(false);
	const [refinementInput, setRefinementInput] = useState("");
	const scrollEndRef = useRef<HTMLDivElement>(null);
	// Lives in the form, not the collapsible panel, so a reply still lands
	// while the panel is closed.
	const refinement = useWeaveRefinement({
		projectId,
		onUpdatedMessage: setMessage,
	});

	// Fetch templates for this project
	const { data: templatesData } = useQuery({
		queryKey: ["weave-templates", projectId, organizationId],
		queryFn: async () => {
			return await orpcClient.weave.templates.list({
				projectId,
				organizationId: organizationId ?? null,
			});
		},
	});
	const templates = templatesData?.templates ?? [];

	const applyTemplate = useCallback(
		async (templateId: string) => {
			try {
				const result = await orpcClient.weave.templates.use({
					templateId,
					organizationId: organizationId ?? null,
				});
				setName(result.template.name);
				setDescription(result.template.description ?? "");
				setMessage(result.template.message ?? "");
				toast.success(
					"Template applied — edit as needed before creating.",
				);
			} catch {
				toast.error("Failed to load template");
			}
		},
		[organizationId],
	);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (!name.trim() || !message.trim()) {
			return;
		}
		onSubmit({ name, description, message });
	};

	// Auto-scroll to the latest message
	useEffect(() => {
		if (scrollEndRef.current) {
			scrollEndRef.current.scrollIntoView({ behavior: "smooth" });
		}
	}, [refinement.messages, refinement.isThinking, refinement.pendingReply]);

	const { isThinking, send: sendRefinement } = refinement;
	const handleSendRefinement = useCallback(async () => {
		const trimmed = refinementInput.trim();
		if (!trimmed || isThinking) {
			return;
		}

		if (!message.trim()) {
			toast.error(
				"Write your initial request first, then use refinement to improve it.",
			);
			return;
		}

		setRefinementInput("");
		await sendRefinement({
			refinementInput: trimmed,
			currentMessage: message,
		});
	}, [refinementInput, isThinking, message, sendRefinement]);

	const handleRefinementKeyDown = (
		e: React.KeyboardEvent<HTMLInputElement>,
	) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSendRefinement();
		}
	};

	const handleFinalizeRefinement = () => {
		setShowRefinement(false);
	};

	const examplePrompts = [
		"Add user authentication with JWT tokens",
		"Create a REST API endpoint for user profiles",
		"Implement database migration for orders table",
		"Fix the login form validation bug",
	];

	return (
		<form onSubmit={handleSubmit} className="space-y-4">
			{templates.length > 0 && (
				<div className="space-y-2">
					<Label className="flex items-center gap-1.5">
						<BookmarkIcon className="size-3.5" />
						From Template
					</Label>
					<div className="flex flex-wrap gap-2">
						{templates.slice(0, 6).map((tpl) => (
							<button
								key={tpl.id}
								type="button"
								onClick={() => applyTemplate(tpl.id)}
								className="text-xs px-2.5 py-1.5 bg-primary/5 border border-primary/15 rounded-md hover:bg-primary/10 transition-colors text-left"
							>
								{tpl.name}
								{tpl.useCount > 0 && (
									<span className="ml-1 text-muted-foreground">
										({tpl.useCount})
									</span>
								)}
							</button>
						))}
					</div>
				</div>
			)}

			<div className="space-y-2">
				<Label htmlFor="name">Plan Name</Label>
				<Input
					id="name"
					placeholder="e.g., Add user authentication feature"
					value={name}
					onChange={(e) => setName(e.target.value)}
					required
				/>
			</div>

			<div className="space-y-2">
				<Label htmlFor="description">Description (optional)</Label>
				<Textarea
					id="description"
					placeholder="Brief description of what this plan should accomplish..."
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					rows={2}
				/>
			</div>

			<div className="space-y-2">
				<Label htmlFor="message">Request</Label>
				<Textarea
					id="message"
					placeholder="Describe what you want the agents to do in detail..."
					value={message}
					onChange={(e) => setMessage(e.target.value)}
					rows={5}
					required
					className="font-mono text-sm"
				/>
				<p className="text-xs leading-5 text-muted-foreground">
					Want to make this workflow reusable later? Save repeatable
					instructions in{" "}
					<Link
						href={`${basePath}/prompts`}
						className="text-primary hover:underline"
					>
						Prompts
					</Link>{" "}
					or reusable capabilities in{" "}
					<Link
						href={`${basePath}/skills`}
						className="text-primary hover:underline"
					>
						Skills
					</Link>
					.
				</p>
			</div>

			{/* Conversational refinement panel */}
			<Collapsible open={showRefinement} onOpenChange={setShowRefinement}>
				<CollapsibleTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="w-full justify-between text-muted-foreground hover:text-foreground"
					>
						<span className="flex items-center gap-2">
							<MessageSquareIcon className="size-4" />
							{showRefinement
								? "Hide refinement"
								: "Refine request with AI"}
						</span>
						<ChevronDownIcon
							className="size-4 transition-transform duration-200"
							style={{
								transform: showRefinement
									? "rotate(180deg)"
									: "rotate(0deg)",
							}}
						/>
					</Button>
				</CollapsibleTrigger>

				<CollapsibleContent>
					<div className="mt-2 rounded-md border border-border bg-muted/50 p-3 space-y-3">
						<p className="text-xs text-muted-foreground">
							AI will ask clarifying questions and improve your
							request for better plan quality.
						</p>

						{refinement.isReady && (
							<div className="flex items-center gap-2 rounded-md bg-success/10 border border-success/20 px-3 py-2 text-sm text-success">
								<CheckCircle2Icon className="size-4 shrink-0" />
								Request looks clear — ready to create plan.
							</div>
						)}

						{/* Message list */}
						{refinement.messages.length > 0 && (
							<ScrollArea className="max-h-56">
								<div className="space-y-2 pr-2">
									{refinement.messages.map((msg, idx) => (
										<div
											key={`${msg.role}-${idx}`}
											className={`${BUBBLE_CLASSES} ${
												msg.role === "user"
													? "bg-primary/10 text-foreground ml-6"
													: ASSISTANT_BUBBLE_CLASSES
											}`}
										>
											{msg.content}
											{msg.role === "assistant" && (
												<AnsweredByModel
													model={msg.model}
												/>
											)}
										</div>
									))}
									{isThinking &&
										(refinement.pendingReply ? (
											<div
												className={`${BUBBLE_CLASSES} ${ASSISTANT_BUBBLE_CLASSES}`}
											>
												{refinement.pendingReply}
											</div>
										) : (
											<div
												className={`${BUBBLE_CLASSES} ${ASSISTANT_BUBBLE_CLASSES} flex items-center gap-2`}
											>
												<Loader2Icon className="size-3 animate-spin" />
												Thinking…
											</div>
										))}
									<div ref={scrollEndRef} />
								</div>
							</ScrollArea>
						)}

						{/* Refinement input */}
						<div className="flex gap-2">
							<Input
								placeholder="Add more context or constraints…"
								value={refinementInput}
								onChange={(e) =>
									setRefinementInput(e.target.value)
								}
								onKeyDown={handleRefinementKeyDown}
								disabled={isThinking}
								className="text-sm"
							/>
							<Button
								type="button"
								size="sm"
								variant="outline"
								onClick={handleSendRefinement}
								disabled={!refinementInput.trim() || isThinking}
								aria-label="Send refinement"
							>
								<SendIcon className="size-4" />
							</Button>
						</div>

						{/* Finalize button — shown after at least one exchange */}
						{refinement.messages.length >= 2 && (
							<Button
								type="button"
								size="sm"
								variant="secondary"
								className="w-full"
								onClick={handleFinalizeRefinement}
							>
								<CheckIcon className="size-4 mr-2" />
								Use refined request
							</Button>
						)}
					</div>
				</CollapsibleContent>
			</Collapsible>

			<div className="space-y-2">
				<p className="text-sm text-muted-foreground">
					Example prompts:
				</p>
				<div className="flex flex-wrap gap-2">
					{examplePrompts.map((prompt) => (
						<button
							key={prompt}
							type="button"
							onClick={() => {
								setMessage(prompt);
								setName(prompt.slice(0, 50));
							}}
							className="text-xs px-2 py-1 bg-muted rounded-md hover:bg-muted/80 transition-colors text-left"
						>
							{prompt}
						</button>
					))}
				</div>
			</div>

			<Button
				type="submit"
				className="w-full"
				disabled={isSubmitting || !name.trim() || !message.trim()}
			>
				{isSubmitting ? (
					<>
						<Loader2Icon className="size-4 mr-2 animate-spin" />
						Creating Plan...
					</>
				) : (
					<>
						<SparklesIcon className="size-4 mr-2" />
						Create Plan
					</>
				)}
			</Button>

			<p className="text-xs text-muted-foreground text-center">
				This will analyze complexity and create a step-by-step execution
				plan. You'll review and approve it before execution begins.
			</p>
		</form>
	);
}
