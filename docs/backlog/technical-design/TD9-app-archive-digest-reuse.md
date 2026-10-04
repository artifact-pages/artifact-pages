# TD9 — App deploy archive digest reuse

- Status: Done
- Phase: CLI app deployment
- Related verification: [T21](../verification/T21-command-cost-audit.md), [T22](../verification/T22-cache-purge-retry.md)
- Product contract: [Specification](../../specification.md)

## Decision

`app deploy` stores each per-file SHA-256 beside the exact immutable byte slice captured during archive validation. HEAD comparison and changed-object PUT metadata reuse that digest. The compressed archive checksum remains separate. This does not skip per-object HEAD or change drift repair.

## Evidence

The paired probe used baseline `d2a4aa7a` and implementation commit `bf5be85a`, with five files per bundle and 1 / 8 / 32 MiB payloads. Each size covered initial deployment, no-op, one-file sparse update, and dense update, three times each. The legacy counts below are source-derived from the previous call sites; candidate per-file counts are one captured-byte hash per bundle entry. They are not hash-runtime instrumentation.

| Payload | Captured file bytes | Initial/no-op calls and bytes, old→new | Sparse calls and bytes, old→new | Dense calls and bytes, old→new |
| --- | ---: | --- | --- | --- |
| 1 MiB | 1,048,628 | 5→5 calls; 1,048,628→1,048,628 bytes | 6→5; 1,310,772→1,048,628 bytes | 10→5; 2,097,256→1,048,628 bytes |
| 8 MiB | 8,388,660 | 5→5 calls; 8,388,660→8,388,660 bytes | 6→5; 10,485,812→8,388,660 bytes | 10→5; 16,777,320→8,388,660 bytes |
| 32 MiB | 33,554,484 | 5→5 calls; 33,554,484→33,554,484 bytes | 6→5; 41,943,092→33,554,484 bytes | 10→5; 67,108,968→33,554,484 bytes |

Initial deployment hashes each file once for PUT metadata in the old path; no-op hashes each file once during HEAD comparison, so neither case saves per-file work. Sparse updates remove the changed file's second pass. Dense updates halve the number of per-file hash passes. The archive checksum remains one separate SHA-256 over the compressed archive (1,049,501 / 8,391,771 / 33,565,279 bytes).

The local fake observed 4 control GETs (3 lock reads and 1 retry-journal read), 3 lock conditional PUTs, and 5 application HEADs in every row. Application PUTs were 5 / 0 / 1 / 5 for initial / no-op / sparse / dense. Retry-journal conditional PUT, delete, and invalidation were each 1 for changed rows and 0 for no-op. Final keys, bodies, HTTP policy, release provenance, and SHA metadata matched the previous upload rule in all 12 rows. These are logical fake-backend calls, not provider HTTP or billing measurements.

Candidate-only local `DeployApp` medians are recorded in `.local/td9-audit/digest-reuse-probe.log`; they do not compare against an old implementation and do not establish an end-to-end wall-time gain. This probe uses five files, so it does not measure many-small-file overhead. Peak/RSS and memory were not measured, and there was no live provider operation. Reproduce with `cd cli && go test -tags td9audit ./internal/publisher -run '^TestTD9ProbeAppDigestReuseAcrossBundleAndChangeShapes$' -count=1 -v`.

## Preserved contracts and scope

Archive, adjacent manifest, and checksum validation; path/type/size/duplicate checks; full HTTP policy and release provenance; every object's HEAD-based drift repair; `index.html` last; and T22's cache retry behavior remain unchanged. No persistent state, remote operation, invalidation path, or cache-key change is introduced. No-op HEAD omission and historical hashed-asset deletion remain out of scope.

## Done

Adopt the same-entry digest reuse. It saves a redundant per-file SHA pass for existing changed objects—one file on the sparse fixture and all five files on the dense fixture—while initial/no-op hash counts, every HEAD, and provider-operation counts remain unchanged. Verification: `go test ./...`, `go test ./internal/publisher`, the focused digest test, the tagged 12-row probe, `go test -race ./internal/publisher`, and independent Luna max review PASS. This establishes reduced local hash work, not reduced remote calls or measured overall latency.
