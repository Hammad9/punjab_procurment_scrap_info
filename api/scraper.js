// scraper.js
import puppeteer from "puppeteer";

function sleep(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function rowsHtmlSnapshot(page) {
  return page.$$eval('tr.rgRow, tr.rgAltRow', trs => trs.map(t => t.innerText).join('||'));
}

async function clickPageNumber(page, target) {
  // click anchor with exact text = target
  const anchors = await page.$$('a');
  for (const a of anchors) {
    const txt = (await (await a.getProperty('textContent')).jsonValue()).trim();
    if (txt === String(target)) {
      await a.click();
      return true;
    }
  }
  return false;
}

async function clickNext(page) {
  // possible selectors / titles for next
  const selectors = [
    'a[title="Next"]',
    'a[title=">>"]',
    'a.rgPageNext',
    'a[aria-label="Next"]'
  ];
  for (const sel of selectors) {
    const btn = await page.$(sel);
    if (btn) { await btn.click(); return true; }
  }
  // fallback: find anchor with >> or › character
  const anchors = await page.$$('a');
  for (const a of anchors) {
    const txt = (await (await a.getProperty('textContent')).jsonValue()).trim();
    if (txt === '»' || txt === '›' || txt.toLowerCase() === 'next') {
      await a.click();
      return true;
    }
  }
  return false;
}

async function extractRows(page, baseUrl) {
  await page.waitForSelector('tr.rgRow, tr.rgAltRow', { timeout: 15000 });
  const rows = await page.$$eval('tr.rgRow, tr.rgAltRow', (trs, base) => {
    // normalize to absolute URL
    const normalize = (h) => {
      if (!h) return '';
      try { return new URL(h, base).href; } catch { return h; }
    };
    return trs.map(tr => {
      const tds = Array.from(tr.querySelectorAll('td')).map(td => td.innerText.trim());
      const hrefs = Array.from(tr.querySelectorAll('a')).map(a => a.getAttribute('href')).filter(Boolean).map(normalize);
      return {
        notice_type: tds[0] || '',
        title: tds[1] || '',
        category: tds[2] || '',
        publish_date: tds[3] || '',
        closing_date: tds[4] || '',
        department: tds[5] || '',
        other_col_6: tds[6] || '',
        tender_notice_pdf: hrefs[0] || '',
        bidding_documents_pdf: hrefs[1] || ''
      };
    });
  }, baseUrl);
  return rows;
}

async function detectTotalItems(page) {
  // try to find text like "Showing 1 - 100 of 962 items" or pager info
  const txts = await page.$$eval('*', els => els.map(e => e.textContent || ''));
  // search for pattern with "of" and number
  for (const t of txts) {
    const m = t.match(/of\s+([\d,]+)/i);
    if (m) return parseInt(m[1].replace(/,/g,''), 10);
  }
  // try pager numeric anchors
  const nums = await page.$$eval('a', as => as.map(a => a.textContent.trim()).filter(t => /^\d+$/.test(t)).map(Number));
  if (nums.length) return null; // total items unknown but pages exist
  return null;
}

export async function scrapeAllPages(opts = {}) {
  const {
    startUrl = 'https://eproc.punjab.gov.pk/ActiveTenders.aspx',
    headless = true,
    delayBetweenPagesMs = 900,
    maxLoopPages = 200
  } = opts;

  const browser = await puppeteer.launch({
    headless,
    args: ['--no-sandbox','--disable-setuid-sandbox']
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
  await page.setExtraHTTPHeaders({'Accept-Language':'en-US,en;q=0.9'});
  page.setDefaultNavigationTimeout(60000);

  await page.goto(startUrl, { waitUntil: 'networkidle2' });

  const baseUrl = (new URL(startUrl)).origin;
  // snapshot to detect updates
  let prevSnapshot = await rowsHtmlSnapshot(page).catch(()=>'');
  let all = [];
  const seen = new Set();

  // Optional: detect total items (if provided)
  const detectedTotal = await detectTotalItems(page);
  console.log('Detected total items (may be null):', detectedTotal);

  // Strategy:
  // 1) Try to get numeric page links and max page.
  // 2) Loop: click page numbers sequentially if available; else repeatedly click Next until it fails or we detect no changes.
  // We'll guard with maxLoopPages.
  let pageCount = 0;
  // first, try to collect numeric page numbers present initially
  const numericPages = await page.$$eval('a', as => as.map(a => a.textContent.trim()).filter(t => /^\d+$/.test(t)).map(Number));
  let maxNumeric = numericPages.length ? Math.max(...numericPages) : null;
  if (maxNumeric) console.log('Pager numeric links found, highest shown:', maxNumeric);

  // We'll attempt two-phase: go through numeric pages 1..maxNumeric (click by number), then if Next exists keep clicking.
  // Phase A: numeric pages
  if (maxNumeric) {
    for (let p=1; p<=maxNumeric && pageCount < maxLoopPages; p++) {
      console.log('Phase A - navigate to page', p);
      // try clicking number if not page 1
      if (p === 1) {
        // already on page 1
      } else {
        const clicked = await clickPageNumber(page, p);
        if (!clicked) {
          // maybe numeric link is in another pager block, try Next until we reach p
          console.log('Numeric link not found for', p, '— trying Next fallback');
          const nextClicked = await clickNext(page);
          if (!nextClicked) { console.log('Cannot navigate to', p); break; }
        }
        // wait until rows change
        await page.waitForFunction(
          (prev) => {
            const trs = Array.from(document.querySelectorAll('tr.rgRow, tr.rgAltRow')).map(t=>t.innerText).join('||');
            return trs !== prev;
          },
          { timeout: 20000 },
          prevSnapshot
        ).catch(()=>{});
      }

      // small delay & extract
      await sleep(600);
      const rows = await extractRows(page, baseUrl);
      for (const r of rows) {
        const uid = (r.title||'') + '|' + (r.closing_date||'') + '|' + (r.department||'');
        if (!seen.has(uid)) { seen.add(uid); all.push(r); }
      }
      prevSnapshot = await rowsHtmlSnapshot(page).catch(()=>prevSnapshot);
      pageCount++;
      await sleep(delayBetweenPagesMs);
    }
  }

  // Phase B: continue clicking Next until no change or Next disabled
  let safety = 0;
  while (safety < maxLoopPages && pageCount < maxLoopPages) {
    console.log('Phase B - attempt Next click, iteration', safety+1);
    // try to click a page number that hasn't been visited — sometimes pager rotates; try to find numeric link not yet seen
    // If none, click Next
    const nextClicked = await clickNext(page);
    if (!nextClicked) {
      console.log('No Next button found — stopping');
      break;
    }

    // wait until rows change compared to prevSnapshot
    await page.waitForFunction(
      (prev) => {
        const trs = Array.from(document.querySelectorAll('tr.rgRow, tr.rgAltRow')).map(t=>t.innerText).join('||');
        return trs !== prev;
      },
      { timeout: 20000 },
      prevSnapshot
    ).catch(()=>{});

    await sleep(600);
    const rows = await extractRows(page, baseUrl);
    let newFound = 0;
    for (const r of rows) {
      const uid = (r.title||'') + '|' + (r.closing_date||'') + '|' + (r.department||'');
      if (!seen.has(uid)) { seen.add(uid); all.push(r); newFound++; }
    }
    console.log(`Next click yielded ${rows.length} rows, ${newFound} new`);
    prevSnapshot = await rowsHtmlSnapshot(page).catch(()=>prevSnapshot);
    safety++; pageCount++;
    await sleep(delayBetweenPagesMs);

    // Heuristic stop: if Next produced zero new rows for several iterations, break
    if (newFound === 0 && safety >= 4) {
      console.log('No new rows for several Next clicks — stopping.');
      break;
    }
  }

  await browser.close();
  console.log('Scraped total unique rows:', all.length);
  return all;
}
