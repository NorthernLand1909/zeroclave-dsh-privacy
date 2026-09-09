import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const tests = fileURLToPath(new URL('.', import.meta.url))
const repo = [
  process.env.DSH_REPO,
  resolve(tests, '../../../..'),
  resolve(tests, '../../../.upstream/deepseek-harness'),
].find(candidate => candidate !== undefined && existsSync(resolve(candidate, 'apps/cli/src/bin.ts')))
if (repo === undefined) throw new Error('DeepSeek Harness checkout not found; set DSH_REPO to its absolute path')
const requireFromRepo = createRequire(resolve(repo, 'packages/experimental/zeroclave-privacy/package.json'))
const reactRoot = dirname(requireFromRepo.resolve('react/package.json'))
const reactDomRoot = dirname(requireFromRepo.resolve('react-dom/package.json'))
const output = await mkdtemp(resolve(tmpdir(), 'zeroclave-send-smoke-'))
const routes = new Map([
  ['/', [resolve(tests, 'browser.html'), 'text/html']],
  ['/client.js', [resolve(repo, 'packages/experimental/zeroclave-privacy/lib/client.js'), 'text/javascript']],
  ['/react.js', [resolve(reactRoot, 'umd/react.development.js'), 'text/javascript']],
  ['/jsx.js', [resolve(reactRoot, 'cjs/react-jsx-runtime.production.min.js'), 'text/plain']],
  ['/react-dom.js', [resolve(reactDomRoot, 'umd/react-dom.development.js'), 'text/javascript']],
])
const server = createServer(async (request, response) => {
  const route = routes.get(request.url)
  if (route === undefined) { response.writeHead(404).end(); return }
  try {
    const body = await readFile(route[0])
    response.writeHead(200, {'content-type': route[1]}).end(body)
  } catch { response.writeHead(500).end() }
})
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
const url = `http://127.0.0.1:${address.port}`
let browser
try {
  browser = await chromium.launch({ channel:'chrome', headless:true })
  const context = await browser.newContext({ permissions:['clipboard-read', 'clipboard-write'] })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const secret = 'abcdefghijklmnopqrstuvwx'
  const original = `采购框架协议\n合同编号：TEST-2026-001\n甲方（买方）：示例采购有限公司\n通讯地址：深圳市示例路100号\n邮箱：demo@example.com\napi_key=${secret}`
  await page.goto(url)
  await page.getByRole('button', {name:'隐私检测',exact:true}).click()
  await page.getByRole('button', {name:'正则规则',exact:true}).click()
  await page.getByRole('button', {name:'新增规则',exact:true}).click()
  await page.getByText('规则名称', {exact:true}).locator('..').getByRole('textbox').fill('员工编号')
  await page.getByText('正则表达式', {exact:true}).locator('..').getByRole('textbox').fill('员工编号[：:]\\s*(EMP-\\d{4})')
  await page.getByRole('combobox', {name:'脱敏范围'}).selectOption('group')
  await page.getByText('测试文本', {exact:true}).locator('..').getByRole('textbox').fill('员工编号：EMP-2048')
  await page.getByRole('button', {name:'测试匹配',exact:true}).click()
  await page.getByText('1 处匹配', {exact:true}).waitFor()
  await page.getByRole('button', {name:'保存规则',exact:true}).click()
  await page.getByText('员工编号', {exact:true}).waitFor()
  await page.getByRole('button', {name:'关闭隐私检测面板'}).click()
  const input = `${original}\n员工编号：EMP-2048`
  await page.getByRole('textbox', {name:'消息'}).fill(input)
  await page.getByText('发现敏感内容', {exact:true}).waitFor()
  assert.equal(await page.getByRole('textbox', {name:'消息'}).inputValue(), input)
  assert.equal(await page.getByRole('button', {name:'使用脱敏文本'}).count(), 0)
  await page.getByRole('button', {name:'发送',exact:true}).click()
  await page.getByText('发送前检查', {exact:true}).waitFor()
  await page.screenshot({path:resolve(output,'review-desktop.png'),fullPage:true})
  await page.setViewportSize({width:390,height:844})
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({path:resolve(output,'review-mobile.png'),fullPage:true})
  await page.setViewportSize({width:1280,height:900})
  const secretReview = page.locator('article').filter({hasText:'API 密钥'}).first()
  await secretReview.getByRole('button', {name:'保留原文',exact:true}).click()
  await page.getByRole('button', {name:'保留 1 项并发送',exact:true}).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="message"]')[1]?.textContent.includes('demo@example.com'))
  const outgoing = await page.evaluate(() => window.__OUTGOING__)
  assert.ok(outgoing.includes('ZCPII-'))
  assert.ok(outgoing.includes(secret))
  assert.ok(!outgoing.includes('demo@example.com') && !outgoing.includes('示例采购有限公司') && !outgoing.includes('EMP-2048'))
  assert.equal(await page.locator('[data-testid="message"] pre').first().textContent(), input)
  await page.locator('[data-testid="message"]').last().getByRole('button', {name:'复制'}).click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `核对结果：\n${input}`)
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="message"]')[1]?.textContent.includes('demo@example.com'))
  assert.equal(await page.locator('[data-testid="message"] pre').first().textContent(), input)
  await page.setViewportSize({width:1280,height:900})
  await page.screenshot({path:resolve(output,'desktop.png'),fullPage:true})
  await page.setViewportSize({width:390,height:844})
  await page.getByRole('button', {name:'隐私检测',exact:true}).click()
  await page.getByRole('button', {name:'正则规则',exact:true}).click()
  assert.equal(await page.getByText('员工编号', {exact:true}).count(), 1)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({path:resolve(output,'mobile.png'),fullPage:true})
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({passed:true,checks:['custom rule editor','critical send review','per-finding choice','custom outbound redaction','original draft','original messages','copy','storage reload','mobile layout'],output}))
} finally {
  await browser?.close()
  await new Promise(resolveClose => server.close(resolveClose))
}
