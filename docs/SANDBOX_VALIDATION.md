# Sandbox validation results

**Assessment date: 2 November 2026 (Pacific).** The invoice pilot has completed
live model-agent execution, real Docker isolation tests and independent checks
of the resulting files. This report summarizes observed results using fictional
inputs. Raw captures, provider identifiers, generated code and local screenshots
remain outside source control.

## Live execution observed

Three separate Coder → Verifier workflows completed. Coder supplied Python through
the fixed calculation tool; the controller executed it in disposable Docker
containers. Verifier invoked a deterministic host checker that compared actual
result bytes with withheld expected integers. Each run made four model requests,
for 12 requests and 5,635 reported tokens in total.

| Fictional case | Invoice count | Subtotal, cents | Tax, cents | Total, cents | Independent output check |
| --- | ---: | ---: | ---: | ---: | --- |
| invoice-a | 4 | 1,925 | 134 | 2,059 | Passed |
| invoice-b | 4 | 1,151 | 80 | 1,231 | Passed |
| invoice-c | 3 | 2,282 | 159 | 2,441 | Passed |

All three completed-record assessments were within scope with supplied evidence
complete. All three execution receipts reported container cleanup. On review,
all ten files listed by each case's manifest matched their saved SHA-256 values.
That establishes correspondence with the saved baseline, not producer authenticity.

## Final executor and control tests

The live runs occurred before the final tmpfs workspace and separate-collector
hardening. Their three saved, model-written programs were subsequently executed
again with the final executor: all three produced the exact expected results,
preserved the input, and reported cleanup. These rechecks made **zero provider
calls**. They validate the saved programs against the final executor; they are
not three additional live model workflows.

The reviewed final executor source, `experiments/sandbox-agent/sandbox.py`, has
SHA-256 `bb1ff7d3ba502de99203376bf425e951f0299e86838d34a8e1cf49a75ae225f9`.
Its supporting pilot, contract, case and test source hashes also matched the
private verification summary at review time.

| Check | Observed evidence | What it establishes |
| --- | --- | --- |
| Actual execution and grading | Real output files passed the independent integer/schema/hash checker | These fictional calculations succeeded; the model's own success claim was insufficient |
| Network and filesystem restrictions | Real-container tests failed outbound socket access and writes outside the workspace | The tested operations were restricted under the effective Docker settings |
| Resource limits and cleanup | Real-container tests exercised timeout, excessive output, memory and workspace exhaustion, and checked cleanup | The tested failure paths were bounded and cleaned up |
| Artifact integrity | Tests rejected unsafe archive links/paths and wrong or changed output; changed input was detected | These tested invalid artifacts cannot pass the grader |
| Pilot authority checks | Offline tests denied wrong-role, expired and out-of-scope actions before execution | The named gateway rejects those tested requests before side effects |
| Handoff and dashboard findings | SDK replay used real Docker execution; derived over-grant and missing-grant records produced violation and unknown outcomes | Wiring and retrospective classification work for these cases; mutations do not imply actual unauthorized execution |

The original final-code check passed 54 application tests, including 17 sandbox
tests, plus four security-safeguard tests. Six browser-persistence tests were added
after that run, bringing the current full offline suite to **60 application tests**. The full
suite was rerun for this change: all 60 passed, including all 17 sandbox tests,
with no live model requests.
The original live result and later source rechecks remain separate evidence.

## Dashboard review observed

The completed invoice-a export was imported into the local dashboard. Both Coder
and Verifier actions were visible. Reloading after browser-local persistence was
added restored the run and the selected Verifier hop. Its raw event, narrower
grant, parent grant, tool call reference and artifact hash remained available.
Saved records are parsed again and findings recomputed on startup.

Dashboard status is an assessment of supplied completed-action evidence. Denied
attempts, failed executions and business-result validation have separate receipts;
the completed-action dashboard does not display those receipts in full. Keep the
original exports and supporting files for a complete pilot review.

## Repeat the checks

Follow the [pilot setup and commands](../experiments/sandbox-agent/README.md).
`python scripts/check.py --with-sdk --with-sandbox` runs offline checks with real
Docker execution and no model spending. A new live run requires separate explicit
authorization, provider access and a new ignored output directory.

These are bounded engineering results for one fictional workload. Three live
cases do not establish statistical reliability, a sandbox-escape audit,
authenticated external identities, general delegation enforcement, multi-user
safety or production readiness. Docker and the local host remain trusted.
