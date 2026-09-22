import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, posix, resolve } from 'node:path'

const MAX_ARCHIVE_BYTES = 20 * 1024 * 1024
const MAX_UNPACKED_BYTES = 15 * 1024 * 1024
const archive = process.argv[2]

function fail(message) {
  throw new Error(`package audit failed: ${message}`)
}

function tar(args) {
  const result = spawnSync('tar', args, {
    encoding: 'utf8',
    maxBuffer: MAX_ARCHIVE_BYTES * 2,
  })
  if (result.error !== undefined) fail(result.error.message)
  if (result.status !== 0) fail(result.stderr.trim() || `tar exited with ${result.status}`)
  return result.stdout
}

function allowedEntry(name) {
  const exact = new Set([
    'package/LICENSE',
    'package/README.md',
    'package/cordis.patch.yml',
    'package/lib/client.js',
    'package/lib/index.js',
    'package/package.json',
  ])
  return exact.has(name) || /^package\/lib\/types\/(?:[^/]+\/)*[^/]+\.d\.ts$/.test(name)
}

async function main() {
  if (archive === undefined || process.argv.length !== 3) {
    fail('usage: node scripts/audit-package.mjs <package.tgz>')
  }
  if (!archive.endsWith('.tgz')) fail('artifact must use the .tgz extension')

  const archiveInfo = await stat(archive)
  if (!archiveInfo.isFile()) fail('artifact is not a regular file')
  if (archiveInfo.size > MAX_ARCHIVE_BYTES) fail(`compressed artifact exceeds ${MAX_ARCHIVE_BYTES} bytes`)

  const entries = tar(['-tzf', archive]).split('\n').filter(Boolean)
  if (entries.length === 0) fail('archive is empty')
  if (new Set(entries).size !== entries.length) fail('archive contains duplicate paths')

  const verboseEntries = tar(['-tvzf', archive]).split('\n').filter(Boolean)
  if (verboseEntries.length !== entries.length) fail('could not account for every archive entry')
  if (verboseEntries.some(line => line[0] !== '-')) fail('archive contains a link or non-regular entry')

  for (const entry of entries) {
    if (entry.includes('\\') || entry.startsWith('/') || posix.normalize(entry) !== entry) {
      fail(`unsafe archive path: ${entry}`)
    }
    if (!entry.startsWith('package/') || entry.split('/').includes('..')) {
      fail(`entry escapes the package root: ${entry}`)
    }
    if (!allowedEntry(entry)) fail(`unexpected published file: ${entry}`)
    if (/(^|\/)(?:node_modules|src|tests?|coverage)(?:\/|$)/.test(entry)) {
      fail(`development file was published: ${entry}`)
    }
    if (/\.map$|(^|\/)\.env(?:\.|$)|(^|\/)\.npmrc$|\.(?:key|pem)$/i.test(entry)) {
      fail(`sensitive or source-map file was published: ${entry}`)
    }
  }

  for (const required of [
    'package/LICENSE',
    'package/README.md',
    'package/cordis.patch.yml',
    'package/lib/client.js',
    'package/lib/index.js',
    'package/lib/types/index.d.ts',
    'package/package.json',
  ]) {
    if (!entries.includes(required)) fail(`required file is missing: ${required}`)
  }

  const output = await mkdtemp(resolve(tmpdir(), 'zeroclave-package-audit-'))
  try {
    tar(['-xzf', archive, '-C', output])
    const outputRoot = await realpath(output)
    let unpackedBytes = 0
    for (const entry of entries) {
      const file = resolve(output, entry)
      const canonical = await realpath(file)
      if (!canonical.startsWith(`${outputRoot}/`)) fail(`extracted path escapes audit directory: ${entry}`)
      const info = await stat(canonical)
      if (!info.isFile()) fail(`extracted entry is not a regular file: ${entry}`)
      unpackedBytes += info.size

      const content = await readFile(canonical, 'utf8')
      for (const [label, pattern] of [
        ['macOS user path', /\/Users\//],
        ['GitHub runner path', /\/home\/runner\/work\//],
        ['macOS temporary path', /\/private\/var\/folders\//],
        ['Windows user path', /[A-Za-z]:\\Users\\/],
      ]) {
        if (pattern.test(content)) fail(`${label} leaked into ${entry}`)
      }
      if (entry.endsWith('.js') && /sourceMappingURL=.*\.map(?:\s|$)/.test(content)) {
        fail(`published JavaScript references an unavailable source map: ${entry}`)
      }
    }
    if (unpackedBytes > MAX_UNPACKED_BYTES) fail(`unpacked artifact exceeds ${MAX_UNPACKED_BYTES} bytes`)

    const manifest = JSON.parse(await readFile(resolve(output, 'package/package.json'), 'utf8'))
    if (manifest.name !== '@zeroclave/dsh-privacy') fail('unexpected package name')
    for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepare']) {
      if (manifest.scripts?.[lifecycle] !== undefined) fail(`package declares a ${lifecycle} lifecycle script`)
    }

    console.log(JSON.stringify({
      archive: basename(archive),
      files: entries.length,
      unpackedBytes,
      version: manifest.version,
    }))
  } finally {
    await rm(output, { recursive: true, force: true })
  }
}

await main()
