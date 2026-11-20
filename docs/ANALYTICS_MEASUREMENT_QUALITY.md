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

The learning scheduler records separate cumulative windows from publication:

- `24h`: the first 24 hours after publication
- `7d`: the first 7 days after publication
- `28d`: the first 28 days after publication

A window is due only after its full elapsed duration. An incomplete 28-day period is not labeled as a 28-day result. Each window is stored independently for the same video.

Channel-wide recommendations and cohort insights use the exact `7d` window as their comparable baseline. A video that has only a 24-hour or 28-day snapshot is not substituted into the 7-day cohort. This avoids comparing early launch performance with longer cumulative totals. The 24-hour and 28-day snapshots remain available for their own reporting and longitudinal analysis; they do not silently influence the fixed 7-day recommendation cohort.

All these windows are cumulative since publication, not rolling periods. Comparisons remain observational and do not establish that a format, title, or script choice caused the measured outcome.
