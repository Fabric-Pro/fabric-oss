/**
 * Unit tests for Checkpoint component (AI Elements)
 *
 * Tests the Checkpoint component with:
 * - Checkpoint creation
 * - Checkpoint restoration
 * - Checkpoint deletion
 * - Checkpoint history popover
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	Checkpoint,
	CheckpointCreateButton,
	type CheckpointData,
	CheckpointHistory,
	CheckpointProvider,
	CheckpointRestoreButton,
	createCheckpoint,
} from "../../components/ai-elements/checkpoint";

describe("Checkpoint Component", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("createCheckpoint helper", () => {
		it("should create a checkpoint with correct properties", () => {
			const checkpoint = createCheckpoint(5, 6, "My checkpoint");

			expect(checkpoint.id).toMatch(/^checkpoint-\d+-[a-z0-9]+$/);
			expect(checkpoint.messageIndex).toBe(5);
			expect(checkpoint.messageCount).toBe(6);
			expect(checkpoint.label).toBe("My checkpoint");
			expect(checkpoint.timestamp).toBeInstanceOf(Date);
		});

		it("should create unique IDs for each checkpoint", () => {
			const cp1 = createCheckpoint(1, 2);
			const cp2 = createCheckpoint(1, 2);

			expect(cp1.id).not.toBe(cp2.id);
		});

		it("should store metadata when provided", () => {
			const metadata = { tokenUsage: { inputTokens: 100 } };
			const checkpoint = createCheckpoint(1, 2, "test", metadata);

			expect(checkpoint.metadata).toEqual(metadata);
		});
	});

	describe("Checkpoint divider", () => {
		it("should render checkpoint divider with label", () => {
			const checkpoint: CheckpointData = {
				id: "cp-1",
				messageIndex: 3,
				messageCount: 4,
				timestamp: new Date(),
				label: "Before changes",
			};

			render(<Checkpoint checkpoint={checkpoint} />);

			expect(screen.getByText("Before changes")).toBeInTheDocument();
		});

		it("should show default label when no label provided", () => {
			const checkpoint: CheckpointData = {
				id: "cp-1",
				messageIndex: 3,
				messageCount: 4,
				timestamp: new Date(),
			};

			render(<Checkpoint checkpoint={checkpoint} />);

			expect(screen.getByText("Checkpoint 4")).toBeInTheDocument();
		});
	});

	describe("CheckpointCreateButton", () => {
		it("should call onCreateCheckpoint when clicked", async () => {
			const mockCreate = vi.fn();
			const user = userEvent.setup();

			render(
				<CheckpointProvider
					checkpoints={[]}
					onCreateCheckpoint={mockCreate}
				>
					<CheckpointCreateButton />
				</CheckpointProvider>,
			);

			const button = screen.getByRole("button");
			await user.click(button);

			expect(mockCreate).toHaveBeenCalled();
		});

		it("should use prop callback over context", async () => {
			const contextCreate = vi.fn();
			const propCreate = vi.fn();
			const user = userEvent.setup();

			render(
				<CheckpointProvider
					checkpoints={[]}
					onCreateCheckpoint={contextCreate}
				>
					<CheckpointCreateButton onCreateCheckpoint={propCreate} />
				</CheckpointProvider>,
			);

			await user.click(screen.getByRole("button"));

			expect(propCreate).toHaveBeenCalled();
			expect(contextCreate).not.toHaveBeenCalled();
		});
	});

	describe("CheckpointRestoreButton", () => {
		it("should call onRestore with checkpoint when clicked", async () => {
			const mockRestore = vi.fn();
			const user = userEvent.setup();
			const checkpoint: CheckpointData = {
				id: "cp-1",
				messageIndex: 2,
				messageCount: 3,
				timestamp: new Date(),
			};

			render(
				<CheckpointRestoreButton
					checkpoint={checkpoint}
					onRestore={mockRestore}
				/>,
			);

			await user.click(screen.getByRole("button"));

			expect(mockRestore).toHaveBeenCalledWith(checkpoint);
		});
	});

	describe("CheckpointHistory", () => {
		const mockCheckpoints: CheckpointData[] = [
			{
				id: "cp-1",
				messageIndex: 2,
				messageCount: 3,
				timestamp: new Date(Date.now() - 60000), // 1 min ago
				label: "First checkpoint",
			},
			{
				id: "cp-2",
				messageIndex: 5,
				messageCount: 6,
				timestamp: new Date(Date.now() - 3600000), // 1 hour ago
			},
		];

		it("should not render when no checkpoints", () => {
			const { container } = render(
				<CheckpointHistory checkpoints={[]} />,
			);

			expect(container.firstChild).toBeNull();
		});

		it("should render checkpoint count badge", () => {
			render(
				<CheckpointProvider checkpoints={mockCheckpoints}>
					<CheckpointHistory />
				</CheckpointProvider>,
			);

			expect(screen.getByText("2")).toBeInTheDocument();
		});
	});
});
