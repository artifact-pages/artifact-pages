// Local research UI. Search-specific code and content are loaded only on submit.
const form = document.querySelector('form')
const input = document.querySelector('input')
const select = document.querySelector('select')
const output = document.querySelector('output')
const results = document.querySelector('ol')
const more = document.querySelector('#more')
const metrics = document.querySelector('#metrics')
const roots = new Map(), leaves = new Map()
let epoch = 0, visible = 20, current, codec
window.fulltextLab = { state: 'idle', ids: [], observedHeapMax: 0 }
input.addEventListener('keydown', (event) => { if (event.key === 'Enter' && event.isComposing) event.preventDefault() })
setInterval(() => {
  if (performance.memory) window.fulltextLab.observedHeapMax = Math.max(window.fulltextLab.observedHeapMax, performance.memory.usedJSHeapSize)
}, 20)

async function unpack(url) {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`取得に失敗しました (${response.status})`)
  return new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer())
}
function cached(map, key, fn) {
  if (!map.has(key)) map.set(key, fn().catch((error) => { map.delete(key); throw error }))
  return map.get(key)
}
function render() {
  results.replaceChildren()
  for (const id of current.ids.slice(0, visible)) {
    const sourcePath = current.root.metadata.documentPaths[id]
    const item = document.createElement('li'), link = document.createElement('a'), details = document.createElement('small')
    const route = `/${current.site}/${sourcePath.split('/').map(encodeURIComponent).join('/')}`
    link.href = route; link.textContent = sourcePath.split('/').at(-1)
    details.textContent = route
    item.append(link, details); results.append(item)
  }
  more.hidden = visible >= current.ids.length
}
more.onclick = () => { visible += 20; render() }
form.onsubmit = async (event) => {
  event.preventDefault()
  if (event.isComposing) return
  const committed = ++epoch, query = input.value, site = select.value, started = performance.now()
  window.fulltextLab = { state: 'loading', query, site, ids: [], observedHeapMax: performance.memory?.usedJSHeapSize ?? 0 }
  if (!query.trim()) {
    results.replaceChildren(); more.hidden = true; output.textContent = '検索文字列を入力してください。'
    window.fulltextLab.state = 'ready'; return
  }
  output.textContent = `「${query}」を検索中…`
  try {
    codec ??= await import('/fulltext-lab/codec.js')
    const root = await cached(roots, site, async () => codec.decodeRoot(await unpack(`/_indexes/${site}/search/root.gz`)))
    const plan = codec.stablePlan(root.lexicon, query, root.metadata.parts.length)
    const bundles = new Map()
    await Promise.all(plan.needed.map(async (shard) => {
      const url = root.metadata.parts[shard].url
      bundles.set(shard, await cached(leaves, url, async () => codec.decodeBundle(await unpack(url))))
    }))
    const ids = codec.executeStable(root.lexicon, plan, bundles)
    if (committed !== epoch) return
    current = { site, root, ids }; visible = 20; render()
    output.textContent = `「${query}」: ${ids.length.toLocaleString()}件`
    const computeMs = performance.now() - started
    metrics.textContent = `${root.metadata.documents.toLocaleString()}ページから検索 · ${plan.needed.length}個の検索ファイル · ${computeMs.toFixed(1)} ms`
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    if (committed !== epoch) return
    window.fulltextLab = { ...window.fulltextLab, state: 'ready', ids, computeMs, inputToPaintMs: performance.now() - started }
  } catch (error) {
    if (committed !== epoch) return
    output.textContent = error.message
    window.fulltextLab = { ...window.fulltextLab, state: 'error', error: String(error) }
  }
}
