// Research format, not a production contract. Browser-compatible codec.
export const normalize = (text) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
const encoder = new TextEncoder()
const decoder = new TextDecoder()
class Writer {
  values = []
  uint(value) {
    do { const digit = value % 128; value = Math.floor(value / 128); this.values.push(digit + (value ? 128 : 0)) } while (value)
  }
  bytes(values) { for (const value of values) this.values.push(value) }
  finish() { return Uint8Array.from(this.values) }
}
class Reader {
  offset = 0
  constructor(bytes) { this.bytes = bytes }
  uint() {
    let value = 0, scale = 1, digit
    do {
      if (this.offset >= this.bytes.length || scale > 2 ** 49) throw new Error('Invalid varint')
      digit = this.bytes[this.offset++]; value += (digit & 127) * scale; scale *= 128
    } while (digit & 128)
    return value
  }
  take(length) {
    if (this.offset + length > this.bytes.length) throw new Error('Truncated payload')
    const result = this.bytes.subarray(this.offset, this.offset + length); this.offset += length; return result
  }
}
function delta(values) {
  const writer = new Writer()
  let previous = 0
  for (const value of values) { writer.uint(value - previous); previous = value }
  return writer.finish()
}
export function encodePosting(values, documents, adaptive = true, eliasFano = false) {
  const wrap = (mode, payload) => { const w = new Writer(); w.uint(mode); w.uint(values.length); w.bytes(payload); return w.finish() }
  const choices = [wrap(0, delta(values))]
  if (!adaptive) return choices[0]
  const bitmap = new Uint8Array(Math.ceil(documents / 8))
  for (const value of values) bitmap[value >> 3] |= 1 << (value & 7)
  choices.push(wrap(1, bitmap))
  const runs = []
  for (const value of values) {
    const last = runs.at(-1)
    if (last && last[0] + last[1] === value) last[1]++
    else runs.push([value, 1])
  }
  const runWriter = new Writer(); runWriter.uint(runs.length)
  let previousEnd = 0
  for (const [start, length] of runs) { runWriter.uint(start - previousEnd); runWriter.uint(length); previousEnd = start + length }
  choices.push(wrap(2, runWriter.finish()))
  if (values.length > documents / 2) {
    const complement = []; let p = 0
    for (let i = 0; i < documents; i++) { if (values[p] === i) p++; else complement.push(i) }
    choices.push(wrap(3, delta(complement)))
  }
  if (values.length === documents) choices.push(wrap(4, new Uint8Array()))
  if (eliasFano && values.length) {
    const universe = values.at(-1) + 1
    const lowBits = Math.max(0, Math.floor(Math.log2(universe / values.length)))
    const low = new Uint8Array(Math.ceil(values.length * lowBits / 8))
    const high = new Uint8Array(Math.ceil((Math.floor(values.at(-1) / 2 ** lowBits) + values.length + 1) / 8))
    values.forEach((value, i) => {
      const lower = value % 2 ** lowBits
      for (let bit = 0; bit < lowBits; bit++) if (Math.floor(lower / 2 ** bit) % 2) {
        const position = i * lowBits + bit; low[position >> 3] |= 1 << (position & 7)
      }
      const position = Math.floor(value / 2 ** lowBits) + i
      high[position >> 3] |= 1 << (position & 7)
    })
    const payload = new Writer(); payload.uint(lowBits); payload.uint(high.length); payload.bytes(low); payload.bytes(high)
    choices.push(wrap(5, payload.finish()))
  }
  choices.sort((a, b) => a.length - b.length)
  return choices[0]
}
export function decodePosting(bytes, documents) {
  const reader = new Reader(bytes), mode = reader.uint(), count = reader.uint(), values = []
  if (mode === 0 || mode === 3) {
    let previous = 0
    for (let i = 0; i < (mode === 0 ? count : documents - count); i++) { previous += reader.uint(); values.push(previous) }
    if (mode === 0) return values
    const present = []; let p = 0
    for (let i = 0; i < documents; i++) { if (values[p] === i) p++; else present.push(i) }
    return present
  }
  if (mode === 1) {
    const bitmap = reader.take(Math.ceil(documents / 8))
    for (let i = 0; i < documents; i++) if (bitmap[i >> 3] & (1 << (i & 7))) values.push(i)
  } else if (mode === 2) {
    const runs = reader.uint(); let previousEnd = 0
    for (let r = 0; r < runs; r++) {
      const start = previousEnd + reader.uint(), length = reader.uint()
      for (let i = start; i < start + length; i++) values.push(i)
      previousEnd = start + length
    }
  } else if (mode === 4) {
    for (let i = 0; i < documents; i++) values.push(i)
  } else if (mode === 5) {
    const lowBits = reader.uint(), highLength = reader.uint()
    const low = reader.take(Math.ceil(count * lowBits / 8)), high = reader.take(highLength)
    for (let position = 0; position < high.length * 8 && values.length < count; position++) {
      if (!(high[position >> 3] & (1 << (position & 7)))) continue
      let lower = 0
      const ordinal = values.length
      for (let bit = 0; bit < lowBits; bit++) {
        const p = ordinal * lowBits + bit
        if (low[p >> 3] & (1 << (p & 7))) lower += 2 ** bit
      }
      values.push((position - ordinal) * 2 ** lowBits + lower)
    }
  } else throw new Error('Invalid posting mode')
  if (values.length !== count) throw new Error('Wrong cardinality')
  return values
}
export function build(records, { kind = 'tokens', adaptive = true, intern = true, eliasFano = false } = {}) {
  const postings = new Map()
  records.forEach(({ text }, document) => {
    const normalized = normalize(text)
    const chars = kind === 'bigrams' ? Array.from(normalized) : []
    const tokens = kind === 'tokens' ? normalized.split(' ').filter(Boolean) : chars.slice(0, -1).map((ch, i) => ch + chars[i + 1])
    for (const token of new Set(tokens)) {
      if (!postings.has(token)) postings.set(token, [])
      postings.get(token).push(document)
    }
  })
  const tokens = [...postings.keys()].sort()
  const lists = [], listIDs = [], interned = new Map(), modes = {}
  for (const token of tokens) {
    const packed = encodePosting(postings.get(token), records.length, adaptive, eliasFano)
    const key = intern ? packed.join(',') : undefined
    let id = intern ? interned.get(key) : undefined
    if (id === undefined) {
      id = lists.length; lists.push(packed)
      if (intern) interned.set(key, id)
      modes[packed[0]] = (modes[packed[0]] ?? 0) + 1
    }
    listIDs.push(id)
  }
  return { kind, documents: records.length, tokens, listIDs, lists, modes }
}
export function encodeLexicon(index) {
  const writer = new Writer()
  writer.uint(index.documents); writer.uint(index.tokens.length)
  let previous = new Uint8Array()
  index.tokens.forEach((token, i) => {
    const bytes = encoder.encode(token); let prefix = 0
    while (prefix < Math.min(previous.length, bytes.length) && previous[prefix] === bytes[prefix]) prefix++
    writer.uint(prefix); writer.uint(bytes.length - prefix); writer.bytes(bytes.subarray(prefix)); writer.uint(index.listIDs[i])
    previous = bytes
  })
  return writer.finish()
}
export function decodeLexicon(bytes) {
  const reader = new Reader(bytes), documents = reader.uint(), count = reader.uint(), tokens = [], listIDs = []
  let previous = new Uint8Array()
  for (let i = 0; i < count; i++) {
    const prefix = reader.uint(), length = reader.uint(), value = new Uint8Array(prefix + length)
    value.set(previous.subarray(0, prefix)); value.set(reader.take(length), prefix)
    tokens.push(decoder.decode(value)); listIDs.push(reader.uint()); previous = value
  }
  return { documents, tokens, listIDs }
}
export function encodeLists(index, shard = 0, shards = 1) {
  const writer = new Writer()
  const ids = index.lists.map((_, i) => i).filter((i) => i % shards === shard)
  writer.uint(ids.length)
  for (const id of ids) { writer.uint(id); writer.uint(index.lists[id].length); writer.bytes(index.lists[id]) }
  return writer.finish()
}
export function decodeLists(bytes) {
  const reader = new Reader(bytes), count = reader.uint(), lists = new Map()
  for (let i = 0; i < count; i++) { const id = reader.uint(); lists.set(id, reader.take(reader.uint())) }
  return lists
}
export function encodeBundle(index) {
  const lex = encodeLexicon(index), writer = new Writer()
  writer.uint(lex.length); writer.bytes(lex); writer.bytes(encodeLists(index))
  return writer.finish()
}
export function decodeBundle(bytes) {
  const reader = new Reader(bytes), lexicon = decodeLexicon(reader.take(reader.uint()))
  return { lexicon, lists: decodeLists(bytes.subarray(reader.offset)) }
}
export function encodeRoot(metadata, index) {
  const writer = new Writer(), json = encoder.encode(JSON.stringify(metadata))
  writer.uint(json.length); writer.bytes(json); writer.bytes(encodeLexicon(index))
  return writer.finish()
}
export function decodeRoot(bytes) {
  const reader = new Reader(bytes), metadata = JSON.parse(decoder.decode(reader.take(reader.uint())))
  return { metadata, lexicon: decodeLexicon(bytes.subarray(reader.offset)) }
}
// Stable token routing; not cryptographic. Integrity uses the manifest's SHA-256.
export function tokenShard(token, shards) {
  let hash = 2166136261
  for (const byte of encoder.encode(token)) hash = Math.imul(hash ^ byte, 16777619) >>> 0
  return hash % shards
}
export function buildStable(index, shards, inlineLimit = 1) {
  const leaves = Array.from({ length: shards }, () => ({ documents: index.documents, tokens: [], listIDs: [], lists: [], interned: new Map() }))
  const inline = []
  index.tokens.forEach((token, i) => {
    const packed = index.lists[index.listIDs[i]], reader = new Reader(packed)
    reader.uint(); const count = reader.uint()
    if (count <= inlineLimit) {
      // This prototype inlines singletons; the limit parameter is reserved for experiments.
      if (count !== 1) throw new Error('Only singleton inline supported')
      inline.push(decodePosting(packed, index.documents)[0] + 1)
    } else {
      inline.push(0)
      const leaf = leaves[tokenShard(token, shards)], key = packed.join(',')
      let id = leaf.interned.get(key)
      if (id === undefined) { id = leaf.lists.length; leaf.lists.push(packed); leaf.interned.set(key, id) }
      leaf.tokens.push(token); leaf.listIDs.push(id)
    }
  })
  return { root: { documents: index.documents, tokens: index.tokens, listIDs: inline }, leaves }
}
export function stablePlan(root, query, shards) {
  const terms = normalize(query).split(' ').filter(Boolean)
  const groups = terms.map((term) => {
    const inline = new Set(), external = new Set()
    root.tokens.forEach((token, i) => {
      if (!token.includes(term)) return
      if (root.listIDs[i]) inline.add(root.listIDs[i] - 1)
      else external.add(tokenShard(token, shards))
    })
    return { term, inline: [...inline], external: [...external] }
  })
  const needed = !groups.length || groups.some((group) => !group.inline.length && !group.external.length) ? [] : [...new Set(groups.flatMap((group) => group.external))]
  return { groups, needed }
}
export function executeStable(root, plan, bundles) {
  if (!plan.groups.length || plan.groups.some((group) => !group.inline.length && !group.external.length)) return []
  const sets = plan.groups.map((group) => {
    const docs = new Set(group.inline)
    for (const shard of group.external) {
      const { lexicon, lists } = bundles.get(shard)
      const ids = queryPlan(lexicon, group.term)[0]
      for (const id of ids) for (const doc of decodePosting(lists.get(id), root.documents)) docs.add(doc)
    }
    return docs
  }).sort((a, b) => a.size - b.size)
  return [...sets[0]].filter((doc) => sets.every((set) => set.has(doc))).sort((a, b) => a - b)
}
export function queryPlan(lexicon, query) {
  const terms = normalize(query).split(' ').filter(Boolean)
  return terms.map((term) => {
    const ids = new Set()
    lexicon.tokens.forEach((token, i) => { if (token.includes(term)) ids.add(lexicon.listIDs[i]) })
    return [...ids]
  })
}
export function execute(lexicon, plan, lists) {
  if (!plan.length || plan.some((ids) => !ids.length)) return []
  const sets = plan.map((ids) => {
    const union = new Set()
    for (const id of ids) for (const doc of decodePosting(lists.get(id), lexicon.documents)) union.add(doc)
    return union
  }).sort((a, b) => a.size - b.size)
  return [...sets[0]].filter((doc) => sets.every((set) => set.has(doc))).sort((a, b) => a - b)
}
