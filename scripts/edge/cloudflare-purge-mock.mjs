import { createServer } from 'node:http'

const token = process.env.CF_API_TOKEN ?? 'edge-test-token'
const purgeRequests = []
const server = createServer(async (request, response) => {
  if (request.method === 'GET' && request.url === '/health') {
    response.writeHead(204).end()
    return
  }
  if (request.method === 'GET' && request.url === '/requests') {
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(purgeRequests))
    return
  }
  if (request.method === 'POST' && request.url === '/reset') {
    purgeRequests.length = 0
    response.writeHead(204).end()
    return
  }
  if (request.method !== 'POST' || !/^\/client\/v4\/zones\/[0-9a-f]{32}\/purge_cache$/iu.test(request.url ?? '')) {
    response.writeHead(404).end()
    return
  }
  if (request.headers.authorization !== `Bearer ${token}`) {
    response.writeHead(403, { 'content-type': 'application/json' }).end(JSON.stringify({ success: false }))
    return
  }

  let body = ''
  for await (const chunk of request) body += chunk
  let payload
  try {
    payload = JSON.parse(body)
  } catch {
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ success: false }))
    return
  }
  const keys = Object.keys(payload)
  const validShape = keys.length === 1 && ['files', 'prefixes'].includes(keys[0])
    && Array.isArray(payload[keys[0]]) && payload[keys[0]].length > 0
    && payload[keys[0]].length <= 100 && payload[keys[0]].every((entry) => typeof entry === 'string')
  if (!validShape) {
    response.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ success: false }))
    return
  }
  purgeRequests.push({ url: request.url, payload })
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
    success: true,
    result: { id: `local-purge-${purgeRequests.length}` },
  }))
})

server.listen(Number(process.env.PORT ?? 8787), '0.0.0.0')
