export function RefreshBadge(props: { active: boolean; label?: string }) {
  return (
    <span
      className={`refresh-badge ${props.active ? 'is-active' : ''}`}
      aria-live="polite"
      aria-label={props.active ? (props.label ?? '正在刷新') : undefined}
    >
      {props.active ? (props.label ?? '刷新中') : null}
    </span>
  )
}
