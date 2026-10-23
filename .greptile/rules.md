## Cross-repo changes with uprevit-ui

Features often ship as a pair of PRs, one here and one in `SAT-Software/uprevit-ui`. The UI copy you read as cross-repo context can lag behind the companion UI PR.

- Check the PR description for a companion PR (for example `Used by SAT-Software/uprevit-ui#274`). If there is one, treat the UI changes it describes as part of this change.
- Don't report a new or changed endpoint, parameter or response field as unused just because the UI copy doesn't call it yet, when a companion UI PR exists.
- Always flag breaking changes to existing request or response shapes that the UI copy still relies on, unless the companion UI PR updates that usage.
