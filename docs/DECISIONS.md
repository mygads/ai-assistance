# Accepted starting decisions

| ID | Decision | Reason / reopen condition |
|---|---|---|
| ADR-001 | Tauri/Rust + React/TypeScript | One desktop foundation; reconsider only after measured native integration blocker |
| ADR-002 | On-demand Send by default | Continuous STT, bounded model calls; auto assist is an explicit later option |
| ADR-003 | Separate self/remote streams | Source-based attribution; diarization is optional for multiple remote people |
| ADR-004 | Local lexical sequence alignment | User follows ~90% of naskah; no LLM per scroll |
| ADR-005 | Coordinator + up to 3 isolated workers | Parallel independent modules, serial contracts/integration; serial fallback |
| ADR-006 | SQLite/FTS baseline | Local retrieval; optional multilingual embeddings when cross-language tests need them |
| ADR-007 | Structured/provenance memory | Learning from corrections/feedback; no implicit weight training or fact promotion |
| ADR-008 | Separate evidence levels | Replay and browser testing cannot replace native/audio/live proof |
| ADR-009 | No mandatory full Hermes/OpenClaw runtime | Adapt relevant memory/skill patterns; full runtime only if concrete need appears |
| ADR-010 | Test-build-only automation hooks | Native E2E without shipping privileged fixture controls |
| ADR-011 | No publishing required | Deliver source, tests, and locally produced build artifacts |
| ADR-012 | Runtime and development orchestration separate | Product stays lightweight even when development uses several coding workers |

Changes are allowed when evidence justifies them. Record date, trigger, alternatives, measured impact, tests, migration, and affected tasks. Routine choices belong to the coordinator; do not ask user to approve every dependency or naming detail.

Temporary working name: Conversation Assistant. Package/app identifiers are chosen in P00; do not treat this as final brand.

