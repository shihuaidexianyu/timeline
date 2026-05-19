export function SkeletonBlock(props: { className?: string }) {
  return (
    <span
      className={`skeleton-block${props.className ? ` ${props.className}` : ''}`}
      aria-hidden="true"
    />
  )
}
