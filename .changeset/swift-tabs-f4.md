---
"fabric-app": patch
---

One prompts page with Prompts and Actions tabs, and scope tabs as the library's primary filter.

Fizzy #2068 review F4. The library and the browse-by-action catalog lived on separate pages, so finding "the prompt for this job" meant knowing your way around two places. The prompts page now splits into Prompts (the library, filtered by whose default is in force — scope tabs replace the old document-type tabs, since whose prompt runs matters more than what type it shapes) and Actions (the same browse-by-action grid the catalog page serves, which stays up for its deep-links). Arriving with an action or prompt deep-link opens the Actions tab directly. The document-type tabs' stage-defaults panel retired with them; stage defaults remain manageable from the stage panel and the catalog.
