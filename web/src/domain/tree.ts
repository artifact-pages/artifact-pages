import type { ArtifactIndexEntry } from './index'
import { findIndexArtifact, folderLabel } from './directory.ts'
import { compareArtifactsByPath, compareNames } from './listing-order.ts'

export type ArtifactTreeNode = {
  name: string
  /** What is displayed: the index page's title when it has one, else `name`. Empty for the root. */
  label: string
  path: string
  directories: Map<string, ArtifactTreeNode>
  artifacts: ArtifactIndexEntry[]
}

export function buildArtifactTree(artifacts: ArtifactIndexEntry[]): ArtifactTreeNode {
  const root: ArtifactTreeNode = {
    name: '',
    label: '',
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
          label: segment,
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

/**
 * The index page whose own row is folded into its folder row in the sidebar tree:
 * the folder's README or index page, but only when the folder has other children.
 * A folder whose only child is its index page keeps that row. At the site root the
 * page is the introduction, chosen like a folder's index page, which Overview stands for.
 */
export function foldedIndexArtifact(node: Pick<ArtifactTreeNode, 'path' | 'artifacts' | 'directories'>) {
  if (node.artifacts.length <= 1 && node.directories.size === 0) return undefined
  // At the site root the folded page is the introduction that Overview renders (ISSUE-129: chosen like a folder's).
  return findIndexArtifact(node.artifacts)
}

export function countArtifacts(node: ArtifactTreeNode): number {
  return node.artifacts.length + [...node.directories.values()].reduce(
    (total, directory) => total + countArtifacts(directory),
    0,
  )
}

export function flattenArtifacts(node: ArtifactTreeNode): ArtifactIndexEntry[] {
  // Folders first, like the tree itself.
  return [
    ...[...node.directories.values()].flatMap(flattenArtifacts),
    ...node.artifacts,
  ]
}

function sortTree(node: ArtifactTreeNode) {
  node.artifacts.sort(compareArtifactsByPath)
  if (node.path) node.label = folderLabel(node.name, findIndexArtifact(node.artifacts))
  const sorted = [...node.directories.entries()].sort(([left], [right]) => compareNames(left, right))
  node.directories.clear()
  for (const [name, directory] of sorted) {
    node.directories.set(name, directory)
    sortTree(directory)
  }
}
