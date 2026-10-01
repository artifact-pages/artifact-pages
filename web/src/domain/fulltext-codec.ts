// Static full-text format v1. Kept behind a dynamic import by the data client.
export const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim()
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

class Reader {
  private offset = 0
  constructor(private bytes: Uint8Array) {}
  get remaining() { return this.bytes.length - this.offset }
  uint() {
    let value = 0, scale = 1
    for (let i = 0; i < 8; i++) {
      const digit = this.take(1)[0]
      value += (digit & 127) * scale
      if (!Number.isSafeInteger(value)) throw new Error('Invalid integer')
      if (!(digit & 128)) return value
      scale *= 128
    }
    throw new Error('Invalid varint')
  }
  take(length: number) {
    if (!Number.isSafeInteger(length) || length < 0 || length > this.remaining) throw new Error('Truncated search data')
    const value = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }
  count(max: number) { const n = this.uint(); if (n > max) throw new Error('Invalid count'); return n }
  front(previous: Uint8Array) {
    const prefix = this.count(previous.length), suffix = this.take(this.uint())
    const bytes = new Uint8Array(prefix + suffix.length)
    bytes.set(previous.subarray(0, prefix)); bytes.set(suffix, prefix)
    return bytes
  }
  end() { if (this.remaining) throw new Error('Trailing search data') }
}

type Lexicon = { documents: number; tokens: string[]; ids: number[] }
export type Root = Lexicon & { paths: string[] }
export type Leaf = Lexicon & { lists: Uint8Array[] }
export type Plan = { groups: { term: string; inline: number[]; external: number[] }[]; needed: number[] }

function readLexicon(reader: Reader, root: boolean): Lexicon {
  const documents = reader.uint(), count = reader.count(Math.floor(reader.remaining / 3))
  const tokens: string[] = [], ids: number[] = []
  let previous: Uint8Array = new Uint8Array()
  for (let i = 0; i < count; i++) {
    previous = reader.front(previous)
    const token = decoder.decode(previous), id = reader.uint()
    if (!token || (root && id > documents)) throw new Error('Invalid lexicon')
    tokens.push(token); ids.push(id)
  }
  return { documents, tokens, ids }
}

export function decodeRoot(bytes: Uint8Array): Root {
  const reader = new Reader(bytes)
  if (decoder.decode(reader.take(6)) !== 'GAPSR1') throw new Error('Unsupported search root')
  const lexicon = readLexicon(reader, true), paths: string[] = []
  if (lexicon.documents > reader.remaining / 2) throw new Error('Invalid path count')
  let previous: Uint8Array = new Uint8Array()
  for (let i = 0; i < lexicon.documents; i++) {
    previous = reader.front(previous)
    const path = decoder.decode(previous)
    if (!path || path.startsWith('/') || path.split('/').some((p) => !p || p === '.' || p === '..')) throw new Error('Invalid search path')
    paths.push(path)
  }
  reader.end()
  return { ...lexicon, paths }
}

export function decodeLeaf(bytes: Uint8Array, documents: number): Leaf {
  const reader = new Reader(bytes)
  if (decoder.decode(reader.take(6)) !== 'GAPSL1') throw new Error('Unsupported search leaf')
  const lexicon = readLexicon(reader, false)
  if (lexicon.documents !== documents) throw new Error('Search generation mismatch')
  const count = reader.count(reader.remaining), lists: Uint8Array[] = []
  for (let i = 0; i < count; i++) lists.push(reader.take(reader.uint()))
  if (lexicon.ids.some((id) => id >= count)) throw new Error('Invalid posting reference')
  reader.end()
  return { ...lexicon, lists }
}

export function decodePosting(bytes: Uint8Array, documents: number): number[] {
  const reader = new Reader(bytes), mode = reader.uint(), count = reader.count(documents), values: number[] = []
  if (mode === 0 || mode === 3) {
    let previous = 0
    for (let i = 0; i < (mode === 0 ? count : documents - count); i++) {
      previous += reader.uint()
      if (previous >= documents || (i > 0 && previous <= values[i - 1])) throw new Error('Invalid posting delta')
      values.push(previous)
    }
    if (mode === 3) {
      const present: number[] = []; let p = 0
      for (let i = 0; i < documents; i++) { if (values[p] === i) p++; else present.push(i) }
      reader.end(); return present
    }
  } else if (mode === 1) {
    const bitmap = reader.take(Math.ceil(documents / 8))
    for (let i = 0; i < documents; i++) if (bitmap[i >> 3] & (1 << (i & 7))) values.push(i)
  } else if (mode === 2) {
    const runs = reader.count(count); let end = 0
    for (let r = 0; r < runs; r++) {
      const start = end + reader.uint(), length = reader.uint()
      if (!length || start + length > documents || values.length + length > count) throw new Error('Invalid posting run')
      for (let i = start; i < start + length; i++) values.push(i)
      end = start + length
    }
  } else if (mode === 4 && count === documents) {
    for (let i = 0; i < documents; i++) values.push(i)
  } else throw new Error('Invalid posting mode')
  if (values.length !== count) throw new Error('Invalid posting count')
  reader.end(); return values
}

export function tokenShard(token: string, shards: number) {
  let hash = 2166136261
  for (const byte of encoder.encode(token)) hash = Math.imul(hash ^ byte, 16777619) >>> 0
  return hash % shards
}

export function plan(root: Root, query: string, shards: number): Plan {
  const groups = [...new Set(normalize(query).split(' ').filter(Boolean))].map((term) => {
    const inline = new Set<number>(), external = new Set<number>()
    root.tokens.forEach((token, i) => {
      if (!token.includes(term)) return
      if (root.ids[i]) inline.add(root.ids[i] - 1)
      else external.add(tokenShard(token, shards))
    })
    return { term, inline: [...inline], external: [...external] }
  })
  const impossible = !groups.length || groups.some((g) => !g.inline.length && !g.external.length)
  return { groups, needed: impossible ? [] : [...new Set(groups.flatMap((g) => g.external))] }
}

export function execute(root: Root, queryPlan: Plan, leaves: Map<number, Leaf>) {
  if (!queryPlan.groups.length || queryPlan.groups.some((g) => !g.inline.length && !g.external.length)) return []
  const decoded = new Map<Uint8Array, number[]>()
  const sets = queryPlan.groups.map((group) => {
    const docs = new Set(group.inline)
    for (const shard of group.external) {
      const leaf = leaves.get(shard)
      if (!leaf) throw new Error('Missing search leaf')
      const ids = new Set<number>()
      leaf.tokens.forEach((token, i) => { if (token.includes(group.term)) ids.add(leaf.ids[i]) })
      for (const id of ids) {
        const packed = leaf.lists[id]
        let values = decoded.get(packed)
        if (!values) { values = decodePosting(packed, root.documents); decoded.set(packed, values) }
        for (const doc of values) docs.add(doc)
      }
    }
    return docs
  }).sort((a, b) => a.size - b.size)
  return [...sets[0]].filter((doc) => sets.every((set) => set.has(doc))).sort((a, b) => a - b)
}
