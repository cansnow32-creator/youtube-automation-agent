# Applied Learning Attribution

Approved channel-learning recommendations are recorded on the production strategy when they are supplied to generation. The analytics capture path copies those recommendation IDs into each performance snapshot's `contentAttributes.appliedLearnings` field.

## Attribution rules

- Packaging recommendations are attributed only when a non-control title and/or thumbnail variant from that recommendation is explicitly selected and approved. A manual title override is not attributed to the generated title variant.
- Post-publish packaging changes are recorded separately in the schedule metadata with timestamp, previous title, and applied title. They are included in analytics snapshots as an audit trail, but are not misclassified as application of a pre-publish recommendation.
- Script recommendations are attributed when approved script learnings are passed to script generation.
- Recommendation IDs are de-duplicated per production.
- Selecting only control variants does not count as applying a packaging recommendation.
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


## Packaging experiment evidence boundary

The current packaging experiment runner rotates title/thumbnail packages sequentially on the same video. YouTube Analytics returns video-level measurements and does not expose randomized viewer assignment or per-arm impression/click attribution for this workflow.

- Samples and arm summaries contain video-level snapshots captured while an arm was active; they are not arm-attributed impressions, clicks, or CTR.
- Sequential CTR differences are not treated as independent randomized samples; no z-score, arm-level CTR, qualified arm impression count, or causal lift is calculated.
- The current sequential workflow cannot select a winner, even when an observed CTR difference is large or impression counts exceed the configured threshold.
- Experiment feedback exposes `comparisonMethod: sequential_same_video_observational`, `exposureAttribution: unavailable_from_youtube_analytics`, and `causalInterpretation: observational_only_no_causal_winner`.
- Such experiments finish as `inconclusive`; they cannot create an approved learning recommendation or be adopted as a validated winner.
- A causal winner requires a future integration that provides verifiable randomized assignment and arm-level exposure/outcome metrics. Until then, human review may inspect observations, but the system must not label them an A/B winner.

This safeguard intentionally favors honest evidence over a misleading statistical result.
