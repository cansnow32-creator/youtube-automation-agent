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
