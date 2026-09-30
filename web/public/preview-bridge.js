(() => {
  let parentOrigin = ''
  let documentOrigin = ''
  let documentPath = ''
  try {
    const documentUrl = new URL(window.location.href)
    const parentUrl = new URL(document.referrer)
    if (window.parent === window || parentUrl.origin !== documentUrl.origin) return
    parentOrigin = parentUrl.origin
    documentOrigin = documentUrl.origin
    documentPath = documentUrl.pathname
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
    let decodedPath
    try {
      decodedPath = decodeURIComponent(target.pathname)
    } catch {
      return
    }
    if (!/\.(?:html?|md)$/iu.test(decodedPath)) return

    event.preventDefault()
    parent.postMessage({ type: 'git-artifact-preview-navigation', href: target.href }, parentOrigin)
  }, true)
})()
