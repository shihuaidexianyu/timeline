type ChartLazyFallbackVariant = 'trend' | 'day' | 'donut' | 'compact-donut'

export function ChartLazyFallback(props: { variant: ChartLazyFallbackVariant }) {
  if (props.variant === 'donut') {
    return (
      <div className="donut-card donut-card-skeleton" role="status" aria-label="图表加载中">
        <div className="donut-visual-skeleton">
          <span className="skeleton-block donut-ring-skeleton" />
          <span className="skeleton-block skeleton-inline donut-total-skeleton donut-total-skeleton-main" />
          <span className="skeleton-block skeleton-inline donut-caption-skeleton donut-caption-skeleton-main" />
        </div>
        <div className="ranking-list ranking-list-skeleton">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={`ranking-skeleton-${index}`} className="ranking-row ranking-row-skeleton">
              <span className="skeleton-block skeleton-inline skeleton-ranking-name" />
              <span className="skeleton-block skeleton-inline skeleton-ranking-value" />
              <span className="skeleton-block skeleton-inline skeleton-ranking-percent" />
            </div>
          ))}
        </div>
      </div>
    )
  }

  if (props.variant === 'compact-donut') {
    return (
      <div className="compact-donut-skeleton" role="status" aria-label="图表加载中">
        <div className="donut-visual-skeleton">
          <span className="skeleton-block donut-ring-skeleton donut-ring-skeleton-compact" />
          <span className="skeleton-block skeleton-inline donut-total-skeleton donut-total-skeleton-compact" />
          <span className="skeleton-block skeleton-inline donut-caption-skeleton donut-caption-skeleton-compact" />
          <span className="skeleton-block skeleton-inline donut-footer-skeleton" />
        </div>
      </div>
    )
  }

  const className =
    props.variant === 'day'
      ? 'day-trend day-trend-skeleton'
      : 'app-trend-chart app-trend-chart-skeleton'

  return (
    <div className={className} role="status" aria-label="图表加载中">
      <span className="skeleton-block app-trend-skeleton-line is-top" />
      <span className="skeleton-block app-trend-skeleton-line is-mid" />
      <span className="skeleton-block app-trend-skeleton-line is-bottom" />
    </div>
  )
}
