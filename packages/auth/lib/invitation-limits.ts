/** Largest list one bulk organization invitation accepts (Fizzy #1986). */
export const MAX_BULK_INVITATIONS = 500;

/**
 * Better Auth refuses a new invitation once an organization holds this many
 * pending ones, and its default is 100, so a full batch would start failing a
 * fifth of the way through. Two batches' room lets a second one land before the
 * first has been accepted.
 */
export const MAX_PENDING_INVITATIONS = MAX_BULK_INVITATIONS * 2;
