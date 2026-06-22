import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  fallback?: ReactNode
}

interface State {
  hasError: boolean
}

/// Catches render errors from children (e.g. ECharts crashing on edge-case
/// data) and shows a fallback card instead of white-screening the whole app.
/// Each lazy-loaded chart should be wrapped in its own ErrorBoundary so a
/// failure in one chart doesn't take down the others.
export class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { hasError: false }
  }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('ErrorBoundary caught a render error:', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        this.props.fallback ?? (
          <div className="state-card error-card" role="alert">
            图表渲染失败，请刷新页面重试。
          </div>
        )
      )
    }
    return this.props.children
  }
}
