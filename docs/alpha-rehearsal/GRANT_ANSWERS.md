# Facilitator key for grant lookup

Give each reviewer a single pack per method. For the next reviewer swap pack assignments and rotate which method comes first. Separate setup time from evidence-reading time and record unanswered questions and incorrect decisions. The generated records contain two equivalent sets of cases with different account resources and case order.

| Exercise | Pack A · river | Pack B · cedar | Evidence to cite |
| --- | --- | --- | --- |
| Unchanged supporting grant | case-01 | case-02 | **No regression found**. The research agent reads the account at `10:04:07Z` under `g2`, issued by the coordinator. The final summary agent reads at `10:04:12Z` under `g3` issued by the research agent. Both leaf and upstream grants allow that account read. |
| Missing referenced grant | case-02 | case-03 | **Needs review**. Candidate research action `e2` at `10:12:07Z` references missing `g2`. Candidate `g3` exists but also names missing parent `g2`. Baseline `g2` exists only in the baseline snapshot for this comparison. |
| Delegated grant exceeds parent scope | case-03 | case-01 | **Regression detected**. Candidate export agent `e3` exports at `10:08:12Z`. Candidate `g3` grants export, while its parent `g2` and root `g1` grant read. Baseline `g3` with the same identifier permits read to the summary agent. |

The principal in both packs is fictional `user:avery`. Resources are `crm://accounts/river` and `crm://accounts/cedar`. Times are on 2026-09-13 UTC. A parent deep link should preserve case, run side, action and selected grant after reload. **Return to this action** should reopen the linked row in the action directory. These tasks can be completed through the dashboard without opening raw files. Human review speed and comprehension require a separate uncoached observation.

The browser acceptance exercise covers all six dashboard candidates and the
three original worksheet cases. It opens grants with the keyboard, follows
parents, reloads, returns focus to the selected action, and rejects the altered
follow-up before closing the two corrected worksheet cases. It required no
raw-file step in the dashboard. The ordinary-review comparison remains
available for independent reviewers.
