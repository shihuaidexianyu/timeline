import './shared/styles/tokens.css'
import './shared/styles/primitives.css'
import './App.css'
import { AppController } from './app/AppController'
import { AppProviders } from './app/AppProviders'

export default function App() {
  return (
    <AppProviders>
      <AppController />
    </AppProviders>
  )
}
