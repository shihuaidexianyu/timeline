import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { type ReactNode, useState } from 'react'

export function AppProviders(props: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            gcTime: 10 * 60 * 1000,
            refetchOnWindowFocus: false,
            retry: 1,
            staleTime: 15 * 1000,
          },
        },
      }),
  )

  return (
    <QueryClientProvider client={queryClient}>{props.children}</QueryClientProvider>
  )
}
