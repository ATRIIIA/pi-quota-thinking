# Pi Coding Agent: Quota-aware Thinking

[日本語](README.md)

*This document is an English translation of the Japanese README.*

An unofficial Pi extension that automatically adjusts the thinking level based on the remaining time in the ChatGPT Plus / Codex **5-hour usage window**.

Works with Pi’s `openai-codex` provider. This is an unofficial extension and is not affiliated with or endorsed by OpenAI.

Developed with assistance from OpenAI Codex.

## Installation

1. In Pi, run `/login openai-codex` and sign in with your ChatGPT account.
2. Place `quota-thinking.ts` at `~/.pi/agent/extensions/quota-thinking.ts`. For a global installation, Pi running under the same OS user loads it regardless of the working directory.
3. Run `/reload` in a running Pi session, or restart Pi.
4. Run `/quota-thinking refresh` to retrieve quota data and verify that the controller is active.

For a project-specific installation, place the file at `.pi/extensions/quota-thinking.ts`. To avoid loading the extension twice, enable either the global or the project-specific copy, not both.

## Usage

- `/quota-thinking status`: Show the status based on the most recently retrieved quota data
- `/quota-thinking refresh`: Retrieve quota data and apply the controller
- `/quota-thinking off`: Temporarily disable automatic control (the current thinking level is preserved)
- `/quota-thinking on`: Re-enable automatic control

## Control policy

Target remaining (%) = seconds until reset ÷ 5 hours × 100.

The extension selects a thinking level based on the difference, in percentage points, between actual remaining quota and target remaining quota:

| Difference (actual - target) | Thinking |
| --- | --- |
| +20 or higher | `openai-codex/gpt-6.1-sol` / medium |
| +10 or higher, but below +20 | `openai-codex/gpt-6-luna` / xhigh |
| Greater than -10 and below +10 | `openai-codex/gpt-6-luna` / high |
| -10 or lower | `openai-codex/gpt-6-luna` / medium |

If the 5-hour quota has 3% or less remaining, thinking is set to minimal. For the weekly quota, thinking is capped at minimal if 3% or less remains, or if it is at least 30 percentage points behind its target pace. It is capped at low if 10% or less remains, or if it is at least 15 points behind pace. However, when the 5-hour quota is at least 20 points ahead of pace, switching to the specified model and using medium takes precedence over these caps. When the gap falls below +20, the extension automatically switches back to `openai-codex/gpt-6-luna` and resumes the normal thinking-level rules.

Pi rounds unsupported thinking levels to a supported level.

## Implementation and caveats

- Uses Pi's official `pi.setModel()` / `pi.setThinkingLevel()` APIs and the `before_agent_start` / `turn_end` hooks. Below a +20-point gap it selects `openai-codex/gpt-6-luna`; at +20 points or higher it selects `openai-codex/gpt-6.1-sol` (medium).
- Retrieves usage data from `https://chatgpt.com/backend-api/wham/usage` using the `openai-codex` OAuth access token stored by Pi. This endpoint is undocumented and not guaranteed; if it changes or becomes unavailable, the current thinking level is preserved.
- Does not modify credentials or refresh tokens. The only request destination is ChatGPT's usage endpoint; credentials are not sent to third-party sites.
- The extension can retry after Pi updates its access token. If authentication has expired, sign in again with Pi.
- Uses a minimum 60-second cache. The model and thinking level are adjusted before each prompt and after each model turn. **An in-progress model response cannot be changed.**
- If `pi-adaptive-thinking` is enabled at the same time, it may change the thinking level. To ensure this extension takes precedence, it is best not to run both.
- Adjusting the thinking level is not guaranteed to change quota consumption by a fixed amount. Consumption also depends on the model, input size, caching, and other factors. Requests may fail at the quota limit even at minimal.
- The Codex **weekly quota** and model-specific additional limits are separate. Weekly pacing is applied only when weekly usage data is available. This sample does not monitor model-specific additional limits.
- If the API does not provide a 5-hour window for the current plan or state, the extension stops without making changes.
- This extension does not work with API-key authentication instead of ChatGPT Plus authentication.
- Historical verification under the previous threshold (a gap of +50 points or more): usage data was retrieved through Pi RPC, and a temporary session confirmed the switch to `openai-codex/gpt-6.1-sol` / `medium` by reading back the selected settings. No model response was generated. Compatibility with this undocumented API is not guaranteed.

## Example targets

4 hours remaining → 80% target; 3 hours → 60%; 2 hours → 40%; 1 hour → 20%; 0 hours → 0%.
