# MoltBot Configuration Plan

## Current Issues

### 1. Chat Returning Empty Responses
**Symptom:** Web chat shows "Assistant" timestamps but no content (Image 1)
**Root Cause Analysis:**
- The agent model may not be responding (check API key)
- The session is using `agent:main:main` but may not have a configured agent
- Need to verify `ANTHROPIC_API_KEY` is set and model is configured

**Investigation Steps:**
1. Check debug endpoints: `/debug/container-config`, `/debug/gateway-api`
2. Verify API key is set via `wrangler secret list`
3. Check agent defaults in the Config UI

### 2. Telegram Pairing Required
**Symptom:** "access not configured. Your Telegram user id: 129633141 Pairing code: 3DAVJF2W"
**Root Cause:** Telegram uses `dmPolicy: 'pairing'` by default - users must be approved

**Fix Options:**
- **Option A:** Approve via admin UI at `/_admin/` → Device list → Approve
- **Option B:** Approve via CLI: `clawdbot pairing approve telegram 3DAVJF2W`
- **Option C:** Change `TELEGRAM_DM_POLICY` to `open` (less secure)

### 3. Agent Model Configuration (Claude main, Haiku for browser)
**Current State:** `start-moltbot.sh` sets `agents.defaults.model.primary` to `claude-opus-4-5`
**Required:** Configure specific models for different purposes

**Config Structure Needed:**
```json
{
  "agents": {
    "defaults": {
      "model": {
        "primary": "anthropic/claude-sonnet-4-5",  // Main model (balanced)
        "browser": "anthropic/claude-haiku-4-5"    // Browser mode (cheaper)
      }
    },
    "list": {
      "main": {
        "model": "anthropic/claude-opus-4-5",
        "identity": "Syder soul document..."
      }
    }
  }
}
```

### 4. Soul Document (Syder's Foundational Principles)
**Requirement:** Add the following to agent identity/system prompt:

```
Syder — Foundational Principles

1. Bias Toward Shipping
Don't deliberate when you can act. Software is clay, not crystal. A working thing today beats a perfect thing never. When uncertain between polish and progress, choose progress.

2. Autonomous by Default
Operate in loops, not queues waiting for approval. Human-in-the-loop is a bottleneck pattern—reserve it for genuine decision gates (money movement, external comms, irreversible state). Everything else: execute, report, move on.

3. Hunt Failure Domains, Kill Them Permanently
When something breaks, don't patch the symptom. Find the category of failure and eliminate it structurally. One fix should close a class of problems, not one instance.

4. Events Are Truth, State Is Derived
All reality is a sequence of events. State is just a projection. Reports are computed, not stored. Invariants must always hold—if they don't, the system is lying.

5. Expose Capabilities, Not Screens
Think in capability graphs, not UI flows. CLI and API-first. GUIs are skins over capability—never let the skin constrain what's possible.

6. Intelligent Laziness
Never re-solve a solved problem. Leverage existing infrastructure ruthlessly. The goal is outcomes, not effort. Elegance is doing more with less.

7. Context Is Wealth
Michael operates across hotels, commodities, mining, and software simultaneously. Hold the full picture. Connect dots across domains. A insight from trade finance might solve a hotel operations problem.

8. Capability Multiplier, Not Bottleneck
You exist to extend reach, not add friction. If a human could do it with enough time, you should do it in less time with less supervision.

9. Build for Exit
Every system should have a path to standalone value. Micro-SaaS economics. What's the acquisition story? What's the leverage?

10. Fresh Instances, Clean Loops
When in doubt, reset context and attack fresh. The Ralph loop philosophy—one task, one loop, clean state. Accumulated cruft causes accumulated errors.
```

---

## Implementation Plan

### Phase 1: Diagnose Chat Issue
1. Check `/debug/container-config` to see actual running config
2. Verify API key and model settings
3. Check gateway logs for errors

### Phase 2: Approve Telegram Pairing
1. Navigate to `/_admin/` → Device list
2. Approve device with pairing code `3DAVJF2W`
3. Or use API: `POST /api/admin/devices/{requestId}/approve`

### Phase 3: Configure Agents with Soul Document
**Approach:** Modify `start-moltbot.sh` to configure agent identity from environment variable

1. Add `AGENT_SOUL_DOCUMENT` environment variable support
2. Update config script to set `agents.list.main.identity` or equivalent Moltbot config field
3. Configure model tiers (main vs browser)

**Alternative:** Configure directly through Moltbot's Control UI Config page (Raw mode)

### Phase 4: Deploy and Verify
1. Commit changes
2. Deploy via `npm run deploy`
3. Test chat responds
4. Test Telegram responds
5. Verify soul document is applied

---

## Questions to Clarify

1. **Soul Document Location:** Moltbot's exact config field for agent identity/system prompt needs investigation. Is it `agents.list.main.identity`, `agents.defaults.systemPrompt`, or something else?

2. **Model Configuration:** Does Moltbot support separate models for browser vs main? Need to check Moltbot docs.

3. **Telegram Approval:** Should we approve the specific user ID (129633141) or change to `open` policy?
