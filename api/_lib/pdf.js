import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

// Every email Lumen sends carries a PDF copy of itself.
//
// The PDF is the email's own HTML printed by a headless Chromium, so it
// looks exactly like the message, Arabic included — a PDF library that
// draws text itself gets right-to-left text and joined Arabic letters
// wrong, and the students' names are often in Arabic.
//
// On Vercel the browser is @sparticuz/chromium. On a Mac (trying it out
// locally) it is the installed Google Chrome. The fonts are bundled
// beside this file: Noto Sans for the Latin, Noto Naskh Arabic for the
// Arabic, so nothing is left to whatever the server happens to have.
//
// This never throws. A PDF that cannot be made is logged and the email
// goes without it: the message matters more than its copy.
// Set LUMEN_PDF=off to skip it (the tests do).

const FONTS = [
  new URL('./fonts/NotoSans.ttf', import.meta.url),
  new URL('./fonts/NotoNaskhArabic.ttf', import.meta.url),
];
const MAC_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const TIMEOUT_MS = 20000;

let browserPromise = null;
export let lastPdfError = null;   // why the last PDF was not made, for the send result

async function browser() {
  if (browserPromise) return browserPromise;
  browserPromise = (async () => {
    const puppeteer = (await import('puppeteer-core')).default;
    if (process.platform === 'darwin' && existsSync(MAC_CHROME)) {
      return puppeteer.launch({ executablePath: MAC_CHROME, headless: true, args: ['--no-sandbox'] });
    }
    const chromium = (await import('@sparticuz/chromium')).default;
    for (const f of FONTS) await chromium.font(fileURLToPath(f));
    return puppeteer.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: true,
      defaultViewport: { width: 760, height: 1100 },
    });
  })();
  browserPromise.catch(() => { browserPromise = null; });
  return browserPromise;
}

// The fonts, named so the page can ask for them first.
const FONT_CSS = `
  @font-face { font-family: 'Lumen Sans'; src: url('${FONTS[0].href}'); font-weight: 100 900; }
  @font-face { font-family: 'Lumen Arabic'; src: url('${FONTS[1].href}'); font-weight: 400 700; }
  html, body, table, td, div, p, span, h1, h2, h3, a { font-family: 'Lumen Sans', 'Lumen Arabic', -apple-system, Arial, sans-serif !important; }
  [dir="rtl"], [dir="rtl"] * { font-family: 'Lumen Arabic', 'Lumen Sans', sans-serif !important; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  a[href]::after { content: none; }`;

function withTimeout(promise, ms) {
  return Promise.race([promise, new Promise((_, rej) => setTimeout(() => rej(new Error('PDF timed out')), ms))]);
}

export async function htmlToPdf(html) {
  if ((process.env.LUMEN_PDF || '').toLowerCase() === 'off') return null;
  let page = null;
  lastPdfError = null;
  try {
    const b = await withTimeout(browser(), TIMEOUT_MS);
    page = await b.newPage();
    // file:// fonts from the bundle: the page is set as content, so it is
    // given a file:// origin it can load them from.
    const doc = html.includes('</head>')
      ? html.replace('</head>', `<style>${FONT_CSS}</style></head>`)
      : `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${FONT_CSS}</style></head><body>${html}</body></html>`;
    await withTimeout(page.setContent(doc, { waitUntil: 'load' }), TIMEOUT_MS);
    await page.evaluate(() => document.fonts && document.fonts.ready);
    const pdf = await withTimeout(page.pdf({
      format: 'A4', printBackground: true,
      margin: { top: '12mm', bottom: '12mm', left: '8mm', right: '8mm' },
    }), TIMEOUT_MS);
    return Buffer.from(pdf);
  } catch (err) {
    console.error('PDF not made:', err?.message || err);
    lastPdfError = String(err?.message || err).slice(0, 300);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// A file name from an email subject: "S2 (Senior 2) — marks before Friday"
// -> "S2-Senior-2-marks-before-Friday.pdf". Arabic letters are kept.
export function pdfName(subject) {
  const base = String(subject || 'Lumen')
    .replace(/\[TEST\]\s*/i, 'TEST-')
    .replace(/[^\p{L}\p{N}\- ]+/gu, ' ')
    .trim().replace(/\s+/g, '-').slice(0, 80);
  return (base || 'Lumen') + '.pdf';
}
