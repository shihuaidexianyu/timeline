export type SegmentOption<T extends string> = {
  key: T
  label: string
}

export function SegmentedControl<T extends string>(props: {
  label: string
  value: T
  options: Array<SegmentOption<T>>
  disabled?: boolean
  onChange: (value: T) => void
}) {
  return (
    <div className="ui-segmented" role="group" aria-label={props.label}>
      {props.options.map((option) => (
        <button
          key={option.key}
          type="button"
          className={props.value === option.key ? 'is-active' : undefined}
          aria-pressed={props.value === option.key}
          disabled={props.disabled}
          onClick={() => {
            props.onChange(option.key)
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
