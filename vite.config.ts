import react from '@vitejs/plugin-react'
import { getRequestListener } from '@hono/node-server'
import { defineConfig, loadEnv, type Plugin, type ViteDevServer } from 'vite'

// The Env of server/env.ts.
interface DevEnv {
  RADIUS_CREDENTIAL_KEY: string
  CAPMONSTER_API_KEY: string
  startSlingSignIn(job: unknown): Promise<void>
}

// In dev, the server (server/app.ts) runs inside the Vite dev server, on the
// same origin as the React app, as CloudFront arranges in production. It's
// loaded through Vite, so edits to server/ apply on the next request.
// Settings and secrets come from .env.local (see .env.example).
function devServer(): Plugin {
  return {
    name: 'mathnasium-dev-server',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      Object.assign(process.env, { ...loadEnv('development', process.cwd(), ''), ...process.env })

      // Typed loosely here: server/ is type checked in its own project (tsconfig.server.json).
      const load = async () => ({
        app: (await server.ssrLoadModule('/server/app.ts')) as {
          SERVER_PATHS: string[]
          handleRequest(request: Request, env: DevEnv): Promise<Response>
        },
        jobs: (await server.ssrLoadModule('/server/slingSignIn.ts')) as {
          runSlingSignIn(env: DevEnv, job: unknown): Promise<void>
        },
      })

      const listener = getRequestListener(async (request) => {
        const { app, jobs } = await load()
        const env: DevEnv = {
          RADIUS_CREDENTIAL_KEY: process.env.RADIUS_CREDENTIAL_KEY ?? '',
          CAPMONSTER_API_KEY: process.env.CAPMONSTER_API_KEY ?? '',
          // No background Lambda in dev: run it here, after the response.
          async startSlingSignIn(job) {
            void jobs.runSlingSignIn(env, job).catch((err) => console.error('Sling sign-in failed', err))
          },
        }
        return app.handleRequest(request, env)
      })

      server.middlewares.use(async (req, res, next) => {
        try {
          const path = req.url ?? '/'
          const { app } = await load()
          if (!app.SERVER_PATHS.some((p) => path.startsWith(p))) return next()
          await listener(req, res)
        } catch (err) {
          next(err)
        }
      })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), devServer()],
  build: { outDir: 'dist/client' },
})
