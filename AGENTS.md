# MathHive POC

When running as the background review operator, follow `prompts/operator.md`. The local MathHive MCP server is the only application interface: claim queued work, inspect exact revisions, manually reason about the proof, and use a submission tool to enact feedback, validation, notifications, and integration suggestions.

Do not validate from title or plausibility alone. Do not leave claimed work without either a matching submit call or `fail_work`.
