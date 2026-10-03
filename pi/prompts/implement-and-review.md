---
description: Implement, review, and address confirmed findings
---
Use a subagent chain: worker implements $@, reviewer examines the changes using {previous}, and worker addresses confirmed findings using {previous}. Pass exact changed paths and verification outcomes between steps. Use outputMode "file-only"; do not rerun agents merely to expand compact previews. Keep the task bounded and respect approval requirements.
