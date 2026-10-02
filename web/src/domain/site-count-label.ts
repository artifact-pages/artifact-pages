export function siteCountLabel(count: number) {
  return `${count} ${count === 1 ? 'site' : 'sites'} available`
}

export function artifactCountLabel(count: number) {
  return `${count} ${count === 1 ? 'artifact' : 'artifacts'}`
}
