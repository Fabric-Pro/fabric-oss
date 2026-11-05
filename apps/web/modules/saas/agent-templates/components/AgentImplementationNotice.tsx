"use client";

import { getAgentImplementationAvailability } from "@repo/agent-types/agent-implementation";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { useRouter } from "next/navigation";
import {
	AgentDefinitionExportDialog,
	AgentDefinitionImportDialog,
} from "./AgentDefinitionDialog";

/** Explain an unqualified implementation without offering a native-runtime fallback. */
export function AgentImplementationNotice({
	customInstructions,
	organizationId,
	instanceId,
	basePath,
}: {
	customInstructions: unknown;
	organizationId?: string | null;
	instanceId: string;
	basePath: string;
}) {
	const router = useRouter();
	const availability = getAgentImplementationAvailability(customInstructions);
	if (availability.available) {
		return null;
	}
	return (
		<Alert>
			<AlertTitle>
				Implementation draft · execution unavailable
			</AlertTitle>
			<AlertDescription className="space-y-3">
				<p>{availability.reason}</p>
				<p>
					Code-owned instructions, skills and execution settings are
					read-only. Export the definition to inspect its release
					requirements. Rebuild the implementation and import a new
					reviewed release to change them.
				</p>
				{organizationId && (
					<div className="flex flex-wrap gap-2">
						<AgentDefinitionExportDialog
							organizationId={organizationId}
							instanceId={instanceId}
						/>
						<AgentDefinitionImportDialog
							organizationId={organizationId}
							onImported={(id) =>
								router.push(`${basePath}/agents/${id}`)
							}
						/>
					</div>
				)}
			</AlertDescription>
		</Alert>
	);
}

export function ReadOnlyAgentImplementation({
	name,
	templateInstructions,
	customInstructions,
	organizationId,
	instanceId,
	basePath,
}: {
	name: string;
	templateInstructions?: string;
	customInstructions?: Record<string, unknown> | null;
	organizationId?: string | null;
	instanceId: string;
	basePath: string;
}) {
	const instructionSections = [
		{ label: "Template instructions", value: templateInstructions },
		{ label: "Role", value: customInstructions?.role },
		{
			label: "Additional context",
			value: customInstructions?.additionalContext,
		},
		{ label: "Constraints", value: customInstructions?.constraints },
	];
	return (
		<div className="space-y-6">
			<h1 className="text-xl font-semibold">{name}</h1>
			<AgentImplementationNotice
				customInstructions={customInstructions}
				organizationId={organizationId}
				instanceId={instanceId}
				basePath={basePath}
			/>
			<section
				aria-label="Read-only implementation instructions"
				className="space-y-4"
			>
				<h2 className="text-base font-semibold">Instructions</h2>
				{instructionSections
					.filter(
						(section) =>
							typeof section.value === "string" && section.value,
					)
					.map((section) => (
						<div key={section.label} className="space-y-2">
							<h3 className="text-sm font-medium">
								{section.label}
							</h3>
							<p className="whitespace-pre-wrap break-words text-sm text-muted-foreground">
								{String(section.value)}
							</p>
						</div>
					))}
			</section>
		</div>
	);
}
