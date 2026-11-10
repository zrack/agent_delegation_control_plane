# Private alpha facilitator answer key

Give reviewers the `reviewer` folder and keep this key separate until they have
completed the task sheet. Record the tested revision and environment, elapsed
time, any assistance, and the evidence the reviewer actually opened. Treat these
as fictional exercises.

## Initial cases

| File | Expected current verdict | Evidence a correct explanation should cite |
| --- | --- | --- |
| `case-01.json` | **No regression found** | Coder executes in the invoice owner's run-local sandbox. Verifier checks that run's `results.json` using the narrower grant ending in `-g2`. The two runs use different call IDs and artifact hashes, with the same actions, target roles and grant scope. |
| `case-02.json` | **Regression detected** | The export agent records `account:export` on `crm://accounts/northstar` for the fictional account principal `user:avery`. The action is `CH-002-e3`. Its grant `CH-002-g3` exceeds the parent `CH-002-g2`, which supplies `account:read` only. **Fix required** is a reasonable decision. |
| `case-03.json` | **Needs review** | Research agent `CH-003-e2` records `account:read` on `crm://accounts/northstar` for `user:avery`. The event references `CH-003-g2`, which the export omits. The summary agent also depends on that grant through its parent. **Evidence needed** is a reasonable decision. |

## Follow-ups and closure

| File | Expected result | Evidence and closure state |
| --- | --- | --- |
| `follow-up-01.json` | Attachment rejected | The package records a pass, but its candidate changes the final action back to `account:export` after packaging. The candidate fingerprint no longer matches. **Close as resolved** stays disabled. |
| `follow-up-02.json` | Accepted, **No regression found** on the follow-up | The original pinned baseline matches. The final action and its grant use `account:read`. The original regression remains visible. Closure is available after inspection and requires an explicit click. |
| `follow-up-03.json` | Accepted, **No regression found** on the follow-up | The original pinned baseline matches. The research grant `CH-003-g2` is present and supports the research action and the downstream grant. The original review verdict remains visible. Closure is available after inspection and requires an explicit click. |

After reload, the saved decision and reason remain visible, and each case closed
with a passing follow-up remains **Resolved**. Closing either case with the altered
package or before attaching its verified follow-up is a failed rehearsal step.

## Record the rehearsal

Mark each explanation **supported**, **partial**, or **incorrect**. A supported
explanation identifies the action and resource and cites the actual grant or gap.
Record assistance separately from accuracy. Note whether the reviewer correctly
refused the altered package and verified both corrected runs before closing. Keep
observed friction and operator feedback separate from automated test results.
