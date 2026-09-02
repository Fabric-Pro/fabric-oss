---
"fabric-app": patch
---

The prompt library shows Default/Available badges again, tags match in Settings, and dead stage-default code is gone.

Post-ship review of the prompts IA work found three leftovers: removing the document-type tabs had also removed the query flag that fed the library's "Default · tier" badges, so nothing indicated which prompt was in force there; the Settings → Prompts table still rendered tags as grey badges instead of the shared green pill; and two stage-default components plus a dangling filter prop survived as dead code from the retired panels. Binding status now resolves across every action when no type filter narrows it, the fifth tag site uses the shared component, and the dead files are deleted.
