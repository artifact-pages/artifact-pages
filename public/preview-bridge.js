(() => {
  let parentOrigin = ''
  let documentOrigin = ''
  let documentPath = ''
  try {
    const baseUrl = new URL(document.baseURI)
    const sandboxedSrcDoc = window.location.origin === 'null'
    if (sandboxedSrcDoc) {
      const configuredOrigin = window.__gitArtifactPreviewParentOrigin
      if (typeof configuredOrigin === 'string') {
        const configuredUrl = new URL(configuredOrigin)
        if (configuredUrl.origin === configuredOrigin && configuredUrl.protocol === baseUrl.protocol) {
          parentOrigin = configuredOrigin
        }
      }
    } else {
      const parentUrl = new URL(document.referrer)
      if (
        parentUrl.protocol === baseUrl.protocol &&
        ['localhost', '127.0.0.1', '[::1]'].includes(parentUrl.hostname) &&
        parentUrl.port === window.location.port
      ) {
        parentOrigin = parentUrl.origin
      }
    }
    documentOrigin = baseUrl.origin
    documentPath = baseUrl.pathname
  } catch {
    return
  }
  if (!parentOrigin) return

  const filesMarker = '/files/'
  const filesIndex = documentPath.indexOf(filesMarker)
  if (filesIndex < 0) return
  const filesPrefix = documentPath.slice(0, filesIndex + filesMarker.length)

  document.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    const node = event.target instanceof Element ? event.target : event.target?.parentElement
    const anchor = node?.closest('a[href]')
    if (!anchor || anchor.hasAttribute('download') || (anchor.target && anchor.target !== '_self')) return

    let target
    try {
      target = new URL(anchor.href, document.baseURI)
    } catch {
      return
    }
    if (target.origin !== documentOrigin || !target.pathname.startsWith(filesPrefix)) return

    event.preventDefault()
    parent.postMessage({ type: 'git-artifact-preview-navigation', href: target.href }, parentOrigin)
  }, true)
})()
