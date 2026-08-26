"use client";

/**
 * CugaHitlDialog
 *
 * Human-in-the-loop dialog for CUGA agent requests.
 * Supports approval, input, confirmation, and selection types.
 */

import { Badge } from "@ui/components/badge";
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
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { cn } from "@ui/lib";
import { AlertTriangle, CheckCircle2, HelpCircle, Shield } from "lucide-react";
import { useState } from "react";
import type { CugaHitlRequest } from "./types";

interface CugaHitlDialogProps {
	request: CugaHitlRequest;
	onRespond: (response: CugaHitlRequest["response"]) => void;
	onCancel?: () => void;
}

const RISK_CONFIG = {
	low: {
		icon: <CheckCircle2 className="h-5 w-5" />,
		color: "text-success",
		bg: "bg-green-50 dark:bg-green-900/20",
	},
	medium: {
		icon: <HelpCircle className="h-5 w-5" />,
		color: "text-yellow-500",
		bg: "bg-yellow-50 dark:bg-yellow-900/20",
	},
	high: {
		icon: <AlertTriangle className="h-5 w-5" />,
		color: "text-orange-500",
		bg: "bg-orange-50 dark:bg-orange-900/20",
	},
	critical: {
		icon: <Shield className="h-5 w-5" />,
		color: "text-destructive",
		bg: "bg-red-50 dark:bg-red-900/20",
	},
};

export function CugaHitlDialog({
	request,
	onRespond,
	onCancel,
}: CugaHitlDialogProps) {
	const [inputValue, setInputValue] = useState(request.defaultValue || "");
	const [selectedOption, setSelectedOption] = useState<string | undefined>();

	const riskLevel = request.context?.riskLevel || "medium";
	const riskConfig = RISK_CONFIG[riskLevel];

	const handleApprove = () => {
		onRespond({ approved: true });
	};

	const handleReject = () => {
		onRespond({ approved: false });
	};

	const handleSubmitInput = () => {
		onRespond({ value: inputValue });
	};

	const handleSubmitSelection = () => {
		if (selectedOption) {
			onRespond({ selectedOptionId: selectedOption });
		}
	};

	return (
		<Dialog
			open={request.pending}
			onOpenChange={(open) => !open && onCancel?.()}
		>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<div
						className={cn(
							"flex items-center gap-3 p-3 rounded-lg mb-2",
							riskConfig.bg,
						)}
					>
						<div className={riskConfig.color}>
							{riskConfig.icon}
						</div>
						<div>
							<DialogTitle className="text-base">
								{request.type === "approval" &&
									"Action Approval Required"}
								{request.type === "input" && "Input Required"}
								{request.type === "confirmation" &&
									"Please Confirm"}
								{request.type === "selection" &&
									"Selection Required"}
							</DialogTitle>
							{request.context?.action && (
								<Badge
									variant="outline"
									className="mt-1 text-xs"
								>
									{request.context.action}
								</Badge>
							)}
						</div>
					</div>
					<DialogDescription className="text-sm pt-2">
						{request.message}
					</DialogDescription>
				</DialogHeader>

				{/* Input Type */}
				{request.type === "input" && (
					<div className="py-4">
						<Input
							value={inputValue}
							onChange={(e) => setInputValue(e.target.value)}
							placeholder="Enter your response..."
							className="w-full"
						/>
					</div>
				)}

				{/* Selection Type */}
				{request.type === "selection" && request.options && (
					<div className="py-4">
						<RadioGroup
							value={selectedOption}
							onValueChange={setSelectedOption}
						>
							{request.options.map((option) => (
								<div
									key={option.id}
									className="flex items-start space-x-3 p-2 rounded hover:bg-muted"
								>
									<RadioGroupItem
										value={option.id}
										id={option.id}
									/>
									<Label
										htmlFor={option.id}
										className="flex-1 cursor-pointer"
									>
										<span className="font-medium">
											{option.label}
										</span>
										{option.description && (
											<p className="text-xs text-muted-foreground mt-0.5">
												{option.description}
											</p>
										)}
									</Label>
								</div>
							))}
						</RadioGroup>
					</div>
				)}

				<DialogFooter className="gap-2 sm:gap-0">
					{(request.type === "approval" ||
						request.type === "confirmation") && (
						<>
							<Button variant="outline" onClick={handleReject}>
								{request.type === "approval"
									? "Reject"
									: "Cancel"}
							</Button>
							<Button onClick={handleApprove}>
								{request.type === "approval"
									? "Approve"
									: "Confirm"}
							</Button>
						</>
					)}
					{request.type === "input" && (
						<>
							<Button variant="outline" onClick={onCancel}>
								Cancel
							</Button>
							<Button
								onClick={handleSubmitInput}
								disabled={!inputValue.trim()}
							>
								Submit
							</Button>
						</>
					)}
					{request.type === "selection" && (
						<>
							<Button variant="outline" onClick={onCancel}>
								Cancel
							</Button>
							<Button
								onClick={handleSubmitSelection}
								disabled={!selectedOption}
							>
								Select
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
