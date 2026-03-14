// tests/freeze.js
// GitHub Secrets 配置：
//   DISCORD_ACCOUNT  格式: email,password
//   GOST_PROXY       格式: socks5://host:port（可选）
//   TG_BOT           格式: chat_id,bot_token

const { test, expect, chromium } = require('@playwright/test');
const https = require('https');

// ================================================================
// ⚙️ 配置解析
// ================================================================
const [DISCORD_EMAIL, DISCORD_PASSWORD] = (process.env.DISCORD_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 30000;

// ================================================================
// 🕐 工具函数
// ================================================================
function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}

// ================================================================
// 📨 TG 推送
// ================================================================
function sendTG(result) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) {
            console.log('⚠️ TG_BOT 未配置，跳过推送');
            return resolve();
        }

        const msg = [
            `🎮 FreezeHost 续期通知`,
            `🕐 运行时间: ${nowStr()}`,
            `🖥 服务器: FreezeHost Free`,
            `📊 续期结果: ${result}`,
        ].join('\n');

        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: msg });
        const req = https.request({
            hostname: 'api.telegram.org',
            path: `/bot${TG_TOKEN}/sendMessage`,
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
        }, (res) => {
            if (res.statusCode === 200) {
                console.log('📨 TG 推送成功');
            } else {
                console.log(`⚠️ TG 推送失败：HTTP ${res.statusCode}`);
            }
            resolve();
        });

        req.on('error', (e) => {
            console.log(`⚠️ TG 推送异常：${e.message}`);
            resolve();
        });

        req.setTimeout(15000, () => {
            console.log('⚠️ TG 推送超时');
            req.destroy();
            resolve();
        });

        req.write(body);
        req.end();
    });
}

// ================================================================
// 🔐 OAuth 授权页处理
// ================================================================
async function handleOAuthPage(page) {
    for (let i = 0; i < 5; i++) {
        let btn;
        try {
            btn = await page.waitForSelector('button.primary_a22cb0', { timeout: 8000 });
        } catch {
            try { btn = await page.locator('button:has-text("授权")').first().elementHandle(); }
            catch { break; }
        }
        if (!btn) break;

        const text = (await btn.innerText()).trim();
        console.log(`  🔍 OAuth 按钮: "${text}"`);

        if (text.includes('滚动') || text.toLowerCase().includes('scroll')) {
            await page.evaluate(() => {
                const s = document.querySelector('[class*="scroller"]')
                       || document.querySelector('[class*="scrollerBase"]')
                       || document.querySelector('[class*="content"]');
                if (s) s.scrollTop = s.scrollHeight;
                window.scrollTo(0, document.body.scrollHeight);
            });
            await page.waitForTimeout(1500);
            await btn.click();
            await page.waitForTimeout(1500);
            continue;
        }

        if (text.includes('授权') || text.toLowerCase().includes('authorize')) {
            const disabled = await btn.evaluate(el => el.disabled || el.classList.contains('disabled'));
            if (disabled) { await page.waitForTimeout(1500); continue; }
            await btn.click();
            console.log('  ✅ 已点击授权按钮');
            return;
        }

        const disabled = await btn.evaluate(el => el.disabled || el.classList.contains('disabled'));
        if (!disabled) { await btn.click(); await page.waitForTimeout(1500); }
        else break;
    }
}

// ================================================================
// 主测试
// ================================================================
test('FreezeHost 自动续期', async () => {
    if (!DISCORD_EMAIL || !DISCORD_PASSWORD) {
        throw new Error('❌ 缺少 DISCORD_ACCOUNT，格式: email:password');
    }

    // GOST_PROXY 固定为本地地址，需先确认 GOST 进程是否真正启动
    // 方式：尝试连通本地代理，失败则降级为直连
    let proxyConfig = undefined;
    if (process.env.GOST_PROXY) {
        try {
            const http = require('http');
            await new Promise((resolve, reject) => {
                const req = http.request(
                    { host: '127.0.0.1', port: 8080, path: '/', method: 'GET', timeout: 3000 },
                    () => resolve()
                );
                req.on('error', reject);
                req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
                req.end();
            });
            proxyConfig = { server: process.env.GOST_PROXY };
            console.log('🛡️ 本地代理连通，使用 GOST 转发');
        } catch {
            console.log('⚠️ 本地代理不可达，降级为直连');
        }
    }

    console.log('🔧 启动浏览器...');
    const browser = await chromium.launch({
        headless: true,
        proxy: proxyConfig,
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(TIMEOUT);
    console.log('🚀 浏览器就绪！');

    try {

        // ── 出口 IP 验证 ──────────────────────────────────────
        console.log('🌐 验证出口 IP...');
        try {
            const res = await page.goto('https://api.ipify.org?format=json', { waitUntil: 'domcontentloaded' });
            const body = await res.text();
            const ip = JSON.parse(body).ip || body;
            const masked = ip.replace(/(\d+\.\d+\.\d+\.)\d+/, '$1xx');
            console.log(`✅ 出口 IP 确认：${masked}`);
        } catch {
            console.log('⚠️ IP 验证超时，跳过');
        }

        // ── 登录 ──────────────────────────────────────────────
        console.log('🔑 打开 FreezeHost 登录页...');
        await page.goto('https://free.freezehost.pro', { waitUntil: 'domcontentloaded' });

        console.log('📤 点击 Login with Discord...');
        await page.click('span.text-lg:has-text("Login with Discord")');

        console.log('⏳ 等待服务条款弹窗...');
        const confirmBtn = page.locator('button#confirm-login');
        await confirmBtn.waitFor({ state: 'visible' });
        await confirmBtn.click();
        console.log('✅ 已接受服务条款');

        console.log('⏳ 等待跳转 Discord 登录页...');
        await page.waitForURL(/discord\.com\/login/);

        console.log('✏️ 填写账号密码...');
        await page.fill('input[name="email"]', DISCORD_EMAIL);
        await page.fill('input[name="password"]', DISCORD_PASSWORD);

        console.log('📤 提交登录请求...');
        await page.click('button[type="submit"]');
        await page.waitForTimeout(2000);

        if (/discord\.com\/login/.test(page.url())) {
            let err = '账密错误或触发了 2FA / 验证码';
            try { err = await page.locator('[class*="errorMessage"]').first().innerText(); } catch {}
            await sendTG(`❌ Discord 登录失败：${err}`);
            throw new Error(`❌ Discord 登录失败: ${err}`);
        }

        console.log('⏳ 等待 OAuth 授权...');
        try {
            await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 6000 });
            console.log('🔍 进入 OAuth 授权页，处理中...');
            await page.waitForTimeout(2000);
            await handleOAuthPage(page);
        } catch {
            console.log('✅ prompt=none 静默授权，无需手动点击');
        }

        console.log('⏳ 等待回调跳转...');
        await page.waitForURL(/free\.freezehost\.pro\/callback/);
        await page.waitForURL(/free\.freezehost\.pro\/dashboard/);
        console.log('✅ 登录成功！');

        // ── 续期 ──────────────────────────────────────────────
        console.log('🔍 查找 Manage 按钮...');
        const manageBtn = page.locator('a.bg-blue-600.text-white:has-text("Manage")').first();
        await manageBtn.waitFor({ state: 'visible' });
        await manageBtn.scrollIntoViewIfNeeded();
        await manageBtn.click();
        console.log('✅ 已点击 Manage');

        console.log('⏳ 等待进入 Server Console...');
        await page.waitForURL(/\/server-console/);
        console.log(`📄 Server Console: ${page.url()}`);

        console.log('🔍 查找 RENEW 按钮...');
        const renewBtn = page.locator('a#renew-link:has-text("RENEW")');
        await renewBtn.waitFor({ state: 'visible' });
        await renewBtn.click();
        console.log('📤 已点击 RENEW，等待结果...');

        await page.waitForURL(
            url => url.includes('/dashboard') || url.includes('/server-console'),
        );
        const finalUrl = page.url();
        console.log(`📄 最终跳转地址：${finalUrl}`);

        // ── 结果判断 ──────────────────────────────────────────
        if (finalUrl.includes('success=RENEWED')) {
            console.log('🎉 续期成功！');
            await sendTG('✅ 续期成功！');
            expect(finalUrl).toContain('success=RENEWED');

        } else if (finalUrl.includes('err=CANNOTAFFORDRENEWAL')) {
            console.log('⚠️ 余额不足，无法续期');
            await sendTG('⚠️ 余额不足，请前往挂机页面赚取金币');
            test.skip(true, '余额不足');

        } else {
            await sendTG(`⚠️ 续期结果未知：${finalUrl}`);
            throw new Error('续期结果未知，URL: ' + finalUrl);
        }

    } catch (e) {
        // 非 skip 的异常才推送
        if (!e.message?.includes('余额不足')) {
            await sendTG(`❌ 脚本异常：${e.message}`);
        }
        throw e;

    } finally {
        await browser.close();
    }
});
