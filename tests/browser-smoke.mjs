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
const telemetryEvents = []
const telemetryEnabled = process.env.ZEROCLAVE_PRIVACY_PREVIEW !== '1'
let telemetryConfigRequests = 0
let zeroClaveRequests = 0
const zeroClaveTexts = []
const seenRequests = []
const server = createServer(async (request, response) => {
  seenRequests.push(`${request.method} ${request.url}`)
  if (request.url === '/api/zeroclave-privacy/detect' && request.method === 'POST') {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const requestId = request.headers['x-request-id']
    zeroClaveRequests += 1
    zeroClaveTexts.push(...body.texts.map(item => item.text))
    response.writeHead(200, {
      'cache-control':'no-store', 'content-type':'application/json', 'x-request-id':requestId,
    }).end(JSON.stringify({
      request_id:requestId,
      model_version:'browser-smoke-v1',
      results:body.texts.map(item => ({
        id:item.id, revision:item.revision, status:'complete', entities:[],
      })),
    }))
    return
  }
  if (request.url === '/api/zeroclave-privacy/telemetry/config' && request.method === 'GET') {
    telemetryConfigRequests += 1
    response.writeHead(200, {'cache-control':'no-store','content-type':'application/json'})
      .end(JSON.stringify({enabled:telemetryEnabled}))
    return
  }
  if (request.url === '/api/zeroclave-privacy/telemetry/events' && request.method === 'POST') {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    telemetryEvents.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    response.writeHead(204, {'cache-control':'no-store'}).end()
    return
  }
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
if (process.env.ZEROCLAVE_PRIVACY_PREVIEW === '1') {
  console.log(JSON.stringify({preview:true,url}))
  await new Promise(resolveStop => {
    const stop = () => { server.close(resolveStop) }
    process.once('SIGINT', stop)
    process.once('SIGTERM', stop)
  })
  process.exit(0)
}
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
  await page.getByRole('main').getByRole('button', {name:'隐私检测',exact:true}).click()
  await page.getByRole('img', {name:'ZeroClave 隐私防火墙',exact:true}).waitFor()
  await page.getByRole('button', {name:'正则规则',exact:true}).click()
  await page.getByRole('button', {name:'新增规则',exact:true}).click()
  await page.getByText('规则名称', {exact:true}).locator('..').getByRole('textbox').fill('员工编号')
  await page.getByText('正则表达式', {exact:true}).locator('..').getByRole('textbox').fill('员工编号[：:]\\s*(EMP-\\d{4})')
  await page.getByRole('combobox', {name:'脱敏范围'}).selectOption('group')
  await page.getByText('测试文本', {exact:true}).locator('..').getByRole('textbox').fill('员工编号：EMP-2048')
  await page.getByRole('button', {name:'测试匹配',exact:true}).click()
  await page.getByText('1 处匹配', {exact:true}).waitFor()
  await page.locator('[data-zero-privacy-scroll]').evaluate(element => { element.scrollTop = 0 })
  await page.screenshot({path:resolve(output,'rule-editor-desktop.png'),fullPage:true})
  await page.getByRole('button', {name:'保存规则',exact:true}).click()
  await page.getByText('员工编号', {exact:true}).waitFor()
  await page.screenshot({path:resolve(output,'rules-desktop.png'),fullPage:true})
  await page.getByRole('button', {name:'关闭隐私检测面板'}).click()
  const input = `${original}\n员工编号：EMP-2048`
  await page.getByRole('textbox', {name:'消息'}).fill(input)
  await page.getByText('发现敏感内容', {exact:true}).waitFor()
  assert.equal(await page.getByRole('textbox', {name:'消息'}).inputValue(), input)
  assert.equal(await page.getByRole('button', {name:'使用脱敏文本'}).count(), 0)
  await page.getByRole('button', {name:'查看详情',exact:true}).click()
  await page.getByRole('navigation').getByRole('button', {name:'隐私检测',exact:true}).click()
  await page.getByText('监测详情', {exact:true}).waitFor()
  await page.getByText('脱敏方法：本地正则', {exact:true}).waitFor()
  await page.getByText(/检测完成 · \d+项敏感实体 · \d+ms/u).waitFor()
  await page.getByRole('button', {name:'重新检测',exact:true}).click()
  await page.getByText(/检测完成 · \d+项敏感实体 · \d+ms/u).waitFor()
  await page.screenshot({path:resolve(output,'current-detection-desktop.png'),fullPage:true})
  await page.getByRole('button', {name:'关闭隐私检测面板'}).click()
  await page.getByRole('button', {name:'发送',exact:true}).click()
  await page.getByText('当前输入', {exact:true}).waitFor()
  await page.screenshot({path:resolve(output,'review-desktop.png'),fullPage:true})
  await page.setViewportSize({width:390,height:844})
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({path:resolve(output,'review-mobile.png'),fullPage:true})
  await page.setViewportSize({width:1280,height:900})
  const emailReview = page.locator('article').filter({hasText:'邮箱'}).first()
  await emailReview.getByRole('button', {name:'修改',exact:true}).click()
  await emailReview.getByRole('textbox', {name:'脱敏文本: 邮箱',exact:true}).fill('[TEAM_EMAIL]')
  await emailReview.getByRole('button', {name:'保存修改',exact:true}).click()
  const secretReview = page.locator('article').filter({hasText:'API 密钥'}).first()
  await secretReview.getByRole('button', {name:'保留原文',exact:true}).click()
  await page.getByRole('button', {name:'保留 1 项并发送',exact:true}).click()
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="message"]')[1]?.textContent.includes('demo@example.com'))
  const outgoing = await page.evaluate(() => window.__OUTGOING__)
  assert.ok(outgoing.includes('ZCPII-'))
  assert.ok(outgoing.includes('[TEAM_EMAIL]'))
  assert.ok(outgoing.includes(secret))
  assert.ok(!outgoing.includes('demo@example.com') && !outgoing.includes('示例采购有限公司') && !outgoing.includes('EMP-2048'))
  assert.equal(await page.locator('[data-testid="message"] pre').first().textContent(), input)
  await page.getByRole('navigation').getByRole('button', {name:'隐私检测',exact:true}).click()
  await page.getByText('本次会话', {exact:true}).waitFor()
  await page.getByText('已处理并发送', {exact:true}).waitFor()
  assert.equal(await page.getByRole('button', {name:'检测历史',exact:true}).count(), 0)
  await page.screenshot({path:resolve(output,'detection-desktop.png'),fullPage:true})
  await page.locator('[data-testid="message"]').last().getByRole('button', {name:'复制'}).click()
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), `核对结果：\n${input}`)
  await page.reload()
  await page.waitForTimeout(500)
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="message"]')[1]?.textContent.includes('demo@example.com'))
  assert.equal(await page.locator('[data-testid="message"] pre').first().textContent(), input)
  await page.getByRole('main').getByRole('button', {name:'隐私检测',exact:true}).click()
  assert.equal(await page.getByText('本次会话', {exact:true}).count(), 0)
  await page.getByRole('button', {name:'检测设置',exact:true}).click()
  const telemetryToggle = page.getByRole('switch', {name:'共享匿名使用统计'})
  await telemetryToggle.waitFor({state:'attached'})
  await telemetryToggle.scrollIntoViewIfNeeded()
  assert.deepEqual(errors, [])
  assert.notEqual(await page.evaluate(() => navigator.globalPrivacyControl), true)
  await page.waitForFunction(() => (
    window.__PRIVACY_CONTROLLER__.getSnapshot().telemetry.availability !== 'checking'
  ))
  const telemetryInitialization = await page.evaluate(() => (
    window.__PRIVACY_CONTROLLER__.getSnapshot().telemetry
  ))
  assert.deepEqual(telemetryInitialization, {
    availability:'available', consent:true, lockedByGpc:false,
  })
  assert.equal(telemetryConfigRequests, 2, JSON.stringify(seenRequests))
  assert.equal(await page.getByText('当前部署未配置统计服务', {exact:true}).count(), 0)
  await page.getByRole('button', {name:/ZeroClave API/}).click()
  await page.getByRole('button', {name:'测试连接',exact:true}).click()
  await page.getByRole('button', {name:/ZeroClave API.*已就绪/}).waitFor()
  assert.ok(zeroClaveRequests >= 1, JSON.stringify(seenRequests))
  assert.ok(zeroClaveTexts.includes('ZeroClave synthetic connection test: demo@example.com'))
  await page.getByRole('button', {name:/本地正则/}).click()
  await page.waitForFunction(() => !document.querySelector('[role="switch"]')?.disabled)
  assert.equal(await telemetryToggle.getAttribute('aria-checked'), 'true')
  assert.equal(await telemetryToggle.isEnabled(), true)
  await telemetryToggle.click()
  assert.equal(await telemetryToggle.getAttribute('aria-checked'), 'false')
  await telemetryToggle.click()
  assert.equal(await telemetryToggle.getAttribute('aria-checked'), 'true')
  await page.screenshot({path:resolve(output,'settings-desktop.png'),fullPage:true})
  await page.getByRole('button', {name:'关闭隐私检测面板'}).click()
  const activeTelemetry = page.waitForResponse(response => response.url().endsWith('/telemetry/events')
    && JSON.parse(response.request().postData() ?? '{}').event === 'privacy_active')
  const detectorTelemetry = page.waitForResponse(response => response.url().endsWith('/telemetry/events')
    && JSON.parse(response.request().postData() ?? '{}').event === 'detector_used')
  await page.getByRole('textbox', {name:'消息'}).fill('telemetry smoke')
  await Promise.all([activeTelemetry, detectorTelemetry])
  assert.equal(telemetryEvents.length, 2)
  const activePayload = telemetryEvents.find(event => event.event === 'privacy_active')
  const detectorPayload = telemetryEvents.find(event => event.event === 'detector_used')
  assert.deepEqual(Object.keys(activePayload).sort(), ['daily_id','event','schema_version'])
  assert.deepEqual(Object.keys(detectorPayload).sort(), ['daily_id','event','schema_version','value'])
  assert.equal(activePayload.daily_id, detectorPayload.daily_id)
  assert.equal(detectorPayload.value, 'regex')
  await page.setViewportSize({width:1280,height:900})
  await page.screenshot({path:resolve(output,'desktop.png'),fullPage:true})
  await page.setViewportSize({width:390,height:844})
  await page.getByRole('main').getByRole('button', {name:'隐私检测',exact:true}).click()
  await page.getByRole('button', {name:'正则规则',exact:true}).click()
  assert.equal(await page.getByText('员工编号', {exact:true}).count(), 1)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({path:resolve(output,'mobile.png'),fullPage:true})
  await page.getByRole('button', {name:'检测设置',exact:true}).click()
  await page.getByRole('switch', {name:'共享匿名使用统计'}).locator('..').scrollIntoViewIfNeeded()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.screenshot({path:resolve(output,'settings-mobile.png'),fullPage:true})
  assert.deepEqual(errors, [])
  console.log(JSON.stringify({passed:true,checks:['merged session activity','custom rule editor','manual send review','per-finding choice','editable redaction','custom outbound redaction','original draft','original messages','copy','storage reload','ZeroClave same-origin browser fetch','telemetry opt-in','telemetry payload allowlist','mobile layout'],output}))
} finally {
  await browser?.close()
  await new Promise(resolveClose => server.close(resolveClose))
}
