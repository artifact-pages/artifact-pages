import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'

const storageRoot = fileURLToPath(new URL('./fixtures/storage/', import.meta.url))

function escapeHtml(value: string) {
  return value.replace(
    /[&<>\'\"]/g,
    (character) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;',
      })[character] ?? character,
  )
}

function contentType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase()

  return (
    {
      '.css': 'text/css; charset=utf-8',
      '.html': 'text/html; charset=utf-8',
      '.json': 'application/json; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.svg': 'image/svg+xml',
    }[extension] ?? 'application/octet-stream'
  )
}

function localStorageProjection(): Plugin {
  return {
    name: 'local-storage-projection',
    configureServer(server) {
      server.middlewares.use(async (request, response, next) => {
        const requestUrl = new URL(request.url ?? '/', 'http://localhost')
        const match = requestUrl.pathname.match(/^\/(\_indexes|\_artifacts)(\/.*)?$/)

        if (!match) {
          next()
          return
        }

        const area = match[1]
        const areaRoot = path.join(storageRoot, area)
        const relativePath = decodeURIComponent(match[2] ?? '').replace(/^\/+/, '')
        const filePath = path.resolve(areaRoot, relativePath)

        if (filePath !== areaRoot && !filePath.startsWith(`${areaRoot}${path.sep}`)) {
          next()
          return
        }

        if (requestUrl.pathname === `/${area}`) {
          response.statusCode = 301
          response.setHeader('Location', `/${area}/`)
          response.end()
          return
        }

        try {
          const stats = await fs.stat(filePath)

          if (stats.isDirectory()) {
            if (area !== '_indexes' || !requestUrl.pathname.endsWith('/')) {
              next()
              return
            }

            const entries = await fs.readdir(filePath, { withFileTypes: true })
            const links = entries
              .filter((entry) => entry.isDirectory())
              .sort((left, right) => left.name.localeCompare(right.name))
              .map(
                (entry) =>
                  `<li><a href="${encodeURIComponent(entry.name)}/">${escapeHtml(entry.name)}/</a></li>`,
              )
              .join('')
            const body = `<!doctype html><html><body><ul>${links}</ul></body></html>`

            response.statusCode = 200
            response.setHeader('Content-Type', 'text/html; charset=utf-8')
            response.end(body)
            return
          }

          response.statusCode = 200
          response.setHeader('Content-Type', contentType(filePath))
          response.end(await fs.readFile(filePath))
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            next()
            return
          }

          next(error as Error)
        }
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), localStorageProjection()],
})
