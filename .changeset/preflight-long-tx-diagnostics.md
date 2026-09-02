---
"fabric-app": patch
---

Make the migration preflight's long-transaction failure say what each session is doing

When the preflight refuses a promotion because transactions are open, the line
it prints named only pids, ages and states. On 2026-09-02 two dev promotions
failed on "24 transaction(s) open" and the sessions had ended before anyone
could ask the database what they were, so the cause could not be established.

Each offender now also reports what it waits on (`wait_event_type/wait_event`),
which sessions it is queued behind (`pg_blocking_pids`), how long it has sat in
its current state, its application name, and the tables it holds locks on. The
query text is still deliberately not read, since it can carry row values into a
CI log; the lock's table names say where a session is sitting without repeating
what it wrote there.
