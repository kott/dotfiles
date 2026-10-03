---
description: Gather code context and produce a plan without changing files
---
Use a subagent chain: scout locates code relevant to $@, then planner produces a concrete plan using {previous}. Use outputMode "file-only" and recover details from the saved artifacts. Do not implement or modify files.
