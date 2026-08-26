"use client";

import { Spinner } from "@shared/components/Spinner";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation } from "@tanstack/react-query";
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
import { Switch } from "@ui/components/switch";
import { PlayIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

type TemplateParameter = {
	name: string;
	type: "string" | "number" | "boolean" | "url" | "selector" | "json";
	description?: string;
	required: boolean;
	defaultValue?: unknown;
};

type AutomationTemplate = {
	id: string;
	name: string;
	description: string | null;
	parameters?: TemplateParameter[] | null;
};

type Props = {
	template: AutomationTemplate | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	organizationId?: string;
};

export function ExecuteTemplateDialog({
	template,
	open,
	onOpenChange,
	organizationId,
}: Props) {
	const [parameterValues, setParameterValues] = useState<
		Record<string, unknown>
	>({});
	const [takeScreenshots, setTakeScreenshots] = useState(false);

	const executeMutation = useMutation(
		orpc.automationTemplates.execute.mutationOptions({
			onSuccess: (data) => {
				toast.success("Template execution started", {
					description: `Task ID: ${data.taskId}`,
				});
				onOpenChange(false);
				setParameterValues({});
			},
			onError: (error) => {
				toast.error("Failed to execute template", {
					description: error.message,
				});
			},
		}),
	);

	if (!template) {
		return null;
	}

	const parameters = (template.parameters ?? []) as TemplateParameter[];

	const handleExecute = () => {
		// Build parameter values with defaults
		const values: Record<string, unknown> = {};
		for (const param of parameters) {
			const value = parameterValues[param.name] ?? param.defaultValue;
			if (value !== undefined) {
				values[param.name] = value;
			}
		}

		executeMutation.mutate({
			id: template.id,
			organizationId,
			parameterValues: values,
			takeScreenshots,
		});
	};

	const updateParameter = (name: string, value: unknown) => {
		setParameterValues((prev) => ({ ...prev, [name]: value }));
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-[500px]">
				<DialogHeader>
					<DialogTitle>Execute Template</DialogTitle>
					<DialogDescription>
						{template.name}
						{template.description && ` - ${template.description}`}
					</DialogDescription>
				</DialogHeader>

				<div className="space-y-4 py-4">
					{parameters.length === 0 ? (
						<p className="text-sm text-muted-foreground">
							This template has no configurable parameters.
						</p>
					) : (
						parameters.map((param) => (
							<div key={param.name} className="space-y-2">
								<Label htmlFor={param.name}>
									{param.name}
									{param.required && (
										<span className="text-destructive ml-1">
											*
										</span>
									)}
								</Label>
								{param.description && (
									<p className="text-xs text-muted-foreground">
										{param.description}
									</p>
								)}
								{param.type === "boolean" ? (
									<Switch
										id={param.name}
										checked={Boolean(
											parameterValues[param.name] ??
												param.defaultValue,
										)}
										onCheckedChange={(checked) =>
											updateParameter(param.name, checked)
										}
									/>
								) : (
									<Input
										id={param.name}
										type={
											param.type === "number"
												? "number"
												: "text"
										}
										placeholder={
											param.defaultValue?.toString() ??
											`Enter ${param.name}`
										}
										value={String(
											parameterValues[param.name] ?? "",
										)}
										onChange={(e) => {
											const val =
												param.type === "number"
													? Number(e.target.value)
													: e.target.value;
											updateParameter(param.name, val);
										}}
									/>
								)}
							</div>
						))
					)}

					<div className="flex items-center justify-between pt-4 border-t">
						<Label htmlFor="screenshots">
							Take screenshots during execution
						</Label>
						<Switch
							id="screenshots"
							checked={takeScreenshots}
							onCheckedChange={setTakeScreenshots}
						/>
					</div>
				</div>

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
					>
						Cancel
					</Button>
					<Button
						onClick={handleExecute}
						disabled={executeMutation.isPending}
					>
						{executeMutation.isPending ? (
							<Spinner className="h-4 w-4 mr-2" />
						) : (
							<PlayIcon className="h-4 w-4 mr-2" />
						)}
						Execute
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
