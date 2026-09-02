"use client";

import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import { PercentField } from "./PercentField";

/**
 * Sign-off — what blocks a feature from moving to Done: the people gate and
 * the test-coverage gate. Both follow the same convention: 0 / off disables.
 */
export function SignOffSectionBody({
	requiredQaSignOffs,
	testCoverageTarget,
	canEdit,
	onSignOffs,
	onGate,
}: {
	requiredQaSignOffs: number;
	/** % of acceptance criteria needing a linked case. 0 = gate off. */
	testCoverageTarget: number;
	canEdit: boolean;
	onSignOffs: (value: number) => void;
	onGate: (value: number) => void;
}) {
	return (
		<>
			<div className="max-w-xs">
				<Label htmlFor="required-qa-sign-offs">
					Required sign-offs
				</Label>
				<p className="text-muted-foreground text-xs">
					Zero disables the gate. A feature that has not collected
					enough sign-offs is refused the move to Done, and the
					refusal names how many it has.
				</p>
				<Input
					id="required-qa-sign-offs"
					type="number"
					inputMode="numeric"
					min={0}
					max={10}
					step={1}
					className="mt-2"
					value={requiredQaSignOffs}
					disabled={!canEdit}
					onChange={(e) => {
						// Clamped here as well as server-side: the input lets a
						// reader type 40, and a value the API will reject should
						// not sit in the form looking saved.
						const next = Number.parseInt(e.target.value, 10);
						onSignOffs(
							Number.isNaN(next)
								? 0
								: Math.max(0, Math.min(10, next)),
						);
					}}
				/>
			</div>

			<div className="mt-4 flex items-center justify-between gap-3 border-t pt-4">
				<div className="min-w-0">
					<Label htmlFor="test-coverage-gate">
						Test Coverage Target
					</Label>
					<p className="text-muted-foreground text-xs">
						Blocks the move to Done until enough of each feature's
						acceptance criteria have a linked case.
					</p>
				</div>
				<Switch
					id="test-coverage-gate"
					checked={testCoverageTarget > 0}
					disabled={!canEdit}
					onCheckedChange={(v) =>
						// On pre-fills 30 — a starting point, not a recommendation
						// baked into storage; off is 0, the same "no gate" answer
						// as sign-offs.
						onGate(v ? 30 : 0)
					}
				/>
			</div>

			{testCoverageTarget > 0 && (
				<div className="mt-3 max-w-xs">
					{/*
					 * min={5}, not 0: the field unmounts when the value hits 0,
					 * and a control that vanishes under a mid-drag cursor or a
					 * keyboard user's focus is the failure the switch exists to
					 * own. Off lives on the switch alone.
					 */}
					<PercentField
						id="test-coverage-target"
						label="Test Coverage Target"
						hint="The share of this feature's acceptance criteria that must have at least one test case linked before it can be marked Done."
						value={testCoverageTarget}
						disabled={!canEdit}
						min={5}
						onChange={onGate}
					/>
					{/* The percentage alone is hard to act on, so translate it into
					    counts. Settings has no single feature to count, so this is
					    an explicitly-labelled example rather than a live project
					    figure — the real counts appear in the gate's own refusal on
					    the feature. */}
					<p className="mt-2 text-muted-foreground text-xs">
						Example: a feature with 10 acceptance criteria would
						need about {Math.round((testCoverageTarget / 100) * 10)}{" "}
						of them covered.
					</p>
				</div>
			)}
		</>
	);
}
