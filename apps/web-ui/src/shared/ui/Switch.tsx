import type { ButtonHTMLAttributes } from 'react'

export function Switch({
  checked,
  children,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { checked: boolean }) {
  return (
    <button
      {...props}
      type={props.type ?? 'button'}
      className={`ui-switch ${checked ? 'is-active' : ''}${className ? ` ${className}` : ''}`}
      aria-pressed={checked}
    >
      <span className="ui-switch-track" aria-hidden="true">
        <span className="ui-switch-thumb" />
      </span>
      {children ? <span>{children}</span> : null}
    </button>
  )
}
