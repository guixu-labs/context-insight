import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { test } from 'node:test'
import { LineageClient } from '../dist/client.js'

test('client consumes a real HTTP service with scoped authorization', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.authorization, 'Bearer fixture-token')
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ component: 'agentlineage-core' }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const client = new LineageClient('http://127.0.0.1:' + server.address().port, 'fixture-token')
    const result = await client.request('/v1/capabilities')
    assert.equal(result.component, 'agentlineage-core')
  } finally { await new Promise(resolve => server.close(resolve)) }
})
