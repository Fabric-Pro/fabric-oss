"use client";

/**
 * New Project's first choice (specs/2026-10-23-repository-import §6a):
 * the page heading comes first, then the choice. "Start from scratch" shows
 * the creation form it wraps (the simplified form without its own heading,
 * or the wizard), and "Import from a repository" shows
 * `RepositoryImportForm` in its place. A return from the import's GitHub
 * sign-in (`?import=owner/name`) opens on the import with that repository.
 */

import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useId, useState } from "react";
import { RepositoryImportForm } from "./RepositoryImportForm";

type StartMode = "scratch" | "import";

const MODES: readonly StartMode[] = ["scratch", "import"];

export function NewProjectStart({
	organizationId,
	projectsBasePath,
	children,
}: {
	organizationId: string;
	projectsBasePath: string;
	/** The from-scratch creation form. */
	children: ReactNode;
}) {
	const t = useTranslations("projects.newProjectStart");
	const id = useId();
	const importSource = useSearchParams()?.get("import") ?? "";
	const [mode, setMode] = useState<StartMode>(
		importSource !== "" ? "import" : "scratch",
	);

	return (
		<div className="flex flex-col gap-8">
			<div className="mx-auto flex w-full max-w-2xl flex-col gap-2">
				<div className="mb-6">
					<h1
						className="font-normal text-3xl leading-tight"
						style={{ fontFamily: "var(--font-serif)" }}
					>
						{t("heading")}
					</h1>
					<p className="mt-2 text-muted-foreground text-sm">
						{t("subtitle")}
					</p>
				</div>
				<p id={`${id}-label`} className="font-medium text-sm">
					{t("choiceLabel")}
				</p>
				<RadioGroup
					aria-labelledby={`${id}-label`}
					value={mode}
					onValueChange={(next) => setMode(next as StartMode)}
					className="grid gap-3 sm:grid-cols-2"
				>
					{MODES.map((value) => (
						<Label
							key={value}
							htmlFor={`${id}-${value}`}
							className="flex cursor-pointer items-start gap-3 rounded-xl border border-input p-4 font-normal hover:border-foreground/30 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent/40"
						>
							<RadioGroupItem
								id={`${id}-${value}`}
								value={value}
								className="mt-0.5"
								aria-describedby={`${id}-${value}-hint`}
							/>
							<span className="flex flex-col gap-1">
								<span className="font-medium text-sm">
									{t(`${value}.title`)}
								</span>
								<span
									id={`${id}-${value}-hint`}
									className="text-muted-foreground text-xs"
								>
									{t(`${value}.description`)}
								</span>
							</span>
						</Label>
					))}
				</RadioGroup>
			</div>
			{mode === "scratch" ? (
				children
			) : (
				<RepositoryImportForm
					organizationId={organizationId}
					projectsBasePath={projectsBasePath}
					initialSource={importSource}
				/>
			)}
		</div>
	);
}
