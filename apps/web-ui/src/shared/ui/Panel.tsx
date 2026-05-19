import type { ReactNode } from 'react'

export function Panel(props: {
  title?: string
  eyebrow?: string
  side?: ReactNode
  className?: string
  children: ReactNode
}) {
  return (
    <section className={`panel page-panel${props.className ? ` ${props.className}` : ''}`}>
      {props.title || props.eyebrow || props.side ? (
        <div className="panel-header">
          <div>
            {props.eyebrow ? <p className="section-kicker">{props.eyebrow}</p> : null}
            {props.title ? <h2>{props.title}</h2> : null}
          </div>
          {props.side}
        </div>
      ) : null}
      {props.children}
    </section>
  )
}
