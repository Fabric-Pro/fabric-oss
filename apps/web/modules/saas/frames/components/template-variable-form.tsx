"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Button } from "@ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@ui/components/card";
import {
	Form,
	FormControl,
	FormDescription,
	FormField,
	FormItem,
	FormLabel,
	FormMessage,
} from "@ui/components/form";
import { Input } from "@ui/components/input";
import { Skeleton } from "@ui/components/skeleton";
import { Textarea } from "@ui/components/textarea";
import { useMemo, useState } from "react";
import { type Resolver, useForm } from "react-hook-form";
import { z } from "zod";
import { useCreateFrameFromTemplate } from "../hooks/use-frame-templates";

interface TemplateVariableFormProps {
	template: {
		id: string;
		name: string;
		description: string | null;
		variables: Record<string, any> | null;
	};
	onCancel: () => void;
	onSuccess: (frameId: string) => void;
}

export function TemplateVariableForm({
	template,
	onCancel,
	onSuccess,
}: TemplateVariableFormProps) {
	const { createFromTemplate, isPending } = useCreateFrameFromTemplate();
	const [isSubmitting, setIsSubmitting] = useState(false);

	// Build schema and default values from template variables
	const { schema, defaultValues } = useMemo(() => {
		const schemaFields: Record<string, z.ZodTypeAny> = {};
		const defaults: Record<string, string> = {};

		if (template.variables) {
			for (const [key, config] of Object.entries(template.variables)) {
				const fieldConfig = config as {
					type: string;
					label?: string;
					required?: boolean;
					default?: string;
					placeholder?: string;
				};

				if (fieldConfig.required) {
					schemaFields[key] = z
						.string()
						.min(1, `${fieldConfig.label || key} is required`);
				} else {
					schemaFields[key] = z.string().optional().default("");
				}

				defaults[key] = fieldConfig.default || "";
			}
		}

		// Add title and description fields
		schemaFields.title = z.string().min(1, "Title is required");
		schemaFields.description = z.string().optional().default("");

		defaults.title = template.name;
		defaults.description = template.description || "";

		return {
			schema: z.object(schemaFields),
			defaultValues: defaults,
		};
	}, [template]);

	const form = useForm<Record<string, string>>({
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		resolver: zodResolver(schema as any) as Resolver<
			Record<string, string>
		>,
		defaultValues,
	});

	const onSubmit = async (values: Record<string, string>) => {
		setIsSubmitting(true);
		try {
			const { title, description, ...variables } = values;
			const result = await createFromTemplate({
				templateId: template.id,
				variables,
				title,
				description,
			});

			if (result.success && result.frame) {
				onSuccess(result.frame.id);
			}
		} finally {
			setIsSubmitting(false);
		}
	};

	const variableFields = Object.entries(template.variables || {});

	return (
		<div className="space-y-6">
			<div>
				<h2 className="text-lg font-semibold">{template.name}</h2>
				{template.description && (
					<p className="text-sm text-muted-foreground mt-1">
						{template.description}
					</p>
				)}
			</div>

			<Form {...form}>
				<form
					onSubmit={form.handleSubmit(onSubmit)}
					className="space-y-6"
				>
					<Card>
						<CardHeader>
							<CardTitle className="text-base">
								Frame Details
							</CardTitle>
							<CardDescription>
								Customize the title and description for your new
								frame
							</CardDescription>
						</CardHeader>
						<CardContent className="space-y-4">
							<FormField
								control={form.control}
								name="title"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Title</FormLabel>
										<FormControl>
											<Input
												{...field}
												placeholder="Enter frame title"
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
							<FormField
								control={form.control}
								name="description"
								render={({ field }) => (
									<FormItem>
										<FormLabel>Description</FormLabel>
										<FormControl>
											<Textarea
												{...field}
												placeholder="Enter frame description"
												rows={2}
											/>
										</FormControl>
										<FormMessage />
									</FormItem>
								)}
							/>
						</CardContent>
					</Card>

					{variableFields.length > 0 && (
						<Card>
							<CardHeader>
								<CardTitle className="text-base">
									Template Variables
								</CardTitle>
								<CardDescription>
									Fill in the variables to customize your
									frame
								</CardDescription>
							</CardHeader>
							<CardContent className="space-y-4">
								{variableFields.map(([key, config]) => {
									const fieldConfig = config as {
										type: string;
										label?: string;
										required?: boolean;
										placeholder?: string;
										description?: string;
									};

									return (
										<FormField
											key={key}
											control={form.control}
											name={key}
											render={({ field }) => (
												<FormItem>
													<FormLabel>
														{fieldConfig.label ||
															key}
														{fieldConfig.required && (
															<span className="text-destructive ml-1">
																*
															</span>
														)}
													</FormLabel>
													<FormControl>
														{fieldConfig.type ===
														"textarea" ? (
															<Textarea
																{...field}
																placeholder={
																	fieldConfig.placeholder ||
																	`Enter ${key}`
																}
																rows={3}
															/>
														) : (
															<Input
																{...field}
																placeholder={
																	fieldConfig.placeholder ||
																	`Enter ${key}`
																}
															/>
														)}
													</FormControl>
													{fieldConfig.description && (
														<FormDescription>
															{
																fieldConfig.description
															}
														</FormDescription>
													)}
													<FormMessage />
												</FormItem>
											)}
										/>
									);
								})}
							</CardContent>
						</Card>
					)}

					<div className="flex justify-end gap-3">
						<Button
							type="button"
							variant="outline"
							onClick={onCancel}
							disabled={isSubmitting || isPending}
						>
							Cancel
						</Button>
						<Button
							type="submit"
							disabled={isSubmitting || isPending}
						>
							{isSubmitting || isPending ? (
								<>
									<Skeleton className="h-4 w-4 mr-2 rounded-full animate-spin" />
									Creating...
								</>
							) : (
								"Create Frame"
							)}
						</Button>
					</div>
				</form>
			</Form>
		</div>
	);
}
