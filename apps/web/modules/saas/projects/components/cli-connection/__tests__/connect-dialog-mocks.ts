import { vi } from "vitest";

/**
 * The key-minting call, kept apart from the harness that renders the dialog:
 * the `@shared/lib/orpc-client` mock factory imports this file, and the harness
 * imports the dialog, which imports that client, so putting the two in one file
 * would have the factory waiting on a module that is waiting on the factory.
 */
export const createKeyMock = vi.fn();
