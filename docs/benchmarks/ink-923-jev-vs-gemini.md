# INK-923: Jev versus Gemini Flash variants

## Result

Two independent passes of the public 159-fixture corpus completed on 19 September 2026 using the pinned latest GA Gemini benchmark model. This is a benchmark-only comparison: it changes no installed adapter, live route, private configuration, or credential source.

| Provider | Model | Runs | Passed | Expected-block misses | Mean latency | Median latency |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Gemini | `google/gemini-3.8-flash` | 318 | 289 | 12 | 8,804 ms | 3,800.5 ms |
| Jev | `jev-1.13.0` | 318 | 255 | 26 | 177 ms | 246.5 ms |

An expected-block miss means an expected `block` result returned either `allow` or `ask`. Gemini had six misses in each pass. Jev had 13 in each pass. The providers disagreed on 70 of 318 matched runs, concentrated in `destruction-safe-path` (18), `config-mutation` (12), and `credential-access` (12).

Jev returned confidence for its 190 non-static calls: mean 0.7079. It exposed 96,640 input and 7,220 output tokens. Its published Jev 1.13 input rate of $0.042 per million tokens gives an estimated $0.0041 total input cost; output tokens are listed as free. Gemini's endpoint did not expose usage, so no Gemini cost is claimed.

## Reproducibility

- Public baseline: `fa0e39e457adaaa17ccf91cd25566702cfbe4731`
- Corpus: 159 fixtures, SHA-256 `008179d533942eebf326a4adb0786371ec06129f811fa9c0b5f219ff99e2811c`
- Prompt SHA-256: Gemini system `c3cb28a5bd36e5a2a0ed67144ecec4f5add43f5251ecc4779c4c8f417bebce9b`; Jev Choice `3345f4bd624bc59fd511ae5b258b801d8a31101ca2bab8b7057ae2ba20261b5c`
- Two repeats, concurrency four, 636 total records, zero provider errors.
- Run `pnpm benchmark:jev -- --repeats 2 --concurrency 4 --baseline <public-commit>` with `TYPESAFE_API_KEY` and a Google Gemini API key supplied externally. The runner resolves no private route or configuration. The Jev key used for this run was supplied only through the local pass entry and is neither logged nor stored.

Raw result records are gitignored because they contain fixture-level model output. The committed report contains aggregates only.
