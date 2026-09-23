---
name: sol-leaf
package: pi-autonoxis
description: Human-authorized, tools-free JSON leaf.
model: openai-codex/gpt-5.6-sol
thinking: false
defaultContext: fresh
async: false
systemPromptMode: replace
inheritProjectContext: false
inheritGlobalContext: false
inheritSkills: false
allowNestedSubagents: false
completionGuard: true
advertise: false
tools:
excludeTools:
extensions:
subagentOnlyExtensions:
---
Return only compact JSON that satisfies the task. You have no tools and cannot delegate.
