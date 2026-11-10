# Evaluation contracts

`evaluator.test.mjs` contains 27 deterministic domain and resource-limit tests. `comparison.test.mjs` covers eight run-alignment, difference and regression cases. `regression.test.mjs` covers offline command verdicts, evidence references, baseline integrity and package creation. `review.test.mjs` covers verdict reproduction, snapshot mismatch, persisted reviews, stale writes, package round-trips and verified case resolution. `alpha-rehearsal.test.mjs` generates the kit and checks its packages through the inbox and closure rules. `test_server.py` contains four loopback HTTP containment tests. Run `python3 scripts/check.py` from the package root to include those, plus two import, two controlled-capture and eight browser-local persistence tests in `storage.test.mjs`, for 61 tests total.

The optional pinned SDK environment adds two offline replay tests with `python scripts/check.py --with-sdk`. Replay verifies callback/tool/handoff wiring without contacting a provider. No test result establishes real-source authenticity, complete capture, prevention or operator value.

Keep domain fixtures independent of implementation. Review semantic contract changes explicitly; never weaken assertions to hide a regression. This standalone package does not include private governance/evaluation history.
