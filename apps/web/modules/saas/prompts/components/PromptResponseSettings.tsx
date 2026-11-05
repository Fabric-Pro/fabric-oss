"use client";
import type { PromptResponseContract } from "@repo/ai/lib/prompt-response-contract";
import { promptResponseContract } from "@repo/ai/lib/prompt-response-contract";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { Textarea } from "@ui/components/textarea";
import { TrashIcon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useId, useRef, useState } from "react";

const exampleSchema = {
	type: "object",
	properties: { summary: { type: "string" } },
	required: ["summary"],
	additionalProperties: false,
};
const fieldTypes = ["string", "number", "integer", "boolean"];
export function PromptResponseSettings({
	value,
	onChange,
	onError,
}: {
	value: PromptResponseContract;
	onChange: (value: PromptResponseContract) => void;
	onError: (message: string | undefined) => void;
}) {
	const id = useId();
	const t = useTranslations("prompts.response");
	const jsonSchema = useRef(value.schema ?? exampleSchema);
	const [raw, setRaw] = useState(
		JSON.stringify(value.schema ?? exampleSchema, null, 2),
	);
	const [problem, setProblem] = useState<string>();
	const schema = value.schema ?? exampleSchema;
	const properties = (
		schema.properties &&
		typeof schema.properties === "object" &&
		!Array.isArray(schema.properties)
			? schema.properties
			: {}
	) as Record<
		string,
		Record<string, NonNullable<PromptResponseContract["schema"]>[string]>
	>;
	const required = Array.isArray(schema.required)
		? (schema.required as string[])
		: [];
	const simple =
		schema.type === "object" &&
		Object.values(properties).every(
			(field) =>
				field &&
				typeof field === "object" &&
				fieldTypes.includes(String(field.type)) &&
				Object.keys(field).every((key) =>
					["type", "title", "description"].includes(key),
				),
		);
	const change = (next: PromptResponseContract) => {
		if (value.schema) {
			jsonSchema.current = value.schema;
		}
		if (next.schema) {
			jsonSchema.current = next.schema;
		}
		setRaw(JSON.stringify(next.schema ?? exampleSchema, null, 2));
		setProblem(undefined);
		onError(undefined);
		onChange(next);
	};
	const updateFields = (
		name: string,
		nextName: string,
		type: string,
		mandatory: boolean,
		remove = false,
	) => {
		if (
			!remove &&
			(!nextName.trim() ||
				(nextName !== name && Object.hasOwn(properties, nextName)))
		) {
			setProblem(t("unique"));
			onError(undefined);
			return false;
		}
		const entries = Object.entries(properties).flatMap(([key, field]) =>
			key === name
				? remove
					? []
					: [[nextName, { ...field, type }] as const]
				: [[key, field] as const],
		);
		if (!remove && !Object.hasOwn(properties, name)) {
			entries.push([nextName, { type }]);
		}
		change({
			format: "JSON",
			schema: {
				...schema,
				properties: Object.fromEntries(entries),
				required: [
					...required.filter((key) => key !== name),
					...(!remove && mandatory ? [nextName] : []),
				],
			},
		});
		return true;
	};
	return (
		<section aria-label={t("settings")} className="space-y-3">
			<div className="space-y-1.5">
				<Label htmlFor={`${id}-format`}>{t("label")} </Label>
				<Select
					value={value.format}
					onValueChange={(format: PromptResponseContract["format"]) =>
						change(
							format === "JSON"
								? { format, schema: jsonSchema.current }
								: { format },
						)
					}
				>
					<SelectTrigger id={`${id}-format`}>
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="AUTO">{t("automatic")} </SelectItem>
						<SelectItem value="TEXT">{t("text")} </SelectItem>
						<SelectItem value="MARKDOWN">
							{t("markdown")}{" "}
						</SelectItem>
						<SelectItem value="JSON">{t("json")} </SelectItem>
						<SelectItem value="XML">{t("xml")} </SelectItem>
					</SelectContent>
				</Select>
				<p className="text-xs text-muted-foreground">{t("help")}</p>
			</div>
			{value.format === "JSON" && (
				<>
					{simple && (
						<div className="space-y-2">
							<p className="text-sm font-medium">
								{t("fields")}{" "}
							</p>
							{Object.entries(properties).map(
								([name, field], index) => (
									<div
										key={`${index}-${name}`}
										className="flex flex-wrap items-center gap-2"
									>
										<Input
											aria-label={t("name", {
												number: index + 1,
											})}
											className="min-w-24 flex-1"
											defaultValue={name}
											onBlur={(event) => {
												if (
													event.target.value !== name
												) {
													const accepted =
														updateFields(
															name,
															event.target.value,
															String(field.type),
															required.includes(
																name,
															),
														);
													if (accepted === false) {
														event.target.value =
															name;
													}
												}
											}}
										/>
										<Select
											value={String(field.type)}
											onValueChange={(type) =>
												updateFields(
													name,
													name,
													type,
													required.includes(name),
												)
											}
										>
											<SelectTrigger
												aria-label={t("type", { name })}
												className="w-28"
											>
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												{fieldTypes.map((type) => (
													<SelectItem
														key={type}
														value={type}
													>
														{{
															string: t(
																"stringType",
															),
															number: t(
																"numberType",
															),
															integer:
																t(
																	"integerType",
																),
															boolean:
																t(
																	"booleanType",
																),
														}[type as "string"] ??
															type}
													</SelectItem>
												))}
											</SelectContent>
										</Select>
										<label
											htmlFor={`${id}-required-${index}`}
											className="flex items-center gap-1 text-xs"
										>
											<Checkbox
												id={`${id}-required-${index}`}
												aria-label={t("require", {
													name,
												})}
												checked={required.includes(
													name,
												)}
												onCheckedChange={(checked) =>
													updateFields(
														name,
														name,
														String(field.type),
														checked === true,
													)
												}
											/>
											{t("required")}{" "}
										</label>
										<Button
											type="button"
											size="icon"
											variant="ghost"
											aria-label={`Remove field ${name}`}
											onClick={() =>
												updateFields(
													name,
													name,
													String(field.type),
													false,
													true,
												)
											}
										>
											<TrashIcon className="size-4" />
										</Button>
									</div>
								),
							)}
							<Button
								type="button"
								variant="outline"
								size="sm"
								disabled={Object.keys(properties).length >= 50}
								onClick={() => {
									let name = "field1";
									let n = 1;
									while (Object.hasOwn(properties, name)) {
										name = `field${++n}`;
									}
									updateFields(name, name, "string", true);
								}}
							>
								{t("add")}{" "}
							</Button>
						</div>
					)}
					<details open={!simple || undefined}>
						<summary className="cursor-pointer text-sm">
							{t("advanced")}{" "}
						</summary>
						<Label className="sr-only" htmlFor={`${id}-schema`}>
							{t("schema")}{" "}
						</Label>
						<Textarea
							id={`${id}-schema`}
							value={raw}
							className="mt-2 min-h-48 font-mono text-xs"
							onChange={(event) => {
								const text = event.target.value;
								setRaw(text);
								try {
									const next = promptResponseContract.parse({
										format: "JSON",
										schema: JSON.parse(text),
									});
									setProblem(undefined);
									onError(undefined);
									onChange(next);
								} catch {
									const message = t("invalid");
									setProblem(message);
									onError(message);
								}
							}}
						/>
						<p className="mt-2 text-xs text-muted-foreground">
							{t("supported")}
						</p>
					</details>
				</>
			)}
			{value.format === "XML" && (
				<p className="text-xs text-muted-foreground">{t("xmlHelp")}</p>
			)}
			{problem && (
				<p role="alert" className="text-sm text-destructive">
					{problem}
				</p>
			)}
		</section>
	);
}
