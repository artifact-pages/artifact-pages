const labelPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

export function parseVersionLabel(args) {
  const versionIndex = args.indexOf('--version')
  const version = versionIndex >= 0 ? args[versionIndex + 1] : undefined

  if (!version || !labelPattern.test(version)) {
    throw new Error(
      'Pass a release label with --version (letters, numbers, dot, underscore, plus, and hyphen; 64 characters max).',
    )
  }

  if (args.filter((argument) => argument === '--version').length !== 1 || args.length !== 2) {
    throw new Error('Usage: npm run package:web -- --version <label>')
  }

  return version
}
