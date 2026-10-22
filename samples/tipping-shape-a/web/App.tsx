import { useEffect, useState } from 'react'
import { fetchConfig, type AppConfig } from './config'
import { Creator } from './pages/Creator'
import { Tipper } from './pages/Tipper'

type Route = 'tipper' | 'creator' | 'not-found'

/** Two pages, routed on the path alone: `/` tips, `/creator` collects. */
function routeOf(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '') || '/'
  return path === '/' ? 'tipper' : path === '/creator' ? 'creator' : 'not-found'
}

function NetworkBadge({ config, error }: { config?: AppConfig; error?: string }) {
  if (error) return <span className="badge badge-error">relay unavailable</span>
  if (!config) return <span className="badge">…</span>
  return <span className={`badge badge-${config.network}`}>{config.network}</span>
}

export function App({ pathname = window.location.pathname }: { pathname?: string }) {
  const [config, setConfig] = useState<AppConfig>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    fetchConfig().then(setConfig, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const route = routeOf(pathname)
  return (
    <>
      <header>
        <h1>BSV tipping demo</h1>
        <NetworkBadge config={config} error={error} />
        <nav>
          <a href="/">Tip</a> · <a href="/creator">Creator</a>
        </nav>
      </header>
      <main>
        {error && <p role="alert">{error}</p>}
        {config && route === 'tipper' && <Tipper config={config} />}
        {config && route === 'creator' && <Creator config={config} />}
        {route === 'not-found' && <p>Page not found. <a href="/">Back to tipping</a></p>}
      </main>
    </>
  )
}
