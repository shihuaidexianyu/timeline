import type { InputHTMLAttributes } from 'react'

export function TextField({
  label,
  className,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className={`ui-field${className ? ` ${className}` : ''}`}>
      <span className="ui-field-label">{label}</span>
      <input {...props} className="ui-input" />
    </label>
  )
}
