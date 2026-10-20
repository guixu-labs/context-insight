---
name: component-check
description: Read a packaged checklist and explain what counts as a successful component check.
---

# Component check

Read `references/checklist.md` relative to this skill's resource directory.
Explain the checklist in Chinese. Include the reference's check code so the user can verify it was read.
This skill does not provide a health tool or start a service.
Only if the user separately asks for a live service check and `component_health` is available, call that tool and report its actual result.
Never infer a live check from reading this document.
