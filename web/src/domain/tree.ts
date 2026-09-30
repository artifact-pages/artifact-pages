import type { ArtifactIndexEntry } from './index'

export type ArtifactTreeNode = {
  name: string
  path: string
  directories: Map<string, ArtifactTreeNode>
  artifacts: ArtifactIndexEntry[]
}

export function buildArtifactTree(artifacts: ArtifactIndexEntry[]): ArtifactTreeNode {
  const root: ArtifactTreeNode = {
    name: '',
    path: '',
    directories: new Map(),
    artifacts: [],
  }

  for (const artifact of artifacts) {
    const segments = artifact.path.split('/').filter(Boolean)
    const fileName = segments.pop()

    if (!fileName) {
      root.artifacts.push(artifact)
      continue
    }

    let node = root
    for (const segment of segments) {
      let directory = node.directories.get(segment)
      if (!directory) {
        directory = {
          name: segment,
          path: node.path ? `${node.path}/${segment}` : segment,
          directories: new Map(),
          artifacts: [],
        }
        node.directories.set(segment, directory)
      }
      node = directory
    }

    node.artifacts.push(artifact)
  }

  sortTree(root)
  return root
}

export function countArtifacts(node: ArtifactTreeNode): number {
  return node.artifacts.length + [...node.directories.values()].reduce(
    (total, directory) => total + countArtifacts(directory),
    0,
  )
}

export function flattenArtifacts(node: ArtifactTreeNode): ArtifactIndexEntry[] {
  return [
    ...node.artifacts,
    ...[...node.directories.values()].flatMap(flattenArtifacts),
  ]
}

function sortTree(node: ArtifactTreeNode) {
  node.artifacts.sort((left, right) => left.title.localeCompare(right.title))
  for (const directory of node.directories.values()) {
    sortTree(directory)
  }
}
