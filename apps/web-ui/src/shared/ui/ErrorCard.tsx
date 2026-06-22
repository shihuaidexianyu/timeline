/// A reusable error card with a retry button. Used by pages when a query
/// fails and there is no cached data to fall back to.
export function ErrorCard({
  message,
  onRetry,
  retrying = false,
}: {
  message: string
  onRetry?: () => void
  retrying?: boolean
}) {
  return (
    <div className="state-card error-card" role="alert">
      <span>{message}</span>
      {onRetry ? (
        <button
          type="button"
          className="ui-button ui-button-secondary error-retry-btn"
          onClick={onRetry}
          disabled={retrying}
        >
          {retrying ? '重试中…' : '重试'}
        </button>
      ) : null}
    </div>
  )
}
