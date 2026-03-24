// tests/freeze.spec.js
const { test, expect, chromium } = require('@playwright/test');
const https = require('https');

const [DISCORD_EMAIL, DISCORD_PASSWORD] = (process.env.DISCORD_ACCOUNT || ',').split(',');
const [TG_CHAT_ID, TG_TOKEN] = (process.env.TG_BOT || ',').split(',');

const TIMEOUT = 60000;

function nowStr() {
    return new Date().toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour12: false,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).replace(/\//g, '-');
}

function sendTG(serverResults) {
    return new Promise((resolve) => {
        if (!TG_CHAT_ID || !TG_TOKEN) {
            console.log('⚠️ TG_BOT 未配置，跳过推送');
            return resolve();
        }

        const lines = [
            `🎮 FreezeHost 续期通知`,
            `🕐 运行时间：${nowStr()}`,
            `👤 运行用户：${DISCORD_EMAIL}`,
        ];

        serverResults.forEach((srv, idx) => {
            lines.push(`\n🖥 服务器${idx + 1}：${srv.name}`);
            lines.push(`📊 续期结果：${srv.result}`);
        });

        const body = JSON.stringify({ chat_id: TG_CHAT_ID, text: lines.join('\n') });
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

async function handleOAuthPage(page) {
    console.log(`  📄 当前 URL: ${page.url()}`);
    await page.waitForTimeout(3000);

    const selectors = [
        'button:has-text("Authorize")',
        'button:has-text("授权")',
        'button[type="submit"]',
        'div[class*="footer"] button',
        'button[class*="primary"]',
    ];

    for (let i = 0; i < 8; i++) {
        console.log(`  🔄 第 ${i + 1} 次尝试，URL: ${page.url()}`);

        if (!page.url().includes('discord.com')) {
            console.log('  ✅ 已离开 Discord');
            return;
        }

        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
        await page.waitForTimeout(500);

        for (const selector of selectors) {
            try {
                const btn = page.locator(selector).last();
                const visible = await btn.isVisible();
                if (!visible) continue;

                const text = (await btn.innerText()).trim();
                console.log(`  🔘 找到按钮: "${text}" (${selector})`);

                if (text.includes('取消') || text.toLowerCase().includes('cancel') ||
                    text.toLowerCase().includes('deny')) continue;

                const disabled = await btn.isDisabled();
                if (disabled) {
                    console.log('  ⏳ 按钮 disabled，等待...');
                    break;
                }

                await btn.click();
                console.log(`  ✅ 已点击: "${text}"`);
                await page.waitForTimeout(2000);

                if (!page.url().includes('discord.com')) {
                    console.log('  ✅ 授权成功，已跳转');
                    return;
                }
                break;
            } catch { continue; }
        }

        await page.waitForTimeout(2000);
    }

    console.log(`  ⚠️ handleOAuthPage 结束，URL: ${page.url()}`);
}

/**
 * 解析续期状态文本，返回剩余天数描述字符串
 */
function parseRemainingInfo(statusText) {
    if (!statusText) return '';
    const daysMatch = statusText.match(/(\d+(?:\.\d+)?)\s*day/i);
    const hoursMatch = statusText.match(/(\d+(?:\.\d+)?)\s*hour/i);
    if (daysMatch) {
        return `（剩余 ${daysMatch[1]} 天${hoursMatch ? ' ' + hoursMatch[1] + ' 小时' : ''}）`;
    }
    return '';
}

/**
 * 对单台服务器执行续期逻辑
 * @param {import('@playwright/test').Page} page
 * @param {string} serverUrl  server-console 的绝对 URL
 * @returns {{ name: string, result: string }}
 */
async function renewServer(page, serverUrl) {
    console.log(`\n========== 开始处理：${serverUrl} ==========`);
    await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
    console.log(`✅ 已跳转到 Server Console: ${page.url()}`);

    // 从 URL 参数提取服务器 ID 作为名称
    const serverId = new URL(serverUrl).searchParams.get('id') || serverUrl;
    const serverName = `FreezeHost-${serverId}`;
    console.log(`🖥 服务器ID：${serverName}`);

    // ── 检查剩余时间 ──────────────────────────────────────────
    console.log('🔍 读取续期状态...');
    await page.waitForTimeout(2000);
    const renewalStatusText = await page.evaluate(() => {
        const el = document.getElementById('renewal-status-console');
        return el ? el.innerText.trim() : null;
    });
    console.log(`📋 续期状态：${renewalStatusText}`);

    if (renewalStatusText) {
        const daysMatch = renewalStatusText.match(/(\d+(?:\.\d+)?)\s*day/i);
        const remainingDays = daysMatch ? parseFloat(daysMatch[1]) : null;

        if (remainingDays !== null) {
            console.log(`⏳ 剩余天数：${remainingDays}`);
            // 剩余 7 天及以上无需续期，只有不足 7 天才执行续期
            if (remainingDays >= 7) {
                const remainingInfo = parseRemainingInfo(renewalStatusText);
                const msg = `⏰ 无需续期${remainingInfo}`;
                console.log(msg);
                return { name: serverName, result: msg };
            }
            console.log(`✅ 剩余 ${remainingDays} 天，需要续期，继续操作...`);
        } else {
            console.log('⚠️ 无法解析剩余天数，尝试继续续期...');
        }
    } else {
        console.log('⚠️ 未找到 renewal-status-console，尝试继续续期...');
    }

    // ── 点击 #renew-link-trigger 触发弹窗（稳定版）────────────
    console.log('🔍 点击 Renewal 触发按钮...');
    const renewTrigger = page.locator('#renew-link-trigger');
    await renewTrigger.waitFor({ state: 'visible', timeout: 15000 });
    await renewTrigger.click();
    console.log('✅ 已点击 Renewal 触发按钮');

    // ── 检查续期弹窗按钮状态 ──────────────────────────────────
    console.log('🔍 查找弹窗中的续期按钮...');
    const renewModalBtn = page.locator('#renew-link-modal');
    await renewModalBtn.waitFor({ state: 'visible', timeout: 10000 });

    const btnText = (await renewModalBtn.innerText()).trim();
    console.log(`📋 续期按钮文字："${btnText}"`);

    if (!btnText.toLowerCase().includes('renew instance')) {
        const msg = `⏰ 尚未到续期时间（按钮：${btnText}）`;
        console.log(msg);
        return { name: serverName, result: '⏰ 尚未到续期时间，今日已续期或暂不需要续期' };
    }

    // ── 点击续期按钮跳转 ────────────────────────────────────
    const renewHref = await renewModalBtn.getAttribute('href');
    if (!renewHref || renewHref === '#') {
        throw new Error(`❌ renew-link-modal href 无效：${renewHref}`);
    }

    const renewAbsUrl = new URL(renewHref, page.url()).href;
    console.log(`✅ 找到 RENEW 链接：${renewAbsUrl}`);
    await page.goto(renewAbsUrl, { waitUntil: 'domcontentloaded' });
    console.log('📤 已跳转 RENEW，等待结果...');

    await page.waitForURL(
        url => url.toString().includes('/dashboard') || url.toString().includes('/server-console'),
        { timeout: 30000 }
    );
    const finalUrl = page.url();

    // ── 结果判断 ────────────────────────────────────────────
    if (finalUrl.includes('success=RENEWED')) {
        console.log('🎉 续期成功！回读最新剩余天数...');

        // 跳回 server-console 重新读取最新剩余天数
        await page.goto(serverUrl, { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000);

        const freshStatus = await page.evaluate(() => {
            const el = document.getElementById('renewal-status-console');
            return el ? el.innerText.trim() : null;
        });
        console.log(`📋 续期后状态：${freshStatus}`);

        const remainingInfo = parseRemainingInfo(freshStatus);
        return { name: serverName, result: `✅ 续期成功！${remainingInfo}` };

    } else if (finalUrl.includes('err=CANNOTAFFORDRENEWAL')) {
        console.log('⚠️ 余额不足，无法续期');
        return { name: serverName, result: '⚠️ 余额不足，请前往挂机页面赚取金币' };

    } else if (finalUrl.includes('err=TOOEARLY')) {
        console.log('⏰ 尚未到续期时间');
        return { name: serverName, result: '⏰ 尚未到续期时间，今日已续期或暂不需要续期' };

    } else {
        return { name: serverName, result: `⚠️ 续期结果未知：${finalUrl}` };
    }
}

test('FreezeHost 自动续期', async () => {
    if (!DISCORD_EMAIL || !DISCORD_PASSWORD) {
        throw new Error('❌ 缺少 DISCORD_ACCOUNT，格式: email,password');
    }

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

    const serverResults = [];

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
            await sendTG([{ name: 'N/A', result: `❌ Discord 登录失败：${err}` }]);
            throw new Error(`❌ Discord 登录失败: ${err}`);
        }

        // ── OAuth 授权 ────────────────────────────────────────
        console.log('⏳ 等待 OAuth 授权...');
        try {
            await page.waitForURL(/discord\.com\/oauth2\/authorize/, { timeout: 6000 });
            console.log('🔍 进入 OAuth 授权页，处理中...');
            await page.waitForTimeout(2000);

            if (page.url().includes('discord.com')) {
                await handleOAuthPage(page);
            } else {
                console.log('✅ 已自动完成授权，无需手动点击');
            }

            await page.waitForURL(/free\.freezehost\.pro/, { timeout: 15000 });
            console.log(`✅ 已离开 Discord，当前：${page.url()}`);
        } catch {
            console.log(`✅ 静默授权或已跳转，当前：${page.url()}`);
        }

        // ── 确认到达 Dashboard ────────────────────────────────
        console.log('⏳ 确认到达 Dashboard...');
        try {
            await page.waitForURL(
                url => url.includes('/callback') || url.includes('/dashboard'),
                { timeout: 10000 }
            );
        } catch { /* 可能已经在 dashboard */ }

        if (page.url().includes('/callback')) {
            await page.waitForURL(/free\.freezehost\.pro\/dashboard/);
        }

        if (!page.url().includes('/dashboard')) {
            throw new Error(`❌ 未到达 Dashboard，当前 URL: ${page.url()}`);
        }
        console.log(`✅ 登录成功！当前：${page.url()}`);

        // ── 收集所有 server-console 链接 ─────────────────────
        console.log('🔍 收集所有 server-console 链接...');
        await page.waitForTimeout(3000);

        const serverUrls = await page.evaluate(() => {
            return Array.from(document.querySelectorAll('a[href*="server-console"]'))
                .map(a => a.href)
                .filter((v, i, arr) => arr.indexOf(v) === i); // 去重
        });

        if (serverUrls.length === 0) {
            throw new Error('❌ 未找到任何 server-console 链接');
        }
        console.log(`✅ 共发现 ${serverUrls.length} 台服务器：${serverUrls.join(', ')}`);

        // ── 逐台续期 ──────────────────────────────────────────
        for (const url of serverUrls) {
            try {
                const result = await renewServer(page, url);
                serverResults.push(result);
            } catch (e) {
                console.log(`❌ 处理 ${url} 时出错：${e.message}`);
                serverResults.push({ name: url, result: `❌ 处理异常：${e.message}` });
            }
        }

        // ── 统一发送 TG 通知 ──────────────────────────────────
        await sendTG(serverResults);

        // ── 最终断言 ──────────────────────────────────────────
        const hasFailure = serverResults.some(r =>
            r.result.startsWith('❌') && !r.result.includes('余额不足')
        );
        if (hasFailure) {
            throw new Error('部分服务器续期失败，详见 TG 通知');
        }

    } catch (e) {
        if (serverResults.length === 0) {
            await sendTG([{ name: 'N/A', result: `❌ 脚本异常：${e.message}` }]);
        }
        throw e;

    } finally {
        await browser.close();
    }
});
