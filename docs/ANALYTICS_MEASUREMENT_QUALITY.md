# YouTube Analytics measurement quality

The analytics pipeline distinguishes measured zero values from unavailable measurements. A successful API request does not imply that every metric was returned for the selected video and measurement window.

## Rules

- Empty views, watch-time, or thumbnail reports remain unavailable (null values and an explicit availability/data-quality state); they are not converted into zero-performance signals.
- CTR is impression-weighted across daily rows. Rows without a positive impression count or a valid CTR do not contribute to the weighted result.
- Engagement uses YouTube Analytics views, likes, and comments for the same requested measurement window. Lifetime counters from the YouTube Data API are not mixed into a windowed engagement rate.
- Missing retention, CTR, engagement, search-source, and device measurements do not generate low-performance warnings or optimization recommendations.
- A performance score with no measured components is null with grade N/A, not zero.
- Partial API failures retain available real metrics and expose unavailable sections in dataQuality. A simulated fallback remains explicitly marked and is not eligible for learning.
- Traffic-source and device percentages are unknown when the report has no measurable denominator.

## Interpretation

A null value means the system cannot make a reliable statement for that metric and period. It does not mean zero views, zero engagement, poor retention, or a failed thumbnail. Operators should wait for a supported measurement window or reconnect the required YouTube API access before using that metric to guide future content.


## Fixed early-life measurement windows

The learning scheduler records separate publication-anchored windows:

- `24h`: one UTC calendar-day bucket beginning on the publication date
- `7d`: seven UTC calendar-day buckets beginning on the publication date
- `28d`: 28 UTC calendar-day buckets beginning on the publication date

YouTube Analytics reports daily buckets rather than exact publication-hour slices. The scheduler waits until the corresponding full elapsed age (24 hours, 7 days, or 28 days) before requesting the window, then queries exactly the corresponding number of date buckets. Therefore these are daily-bucket approximations, not exact intraday 24-hour/7-day/28-day exposure intervals. Each window is stored independently for the same video. The snapshot also retains its requested measurement-window name, exact start/end dates, day count, and `utc_calendar_days` precision marker so later reports can audit which source period produced the metrics.

Channel-wide recommendations and cohort insights use the exact `7d` window as their comparable baseline. A video that has only a 24-hour or 28-day snapshot is not substituted into the 7-day cohort. This avoids comparing early launch performance with longer cumulative totals. The 24-hour and 28-day snapshots remain available for their own reporting and longitudinal analysis; they do not silently influence the fixed 7-day recommendation cohort.

All these windows are cumulative since publication, not rolling periods. Comparisons remain observational and do not establish that a format, title, or script choice caused the measured outcome.


## Longitudinal window interpretation

The summary exposes a separate longitudinal view for the reliable 24h, 7d, and 28d snapshots. These are nested cumulative windows anchored to publication, not disjoint periods. Views, watch hours, net subscribers, and estimated revenue are additive totals and are shown as per-day averages (window total divided by its calendar-bucket count) to make window lengths more comparable. These averages remain descriptive and do not establish that performance accelerated or declined in the later, non-overlapping days.

CTR, retention, and engagement rate are reported independently for each window. They are not subtracted across windows or described as period-over-period changes because the snapshots are cumulative and their rate denominators/measurement populations may differ. Missing values remain unavailable; simulated snapshots are excluded; each video contributes at most once to each window.

## Content-surface boundaries

Learning recommendations are built separately for Shorts and long-form videos. Their reach, retention, and viewing behavior are not pooled into one cohort. Recommendation evidence and proposed changes retain the originating surface so an observed pattern in one surface cannot silently steer the other.


## Traffic-source measurement boundaries

Per-video discovery reports retain YouTube's canonical `insightTrafficSourceType` identifiers (for example `YT_SEARCH`, `RELATED_VIDEO`, `VIDEO_BROWSE`, `SHORTS`, `EXT_URL`, and `NOTIFICATION`). Human-readable labels are display metadata only. Unknown and `OTHER` values remain unclassified and are not relabeled as search, suggested, or browse traffic.

The report uses the requested Analytics date range and the `views` metric by traffic-source dimension. It does not claim source-level impressions or click-through rate: those values are not derived from overall video CTR. Source percentages and aggregate shares are withheld when any returned row has a missing/invalid view count, because a partial denominator can make every share misleading. A missing source row is not interpreted as zero traffic.

Shorts feed, browse, suggested videos, search, external, notifications, channel pages, playlists, and other source families remain distinct. Search-quality interpretation uses only recognized search source identifiers; an unknown-only report is not described as poor search performance. These traffic-source summaries are descriptive and are not automatically converted into cross-surface recommendations.


## Minimum cohort size and surface-safe comparisons

A missing content-format label is stored as `unknown`; it is never silently defaulted to long-form. Unknown-surface snapshots are excluded from surface-specific recommendation generation until their format is known.

Dimension recommendations require at least three independent videos in each compared group. Channel-level CTR and retention recommendations require at least three videos with the corresponding measured metric. Outcome-alignment recommendations require at least six eligible videos overall and at least three measured videos in each compared group. These are minimum screening thresholds, not proof of statistical significance.

Performance insights expose separate `surfaceBreakdowns.long_form` and `surfaceBreakdowns.shorts` cohorts. When both surfaces exist in the same requested window, the combined descriptive dimensions remain available for continuity but no pooled leader is declared. A cohort can be ranked only when every compared cohort has at least the minimum number of measured values for the same ranking metric. Performance score is preferred only when all cohorts meet that threshold; views are used as a fallback only when all cohorts meet it. Cohort size alone cannot compensate for missing metric values, and the system never compares a performance score in one cohort against views in another.


## Recommendation evidence freshness

Recommendations generated from the fixed 7-day cohort retain the oldest and latest source measurement timestamps, the cohort sample count, and a 90-day maximum evidence age. The oldest contributing cohort timestamp is used conservatively: one old measurement can make the recommendation stale even if newer measurements are also present.

Approved recommendations remain in the review history, but future script and packaging generation only consume recommendations with at least two timestamped samples whose oldest measurement is no more than 90 days old. Missing, invalid, future-dated, or legacy evidence without timestamps is treated as unknown and is not applied. This is a usage safeguard, not an automatic approval/rejection or deletion; operators can review refreshed evidence and approve a current recommendation separately. The 90-day threshold is a policy constant in the learning utility, not a statistical significance claim.


## Applied-learning feedback quality

Application feedback is grouped by recommendation and content surface. Shorts and long-form results are never combined into one recommendation signal. Only real, dated 7-day snapshots with at least 1,000 impressions and a stable production/video identity are eligible. Production IDs and published YouTube video IDs are treated as aliases for the same production when records link them, so snapshots that alternate between production-only, video-only, or both identifiers cannot inflate the independent-production count. Repeated snapshots for one linked production count once, using the latest measurement. If linked records disagree about whether the content is Shorts or long-form (including an unknown surface), that production is excluded from applied-learning feedback rather than counted in multiple surface cohorts.

Script recommendations merely supplied to generation remain guidance exposure and are not counted as applied learning. Deterministic checks now verify exact `hookLength` preferences (`concise`/`extended`) against the generated hook's actual word count (40-word boundary), and explicit numeric `length` ranges (for example, `8-12 minutes`) against generated spoken-text word count estimated at 130 words per minute. The verifier recomputes these checks from the saved script and the approved recommendation; stored verification flags are not trusted. The length estimate is not a measured audio runtime. `format` and `retention` script guidance remain excluded until their output can be verified independently. Packaging attribution continues to require an explicitly selected non-control variant. A positive or negative observational signal requires at least two distinct productions, at least 2,000 combined impressions, and two measured baseline deltas. The median delta must be at least +5% or at most -5%; otherwise the result remains inconclusive. Feedback whose latest linked measurement is older than 90 days is marked stale and cannot retain a positive/negative status. This feedback is descriptive only and never auto-approves, rejects, or causally validates a recommendation.

A fresh `negative_signal` for the same recommendation and surface blocks that recommendation from future script or packaging reuse. This is a reuse safeguard only: the approval record remains unchanged for operator review, and the recommendation is not deleted or automatically rejected. Stale, unknown, inconclusive, insufficient, or not-observed feedback does not create a negative block; the recommendation must still pass its independent evidence-freshness and approval checks. A positive observational signal does not grant approval or bypass those checks. When analytics feedback is unavailable to the generation stage, the system retains the existing approval and evidence gates rather than inventing a negative result. If the analytics feedback summary cannot be loaded during generation, the app continues production without reusing approved learnings for that run; it does not fall back to raw approval rows and bypass the negative-feedback check.
