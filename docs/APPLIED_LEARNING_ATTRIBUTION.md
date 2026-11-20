# Applied Learning Attribution

Approved channel-learning recommendations are recorded on the production strategy when they are supplied to generation. The analytics capture path copies those recommendation IDs into each performance snapshot's `contentAttributes.appliedLearnings` field.

## Attribution rules

- Packaging recommendations are attributed only when a non-control title and/or thumbnail variant from that recommendation is explicitly selected and approved. A manual title override is not attributed to the generated title variant.
- Post-publish packaging changes are recorded separately in the schedule metadata with timestamp, previous title, and applied title. They are included in analytics snapshots as an audit trail, but are not misclassified as application of a pre-publish recommendation.
- Approved script recommendations passed to generation are recorded separately as `learningGuidance` with `provided_to_generation_not_verified_as_applied`; prompt exposure alone is not proof that the generated script followed the recommendation.
- Script recommendations remain `learningGuidance` unless a deterministic output check verifies application. Currently, only `hookLength` recommendations with an exact `concise` or `extended` preference are eligible: the generated hook text is word-counted, with 40 words or fewer classified as concise and more than 40 as extended. A match is stored in script metadata with the recommendation ID, expected/observed value, word count, verification method, and `verified_applied` status; only that record can enter `appliedLearnings`.
- The attribution path recomputes verification from the saved script output and the approved recommendation supplied to generation. It does not trust a stored verification flag or caller-provided word count as proof.
- `length` recommendations are eligible only when `prefer` is an explicit numeric minute range (for example, `8-12 minutes`). The verifier counts generated spoken text across hook, introduction, sections, conclusion, and CTA, then estimates duration at a documented 130 words per minute. The estimate must fall inside the requested range. The word count, estimate, range, and assumption are retained in the audit record; this is a deterministic estimate, not a measured audio runtime.
- `format` and `retention` recommendations remain guidance-only. This includes Tutorial, List, Review, Story, and Explainer labels: the current normalized script schema does not preserve a complete, validated format-specific structure for these types. A title, section headings, loosely structured `steps`/`items`/`points`, requested strategy value, or model self-report is not sufficient independent proof. Even if caller-supplied metadata claims `verified_applied`, the attribution path ignores that claim and recomputes only the supported hook-length and script-length checks.
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


## Automated experiment safety pause

Automated packaging experiment creation and start are disabled while the integration lacks randomized viewer assignment and verified arm-level exposure. This prevents the application from rotating public titles and thumbnails in sequential time windows while presenting the result as a test.

- New experiment creation and activation return `EXPERIMENT_RANDOMIZATION_UNAVAILABLE`.
- Existing legacy running experiments are stopped on their next refresh attempt. The service restores the saved control title/thumbnail, clears any winner, and marks the experiment `inconclusive`.
- If restoring the control package fails, the experiment is marked `action_required` with the restore error; it is not silently treated as completed.
- Existing draft/approved experiments cannot be activated through the service.
- Use YouTube Studio's native Test & Compare manually where available. The current application does not claim to import or verify native experiment assignments/results.
- Re-enable automation only after an integration can prove randomized assignment, per-arm exposure and outcome metrics, and a supported measurement window.
