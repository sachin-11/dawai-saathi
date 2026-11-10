"""Medicine Q&A agent (AgentCore practice feature, demo only).

The agent only CHOOSES which read-only tool to call. Every sentence about a medicine, an interaction or a
lab test comes from a template filled by deterministic code (the same code the WhatsApp pipeline uses), so
CLAUDE.md §2.5 (grounding) holds. The emergency rules run BEFORE the agent. See `runner.py`.
"""
