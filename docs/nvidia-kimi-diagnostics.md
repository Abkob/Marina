# Kimi K3: invocation diagnosis and recovery

Investigated on **2026-10-02**, using synthetic prompts and the configured NVIDIA
credentials. No database, Drive file, uploaded resource, or production schema was
read or modified by these probes.

## What failed

The live problem reproduced below is upstream of retrieval. A standalone
arithmetic question fails without involving Marina's resource library or Neon.

| Probe | Observed result |
| --- | --- |
| NVIDIA model list with dedicated Kimi key | HTTP 200; K3 and K2.6 advertised |
| Muse control with that same key | HTTP 200; answered `20` in 3.3 seconds |
| K3 streaming, low reasoning | No response headers before a 120-second client deadline |
| K3 streaming, maximum reasoning | Same 120-second timeout |
| K3 nonstreaming, low reasoning | Same 120-second timeout |
| K3 with documented 5-second polling header, dedicated key | HTTP 504 after 7.6 seconds |
| Same request with the general NVIDIA key | HTTP 504 after 7.6 seconds |
| Same request over HTTP/2 with PING keepalive configured | HTTP 504 after 7.6 seconds |
| Repaired Marina code, K3, 30-second polling header | HTTP 504 after 32.4 seconds; final-header verification also failed after 32.6 seconds |
| Repaired Marina code, Super control | Arithmetic passed in 3.4 seconds; document read/answer passed in 15.5 seconds |

The final K3 invocation ID was `8aa68bee-fbe8-4a37-a73b-d68620260d39`
at `2026-10-02T15:39:16Z`. The HTTP/2 invocation ID was
`23152e80-1671-496d-83fb-241121085d2c`. These IDs can help NVIDIA support locate
the requests; they are not credentials.

NVIDIA's [Cloud Functions invocation documentation](https://docs.nvidia.com/nvcf/overview/generic-http-function-invocation)
describes a platform 504 as no worker taking the request within the polling
window. Our results are consistent with a K3 service/queue availability problem.
They do **not** establish a global outage, its duration, or a confirmed account
entitlement problem. Model-list visibility alone is not proof that inference
works. A database upgrade or another chunk size cannot fix this arithmetic probe.

## Application defects repaired

1. **Pending invocations were not followed.** The previous chat path assumed every
   successful HTTP response was SSE. The image path explicitly rejected 202.
   The [K3 invocation contract](https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k3-infer)
   documents both completed and pending responses. The new transport sends one
   POST and, on 202, polls that invocation through the documented
   [status endpoint](https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k3-statuspolling).
   Polls share the original deadline and never re-upload the prompt or image.
2. **JSON could be mistaken for an empty stream.** Completed JSON, including a
   polled result, is now parsed separately from SSE. These protocol defects were
   reproduced with wire fixtures; the live K3 probes did not return 202, so they
   are not claimed as the proven cause of the older empty-answer screenshot.
3. **An interrupted stream could return partial text.** Success now requires
   nonempty final content and a `stop` finish reason. Reasoning-only, truncated,
   filtered, malformed, and interrupted answers cannot execute tool calls or
   become assistant messages. SSE framing handles split UTF-8 characters,
   heartbeats, CRLF, and usage-only events. `DONE` releases the stream promptly.
4. **Errors obscured useful distinctions.** The transport preserves safe HTTP
   status, error code, and validated NVIDIA request IDs. Provider error bodies
   are never copied into errors or logs. Timeouts and output-limit failures do
   not immediately repeat the same expensive call; retryable failures still get
   the existing single bounded Copilot retry. The selected model is preserved.
5. **Kimi image analysis had too little reasoning headroom.** Its output allowance
   is now 16,384 tokens, matching chat, with a 60-second total request deadline.
   Other image models keep their existing budgets. This is a Marina choice, not
   a vendor-mandated minimum or a guarantee that every page fits.

K3's `reasoning_effort: low`, supported sampling parameters, dedicated key, and
private continuation handling remain in place. [Moonshot's reasoning guide](https://platform.kimi.ai/docs/guide/use-reasoning-effort)
confirms that thinking cannot be disabled and continuation requires the returned
assistant state. Marina keeps that state only within the active tool loop;
stored chat history is supplied as an untrusted transcript on a new turn.

## Code and regression coverage

- `server/services/nvidiaTransport.ts`: authenticated POST/poll transport and
  safe JSON/SSE parsing. Poll URLs stay on the configured origin; redirects and
  provider-supplied destination URLs are not followed.
- `server/ollama.ts`: uses this transport, aborts at the request/turn deadline,
  and logs safe failure metadata.
- `server/services/nvidiaEvidence.ts`: polls chat-based image requests and gives
  K3 its own output allowance. OCR detector and reranker contracts are unchanged.
- `server/services/copilotConversation.ts`: respects nonretryable failures.
- `nvidiaTransport.test.ts`, `nvidiaChat.test.ts`, `nvidiaEvidence.test.ts`, and
  `copilotConversation.test.ts`: exercise raw wire responses, pending IDs and
  deadlines, malformed inputs, authentication/rate/provider failures, stream
  truncation, private-state handling, and avoiding duplicate tool execution.

The SSE framing helper is exported by the installed OpenAI SDK. It is used
without the SDK's default event JSON parser, which logs raw malformed events.
Keep the wire regression suite when upgrading that dependency.

Validation: the full unit suite passed **1,136 tests in 115 files**. The final
retry-classification refinement then passed all **36 conversation tests**,
including one additional regression (1,137 unique unit cases across these runs).
The isolated integration suite passed **158 tests in 16 files**. TypeScript,
production build, serverless entry check and Vercel preflight passed. The build
retains its pre-existing large-client-chunk warning.

## Reproduce without exporting personal documents

With the existing server environment loaded:

```powershell
node --env-file=.env --import tsx scripts/check-nvidia-model.ts
node --env-file=.env --import tsx scripts/check-nvidia-model.ts nvidia/nemotron-3-super-120b-a12b
node node_modules/vitest/vitest.mjs run src/utils/__tests__/nvidiaTransport.test.ts src/utils/__tests__/nvidiaChat.test.ts src/utils/__tests__/nvidiaEvidence.test.ts src/utils/__tests__/copilotConversation.test.ts
```

The opt-in script first requires the correct arithmetic answer, then exercises
Marina's actual conversation loop against one fictional document. A pass requires
exactly one document read, its test code and page in the answer, and no proposed
actions. Failure exits nonzero; it never substitutes another model. Reports
contain synthetic evaluation results and operational metadata in ignored `tmp/`,
without API keys, original documents, or model reasoning.

K3 should be considered unverified until both live cases pass. The passing Super
control establishes a working option; it does not validate K3, image reading,
all real documents, or concurrent provider capacity. If K3 continues returning
504, provide NVIDIA with the model ID, UTC time, invocation ID, and synthetic
reproduction. Do not send an API key or library documents in a support report.
