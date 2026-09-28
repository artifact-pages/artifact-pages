const allowedRootFiles = new Set([
  'index.html',
  'preview-bridge.js',
  'LICENSE',
  'THIRD_PARTY_NOTICES.txt',
])

export function assertWebBundlePathsMatchDeploymentContract(files) {
  const unsupported = files.filter(
    (file) => !allowedRootFiles.has(file) && !file.startsWith('assets/'),
  )

  if (unsupported.length > 0) {
    throw new Error(
      `Web bundle contains paths outside the deployed application scope: ${unsupported.join(', ')}. Update the deployment policy and route contract before packaging these files.`,
    )
  }
}
