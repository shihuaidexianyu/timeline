import type { ComponentType } from 'react'
import ReactEChartsCoreImport from 'echarts-for-react/lib/core'
import * as echarts from 'echarts/core'
import { LineChart, PieChart } from 'echarts/charts'
import {
  GraphicComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
import { SVGRenderer } from 'echarts/renderers'

echarts.use([
  LineChart,
  PieChart,
  GraphicComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  SVGRenderer,
])

export const ReactEChartsCore = (
  typeof ReactEChartsCoreImport === 'object' &&
  ReactEChartsCoreImport !== null &&
  'default' in ReactEChartsCoreImport
    ? (ReactEChartsCoreImport as { default: unknown }).default
    : ReactEChartsCoreImport
) as ComponentType<Record<string, unknown>>

export { echarts }
