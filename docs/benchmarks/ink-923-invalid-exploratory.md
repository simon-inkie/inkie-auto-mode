# INK-923 invalid exploratory evidence

These four local raw outputs are quarantined under
`benchmarks/results/invalid-exploratory/`. They are retained for audit only and
must not be used for a Gemini-versus-Jev provider comparison.

| Raw output | Records | Why invalid |
| --- | ---: | --- |
| `2026-09-19T21-42-18-571Z` | 636 | Gemini used the full two-stage classifier; Jev used one Choice call. |
| `2026-09-19T21-59-53-641Z` | 636 | Same structurally confounded one-stage Jev design. |
| `2026-09-19T23-07-35-530Z` | 636 | Corrected orchestration attempt contained 190 Gemini provider errors. |
| `2026-09-19T23-09-36-563Z` | 636 | Corrected orchestration attempt contained 191 Gemini provider errors. |

The first clean-batch attempt on 20 September 2026 stopped after Gemini repeat
1 reported 48 provider-error fixtures. Its 64-token Stage 1 cap still truncated
visible output on full classifier inputs. The fail-fast runner wrote no raw
result file. This attempt is invalid operational evidence only.

The next clean-batch attempt completed two pairs, then stopped after one Gemini
provider-error fixture in repeat 3. The 20-second request cap was below earlier
observed valid Stage 2 latency. The fail-fast runner again wrote no raw result
file; the two completed pairs are exploratory only.

The raw files remain gitignored because they are local fixture-level evidence.
Only a clean four-pair run with zero provider errors is eligible for the amended
comparison report.
