const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const YAML = require('yaml')

const workflowPath = path.resolve(__dirname, '../.github/workflows/release.yml')
const workflow = fs.readFileSync(workflowPath, 'utf8')
const installer = fs.readFileSync(
  path.resolve(__dirname, '../scripts/install-linux-client.sh'),
  'utf8',
)
const recoveryPolicy = fs.readFileSync(
  path.resolve(__dirname, '../scripts/com.speechtranscription.m5-recover.policy'),
  'utf8',
)
const recoveryRule = fs.readFileSync(
  path.resolve(__dirname, '../scripts/49-capswriter-m5-recover.rules'),
  'utf8',
)

const linuxSupportAssets = [
  ['m5bridge-doctor.py', 'M5_DOCTOR_NAME'],
  ['capswriter-m5-recover-bluetooth', 'M5_RECOVERY_HELPER_NAME'],
  ['com.speechtranscription.m5-recover.policy', 'M5_RECOVERY_POLICY_NAME'],
  ['49-capswriter-m5-recover.rules', 'M5_RECOVERY_RULE_NAME'],
]

function stepBody(name) {
  const startMarker = `      - name: ${name}\n`
  const start = workflow.indexOf(startMarker)
  assert.notEqual(start, -1, `missing workflow step: ${name}`)

  const nextStep = workflow.indexOf('\n      - name:', start + startMarker.length)
  const nextAction = workflow.indexOf('\n      - uses:', start + startMarker.length)
  const candidates = [nextStep, nextAction].filter((index) => index !== -1)
  const end = candidates.length > 0 ? Math.min(...candidates) : workflow.length
  return workflow.slice(start, end)
}

test('Linux release publishes every installer support asset', () => {
  assert.doesNotThrow(() => YAML.parse(workflow), 'release workflow must remain valid YAML')
  const prepareStep = stepBody('Prepare Linux installation assets')
  const checksumStep = stepBody('Generate checksums')
  const createReleaseStep = stepBody('Create release')
  const uploadBranch = createReleaseStep.slice(
    createReleaseStep.indexOf('gh release upload'),
    createReleaseStep.indexOf('else'),
  )
  const createBranch = createReleaseStep.slice(createReleaseStep.indexOf('gh release create'))

  for (const [asset, installerVariable] of linuxSupportAssets) {
    const escapedAsset = asset.replaceAll('.', '\\.')

    assert.match(
      prepareStep,
      new RegExp(`cp scripts/${escapedAsset} release-assets/${escapedAsset}`),
      `${asset} must be copied from scripts into release-assets`,
    )
    assert.match(checksumStep, new RegExp(escapedAsset), `${asset} must be checksummed`)
    assert.match(
      uploadBranch,
      new RegExp(`release-assets/${escapedAsset}`),
      `${asset} must be uploaded to an existing release`,
    )
    assert.match(
      createBranch,
      new RegExp(`release-assets/${escapedAsset}`),
      `${asset} must be uploaded when creating a release`,
    )
    assert.match(
      installer,
      new RegExp(`${installerVariable}="${escapedAsset}"`),
      `${installerVariable} must resolve to ${asset}`,
    )
    assert.match(
      installer,
      new RegExp(`--pattern "\\$${installerVariable}"`),
      `${asset} must be downloaded through ${installerVariable}`,
    )
    assert.match(
      installer,
      new RegExp(`verify_release_asset "\\$${installerVariable}"`),
      `installer must verify the checksum for ${asset}`,
    )
  }
})

test('Polkit recovery permission is bound to the restricted installed helper', () => {
  assert.match(
    recoveryPolicy,
    /<action id="com\.speechtranscription\.m5-recover-bluetooth">/,
  )
  assert.match(
    recoveryPolicy,
    /<annotate key="org\.freedesktop\.policykit\.exec\.path">\/usr\/libexec\/capswriter-m5-recover-bluetooth<\/annotate>/,
  )
  assert.match(
    recoveryRule,
    /action\.id == "com\.speechtranscription\.m5-recover-bluetooth"/,
  )
  assert.match(recoveryRule, /subject\.local && subject\.active/)
})
