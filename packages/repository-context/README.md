# `@openge/forge-repository-context`

Deterministic, model-free repository evidence for bounded code investigation.

Use it when a tool needs repeatable scoped candidates, verified source windows, or explicit relation evidence. When the exact file is known, use `read` directly if verified source is needed. Skip repository search in that case, and use other tools for IDE/LSP refactors, semantic translation, embeddings, or agent planning.

The runtime-neutral root exports corpus/search/investigation primitives. Node-only build, freshness verification, source reads, and CLI live under `/node`; TypeScript and C++ extractors use their adapter subpaths.

CLI: `build`, `check`, `investigate`, `read`. `investigate` defaults to the `evidence` view and 4 KiB pages; choose `locate` for metadata-only results or `relations` for explicit graph evidence. The evidence view measures the full JSON response and upgrades verified source ranges when they fit the requested byte budget. An explicit `--scope` is a hard search boundary. If every explicitly requested scope is absent from the indexed corpus, `investigate` returns `status: "insufficient"` with `reason: "REQUESTED_SCOPE_MISSING"`; treat that as terminal negative evidence for those scopes instead of broadening the search implicitly. Query text promotes a relative path to a hard scope only when it starts at an indexed root, uses an explicit `./` prefix, or names a file with an extension; ordinary slash-separated prose stays searchable text. Decoded Windows backslash query paths are recognized as relative paths. `read` defaults to 16 KiB. Follow `nextCursor` for more evidence entries; continuation binds the generation, request, budget, and evidence display strategy. Restart at page one after a strategy change. `expansion` identifies a larger available source range; `expand` identifies an entry whose body was cut by the byte budget. `complete` only means the selected body was delivered intact, while `wholeFile` means the full source file was delivered.

For multi-term evidence queries, candidate selection may include the top matching source body when symbol-name ranking omitted it, while preserving explicitly named symbol candidates. When a query names multiple directories, candidate selection keeps a result from each named directory within the candidate limit. The effective request scope also bounds source-body reads and hints. `locate` remains metadata-only and does not read source bodies.

`current-verified` rechecks source and semantic inputs. `frozen` requires an authorized `@openge/forge-source-snapshot` store plus explicit `--snapshot-root`, `--snapshot-owner`, and `--snapshot-id`; a mutable root or flag alone is not trusted.

Chinese and mixed text use deterministic lexical tokenization only. No translation, model, embedding, reranker, background service, or runtime network fallback is invoked.

See the [full usage documentation](https://github.com/zopenge/foundation-forge/blob/main/docs/packages/repository-tooling/repository-context.md).

Apache-2.0.
