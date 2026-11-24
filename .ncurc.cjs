module.exports = {
  // No `cooldown` here on purpose: ncu ≥22 inherits minimumReleaseAge + minimumReleaseAgeExclude from pnpm-workspace.yaml when cooldown is unset.
  // Setting one overrides that inheritance and drifts from the install gate.
  packageFile: './package.json',
  packageManager: 'pnpm',
  reject: [],
  root: true,
}
