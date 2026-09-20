# INK-923 public evidence manifest

All SHA-256 values are calculated over the copied file in this directory.
Source paths are local provenance only; the public artefacts are the files
under `raw/`.

| Public file | SHA-256 | Local source path | Public baseline | Model / policy |
| --- | --- | --- | --- | --- |
| `raw/ink-923-jev-vs-gemini-2026-09-20T18-13-06-963Z.json` | `9f84503f715fc2c6a9f4f4f856fe662395e54873f5c5ce143f8e5567917c5fe6` | `benchmarks/results/ink-923-jev-vs-gemini-2026-09-20T18-13-06-963Z.json` | `fa0e39e457adaaa17ccf91cd25566702cfbe4731` | Jev `jev-1.13.0`, current choice |
| `raw/ink-923-jev-vs-gemini-2026-09-20T18-33-06-442Z.json` | `94d621f97f635c7ddeb38e79b610dae3c2cc9fb3cf69caf392d2f9dcb978a400` | `benchmarks/results/ink-923-jev-vs-gemini-2026-09-20T18-33-06-442Z.json` | `fa0e39e457adaaa17ccf91cd25566702cfbe4731` | Gemini `google/gemini-3.8-flash` |
| `raw/ink-923-jev-vs-gemini-2026-09-20T18-36-23-288Z.json` | `a5ebbeef01c310a9840b1824a9e6fbd4995fbedfd3bf9a36932b2f3e4a578c6c` | `benchmarks/results/ink-923-jev-vs-gemini-2026-09-20T18-36-23-288Z.json` | `fa0e39e457adaaa17ccf91cd25566702cfbe4731` | Gemini `google/gemini-3.5-flash-lite` |
| `raw/ink-923-jev-vs-gemini-2026-09-20T19-48-49-069Z.json` | `899d3a24e22edda34322591fe709a6825934a73ea21d80a8253969ee1d699092` | `benchmarks/results/ink-923-jev-vs-gemini-2026-09-20T19-48-49-069Z.json` | `4fd1ece244b072f4d2ddb92661e3415e017f6d8a` | Jev `jev-1.13.0`, thresholded-A `.85/.60/.03` |
| `raw/ink-923-jev-vs-gemini-2026-09-20T20-00-04-854Z.json` | `f85ee9560dc882c162b9289fdb3113edbd4a05dceb8b82a732de1c723c98834b` | `benchmarks/results/ink-923-jev-vs-gemini-2026-09-20T20-00-04-854Z.json` | `1c6851c4550e1a3ec398caca314ab0579e37e0f1` | Jev `jev-1.13.0`, thresholded-A `.86/.61/.09` |

The common fixture SHA-256 is
`008179d533942eebf326a4adb0786371ec06129f811fa9c0b5f219ff99e2811c`.
The common shared-classifier system prompt SHA-256 is
`c3cb28a5bd36e5a2a0ed67144ecec4f5add43f5251ecc4779c4c8f417bebce9b`.

To verify after copying the folder, run from the directory containing
`MANIFEST.md`:

```sh
sha256sum -c <(sed -n 's/^| `raw\/\([^`]*\)` | `\([0-9a-f]*\)`.*/\2  raw\/\1/p' MANIFEST.md)
```
