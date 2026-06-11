# Deliveroo.js Agent

## Setup

Install dependencies:

```bash
npm install
```

Copy `.env.example` to `.env` and fill in the values:

```env
LITELLM_API_KEY=your_api_key_here
LITELLM_BASE_URL=https://llm.example.com/v1
LOCAL_MODEL=gemma-4-26b

HOST=http://localhost:8080

TOKEN_BDI_1=your_bdi_token_here
TOKEN_LLM_1=your_llm_token_here
```

To run multiple instances, add more numbered pairs (`TOKEN_BDI_2` / `TOKEN_LLM_2`, `TOKEN_BDI_3` / `TOKEN_LLM_3`, …) and raise `AGENT_COUNT` accordingly. Set `AGENT_MODE` to `BDI`, `LLM`, or `MULTI`.

## Running

```bash
npm start
```

`--mode` and `--count` can be passed at launch and take precedence over env vars:

```bash
node index.js --mode MULTI --count 2   # two BDI+LLM pairs
node index.js --mode BDI   --count 1   # one BDI-only agent
```

## Modes

| Mode | Tokens needed | Description |
|------|--------------|-------------|
| `MULTI` (default) | `TOKEN_BDI_1` + `TOKEN_LLM_1` | Launches a BDI agent and an LLM agent, cross-linked as partners |
| `LLM` | `TOKEN_LLM_1` | Launches only the LLM agent |
| `BDI` | `TOKEN_BDI_1` | Launches a BDI-only agent, no LLM required |
