import type { ReactNode } from 'react'

export function Toolbar(props: { className?: string; children: ReactNode }) {
  return (
    <div className={`ui-toolbar${props.className ? ` ${props.className}` : ''}`}>
      {props.children}
    </div>
  )
}
