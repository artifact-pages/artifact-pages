import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'

const shaPattern = /^[0-9a-f]{40}$/i

// Resolves the Git refs a preview Action run uses. An explicit input always wins.
// On a pull_request event the event-recorded head SHA and base ref are used only
// as Git-ref defaults; they never create PR provenance (the pull-request input
// stays explicit-only). Every other event keeps the CLI defaults.
export function resolvePreviewRefs(options = {}) {
  const env = options.env ?? process.env
  const explicitHead = String(options.head ?? env.ARTIFACT_PAGES_INPUT_HEAD ?? '').trim()
  const explicitDefaultRef = String(options.defaultRef ?? env.ARTIFACT_PAGES_INPUT_DEFAULT_REF ?? '').trim()
  const eventName = options.eventName ?? env.GITHUB_EVENT_NAME ?? ''

  let head = explicitHead
  let defaultRef = explicitDefaultRef
  let headSource = explicitHead ? 'input' : 'default'
  let defaultRefSource = explicitDefaultRef ? 'input' : 'default'

  if (eventName === 'pull_request' && (!head || !defaultRef)) {
    const pullRequest = (options.event ?? readEvent(env.GITHUB_EVENT_PATH))?.pull_request
    if (!head) {
      const sha = String(pullRequest?.head?.sha ?? '')
      if (!shaPattern.test(sha)) throw new Error('pull_request event is missing a valid head commit SHA; pass the head input explicitly')
      head = sha
      headSource = 'event'
    }
    if (!defaultRef) {
      const baseRef = String(pullRequest?.base?.ref ?? '').trim()
      if (!baseRef) throw new Error('pull_request event is missing the base ref; pass the default-ref input explicitly')
      defaultRef = `origin/${baseRef}`
      defaultRefSource = 'event'
    }
  }

  if (!head) head = 'HEAD'
  if (!defaultRef) defaultRef = 'origin/HEAD'
  return { head, defaultRef, headSource, defaultRefSource, eventName }
}

function readEvent(eventPath) {
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is required to read the pull_request event')
  return JSON.parse(readFileSync(eventPath, 'utf8'))
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  if (result.error) throw result.error
  return { status: result.status, stdout: result.stdout.trim() }
}

function resolveCommit(cwd, ref) {
  const result = git(cwd, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])
  return result.status === 0 && shaPattern.test(result.stdout) ? result.stdout : ''
}

// Fails early, with an actionable message, when the checkout cannot supply the
// head, the default ref, or their merge base. It never fetches anything.
export function assertPreviewRefsReachable(cwd, refs) {
  const checkoutHint = 'Check out the repository with actions/checkout using `fetch-depth: 0` so the full history and the default branch are available.'
  const head = resolveCommit(cwd, refs.head)
  if (!head) {
    const prHint = refs.headSource === 'event'
      ? ` The pull_request head SHA must be fetched; the default merge-commit checkout does not contain it unless the full history is fetched.`
      : ''
    throw new Error(`preview head ${JSON.stringify(refs.head)} does not resolve to a commit in the checkout.${prHint} ${checkoutHint}`)
  }
  const base = resolveCommit(cwd, refs.defaultRef)
  if (!base) {
    throw new Error(`default ref ${JSON.stringify(refs.defaultRef)} does not resolve to a commit in the checkout. ${checkoutHint} Pass default-ref explicitly if the default branch is fetched under another name.`)
  }
  const mergeBase = git(cwd, ['merge-base', head, base])
  if (mergeBase.status !== 0 || !shaPattern.test(mergeBase.stdout)) {
    throw new Error(`no merge base exists between preview head ${JSON.stringify(refs.head)} and default ref ${JSON.stringify(refs.defaultRef)}. ${checkoutHint}`)
  }
  return { headSHA: head, defaultRefSHA: base, mergeBaseSHA: mergeBase.stdout }
}
