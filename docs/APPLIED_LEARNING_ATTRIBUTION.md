# Applied Learning Attribution

Approved channel-learning recommendations are recorded on the production strategy when they are supplied to generation. The analytics capture path copies those recommendation IDs into each performance snapshot's `contentAttributes.appliedLearnings` field.

## Attribution rules

- Packaging recommendations are attributed when the approved packaging learning is passed to thumbnail and SEO generation.
- Script recommendations are attributed when approved script learnings are passed to script generation.
- Recommendation IDs are de-duplicated per production.
- Only non-simulated 7-day performance snapshots are eligible for application feedback.
- A recommendation needs at least two distinct productions and at least 2,000 total impressions before it can receive a directional signal.
- Packaging feedback uses CTR; hook/retention feedback uses average view percentage; format/length feedback uses watch hours per thousand views.
- The measured delta is compared with the channel baseline stored on each performance snapshot. Missing deltas remain missing.

## Feedback statuses

- `not_observed`: no mature, reliable 7-day snapshot is linked to an application.
- `insufficient_data`: fewer than two eligible productions or fewer than 2,000 impressions.
- `inconclusive`: sufficient exposure exists, but the selected metric/baseline is unavailable or the median delta is between -5% and +5%.
- `positive_signal`: median baseline-relative delta is at least +5%.
- `negative_signal`: median baseline-relative delta is at most -5%.

These are observational associations, not causal conclusions. They do not approve, reject, or automatically change any learning recommendation. Human review remains required.
