"use client";

/**
 * HITLDialog Component
 *
 * Human-in-the-Loop dialog for AI agent interactions.
 * Supports approval, input, and choice request types.
 */

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Progress } from "@ui/components/progress";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { Textarea } from "@ui/components/textarea";
import { cn } from "@ui/lib";
import {
	AlertCircle,
	CheckCircle2,
	Clock,
	HelpCircle,
	XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import type { HITLRequest } from "../hooks/useHumanInLoop";

interface HITLDialogProps {
	/** The current HITL request */
	request: HITLRequest | null;
	/** Whether the dialog is open */
	open: boolean;
	/** Callback when user responds */
	onRespond: (approved: boolean, value?: string | string[]) => void;
	/** Callback when dialog is dismissed */
	onDismiss: () => void;
}

export function HITLDialog({
	request,
	open,
	onRespond,
	onDismiss,
}: HITLDialogProps) {
	const [inputValue, setInputValue] = useState("");
	const [selectedOption, setSelectedOption] = useState<string>("");
	const [timeRemaining, setTimeRemaining] = useState<number>(0);
	const [progress, setProgress] = useState(100);

	// Reset state when request changes
	useEffect(() => {
		if (request) {
			setInputValue(request.defaultValue ?? "");
			setSelectedOption(request.options?.[0]?.value ?? "");
			setTimeRemaining(request.timeout ?? 60000);
			setProgress(100);
		}
	}, [request]);

	// Countdown timer
	useEffect(() => {
		if (!request || !open || !request.timeout) {
			return;
		}

		const startTime = request.createdAt;
		const timeout = request.timeout;

		const interval = setInterval(() => {
			const elapsed = Date.now() - startTime;
			const remaining = Math.max(0, timeout - elapsed);
			setTimeRemaining(remaining);
			setProgress((remaining / timeout) * 100);

			if (remaining <= 0) {
				clearInterval(interval);
				onDismiss();
			}
		}, 100);

		return () => clearInterval(interval);
	}, [request, open, onDismiss]);

	if (!request) {
		return null;
	}

	const handleApprove = () => {
		if (request.type === "input") {
			onRespond(true, inputValue);
		} else if (request.type === "choice") {
			onRespond(true, selectedOption);
		} else {
			onRespond(true);
		}
	};

	const handleReject = () => {
		onRespond(false);
	};

	const getIcon = () => {
		switch (request.type) {
			case "approval":
				return <AlertCircle className="h-6 w-6 text-highlight" />;
			case "input":
				return <HelpCircle className="h-6 w-6 text-blue-500" />;
			case "choice":
				return <CheckCircle2 className="h-6 w-6 text-success" />;
			default:
				return <HelpCircle className="h-6 w-6 text-muted-foreground" />;
		}
	};

	const getTitle = () => {
		if (request.title) {
			return request.title;
		}
		switch (request.type) {
			case "approval":
				return "Approval Required";
			case "input":
				return "Input Required";
			case "choice":
				return "Selection Required";
			default:
				return "Action Required";
		}
	};

	return (
		<Dialog open={open} onOpenChange={(isOpen) => !isOpen && onDismiss()}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<div className="flex items-center gap-3">
						{getIcon()}
						<DialogTitle>{getTitle()}</DialogTitle>
					</div>
					<DialogDescription className="pt-2">
						{request.prompt}
					</DialogDescription>
				</DialogHeader>

				{/* Timeout progress bar */}
				{request.timeout && (
					<div className="space-y-1">
						<div className="flex items-center justify-between text-xs text-muted-foreground">
							<span className="flex items-center gap-1">
								<Clock className="h-3 w-3" />
								Time remaining
							</span>
							<span>{Math.ceil(timeRemaining / 1000)}s</span>
						</div>
						<Progress value={progress} className="h-1" />
					</div>
				)}

				{/* Input field for input type */}
				{request.type === "input" && (
					<div className="py-4">
						{request.context?.multiline ? (
							<Textarea
								value={inputValue}
								onChange={(e) => setInputValue(e.target.value)}
								placeholder="Enter your response..."
								className="min-h-[100px]"
							/>
						) : (
							<Input
								value={inputValue}
								onChange={(e) => setInputValue(e.target.value)}
								placeholder="Enter your response..."
							/>
						)}
					</div>
				)}

				{/* Choice options for choice type */}
				{request.type === "choice" && request.options && (
					<div className="py-4">
						<RadioGroup
							value={selectedOption}
							onValueChange={setSelectedOption}
							className="space-y-3"
						>
							{request.options.map((option) => (
								<div
									key={option.value}
									className={cn(
										"flex items-start space-x-3 rounded-lg border p-3 transition-colors",
										selectedOption === option.value
											? "border-primary bg-primary/5"
											: "border-border hover:bg-muted/50",
									)}
								>
									<RadioGroupItem
										value={option.value}
										id={option.value}
										className="mt-0.5"
									/>
									<Label
										htmlFor={option.value}
										className="flex-1 cursor-pointer"
									>
										<div className="font-medium">
											{option.label}
										</div>
										{option.description && (
											<div className="text-sm text-muted-foreground">
												{option.description}
											</div>
										)}
									</Label>
								</div>
							))}
						</RadioGroup>
					</div>
				)}

				{/* Context display */}
				{request.context &&
					Object.keys(request.context).length > 0 &&
					request.type === "approval" && (
						<div className="rounded-lg bg-muted/50 p-3 text-sm">
							<div className="font-medium mb-2">
								Additional Context:
							</div>
							<pre className="whitespace-pre-wrap text-muted-foreground">
								{JSON.stringify(request.context, null, 2)}
							</pre>
						</div>
					)}

				<DialogFooter className="gap-2 sm:gap-0">
					<Button variant="outline" onClick={handleReject}>
						<XCircle className="mr-2 h-4 w-4" />
						{request.type === "approval" ? "Reject" : "Cancel"}
					</Button>
					<Button onClick={handleApprove}>
						<CheckCircle2 className="mr-2 h-4 w-4" />
						{request.type === "approval" ? "Approve" : "Submit"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
