// Instagram Cookie Login — a custom Apify actor.
// Input:  { username, password, code?, proxyConfiguration? }
// Output: one dataset item { ok, username, cookies: [ {name, value, domain, ...} ] }
//         containing the 3 cookies the QuickAds app needs
//         (sessionid, ds_user_id, csrftoken).
import { Actor } from 'apify';
import { chromium } from 'playwright';

const REQUIRED = ['sessionid', 'ds_user_id', 'csrftoken'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

async function login(browser, input) {
  const username = String(input.username || '').replace(/^@/, '');
  const password = String(input.password || '');
  const code = input.code ? String(input.code) : '';

  const contextOptions = { userAgent: UA, viewport: { width: 1280, height: 800 }, locale: 'en-US' };

  // Route the browser through an Apify proxy if configured. Residential is
  // strongly recommended — Instagram frequently challenges datacenter IPs.
  const proxyConfiguration = await Actor.createProxyConfiguration(input.proxyConfiguration);
  if (proxyConfiguration) {
    const url = await proxyConfiguration.newUrl();
    const u = new URL(url);
    contextOptions.proxy = {
      server: `${u.protocol}//${u.host}`,
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
  }

  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();

  await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Dismiss the EU cookie-consent dialog if it shows.
  try { await page.click('button:has-text("Allow all cookies"), button:has-text("Accept")', { timeout: 4000 }); } catch (_) {}

  await page.fill('input[name="username"]', username, { timeout: 20000 });
  await page.fill('input[name="password"]', password);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(6000);

  // Handle a 2FA prompt if one appears.
  const twoFA = await page.$('input[name="verificationCode"]');
  if (twoFA) {
    if (!code) {
      return { ok: false, needs2fa: true, message: 'Instagram asked for a 2FA code. Re-run with the code field filled.' };
    }
    await page.fill('input[name="verificationCode"]', code);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(6000);
  }

  const url = page.url();
  const body = (await page.textContent('body').catch(() => '')) || '';
  const cookies = await context.cookies();
  const sessionid = cookies.find(c => c.name === 'sessionid' && c.value);

  if (!sessionid) {
    if (/challenge|checkpoint|verify it.s you|suspicious|two[_-]?factor/i.test(url + body)) {
      return { ok: false, message: 'Instagram checkpoint/2FA challenge blocked the login. Use residential proxy and/or a 2FA code.' };
    }
    if (/incorrect|wasn.t right|find your account|couldn.t find/i.test(body)) {
      return { ok: false, message: 'Instagram rejected the username or password.' };
    }
    return { ok: false, message: 'Login did not produce a session (no sessionid). URL: ' + url };
  }

  const out = cookies
    .filter(c => REQUIRED.includes(c.name))
    .map(c => ({
      name: c.name,
      value: c.value,
      domain: c.domain || '.instagram.com',
      path: c.path || '/',
      secure: c.secure !== false,
      httpOnly: !!c.httpOnly,
      sameSite: c.sameSite || 'Lax',
      ...(c.expires && c.expires > 0 ? { expirationDate: c.expires } : {}),
    }));

  return { ok: true, username, cookies: out };
}

await Actor.init();
const input = (await Actor.getInput()) ?? {};

if (!input.username || !input.password) {
  await Actor.pushData({ ok: false, message: 'username and password are required.' });
  await Actor.exit();
}

let result;
const browser = await chromium.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
});
try {
  result = await login(browser, input);
} catch (err) {
  result = { ok: false, message: 'Login error: ' + err.message };
} finally {
  await browser.close();
}

await Actor.pushData(result);
await Actor.exit();
