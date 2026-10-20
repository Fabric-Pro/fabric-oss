"use client";

import { AGENT_TASK_CAPABILITY_KEYS } from "@repo/temporal/agent-task-capabilities";
import { getBuiltInCapability } from "@saas/agents/lib/builtin-capabilities";
import { Checkbox } from "@ui/components/checkbox";

/**
 * Held by the platform but of no use to a scheduled task, which has no agent
 * instance to keep a memory for.
 */
const NOT_FOR_SCHEDULED_TASKS: ReadonlySet<string> = new Set(["agent-memory"]);

interface CapabilityOption {
	key: string;
	name: string;
	description: string;
}

/**
 * The capabilities an Agent Task may hold that have a name to show: the keys
 * the worker accepts (`AGENT_TASK_CAPABILITY_KEYS`, which is also what the
 * workflow tools' schema offers a chat), labelled from the capability catalogue.
 */
export function capabilityOptions(): CapabilityOption[] {
	return AGENT_TASK_CAPABILITY_KEYS.flatMap((key) => {
		const capability = getBuiltInCapability(key);
		return capability && !NOT_FOR_SCHEDULED_TASKS.has(key)
			? [
					{
						key,
						name: capability.name,
						description: capability.description,
					},
				]
			: [];
	});
}

interface CapabilitySelectorProps {
	label: string;
	value?: string[];
	onChange: (value: string[]) => void;
}

/**
 * Which of Fabric's own data and tools an unattended agent may use. It has
 * none unless they are ticked here, so a task that reads the project's work
 * needs Project Context. A key set some other way, which this list has no row
 * for, is kept when the others are changed.
 */
export function CapabilitySelector({
	label,
	value = [],
	onChange,
}: CapabilitySelectorProps) {
	const options = capabilityOptions();

	const toggle = (key: string, checked: boolean) => {
		const others = value.filter((entry) => entry !== key);
		onChange(checked ? [...others, key] : others);
	};

	return (
		<fieldset className="space-y-2">
			<legend className="text-sm font-medium">{label}</legend>
			<div className="space-y-3">
				{options.map((option) => {
					const id = `capability-${option.key}`;
					return (
						<div
							key={option.key}
							className="flex items-start gap-2"
						>
							<Checkbox
								id={id}
								checked={value.includes(option.key)}
								onCheckedChange={(checked) =>
									toggle(option.key, checked === true)
								}
							/>
							<label
								htmlFor={id}
								className="flex-1 cursor-pointer"
							>
								<div className="text-sm font-medium">
									{option.name}
								</div>
								<div className="text-xs text-muted-foreground">
									{option.description}
								</div>
							</label>
						</div>
					);
				})}
			</div>
		</fieldset>
	);
}
