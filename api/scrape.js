import chromium from "@sparticuz/chromium";
import puppeteer from "puppeteer-core";

export default async function handler(req, res) {
  let browser;

  try {
    const executablePath = await chromium.executablePath;

    browser = await puppeteer.launch({
      executablePath,
      args: chromium.args,
      headless: chromium.headless,
    });

    const page = await browser.newPage();

    await page.goto("https://eproc.punjab.gov.pk/ActiveTenders.aspx", {
      waitUntil: "networkidle2",
      timeout: 0
    });

    await page.waitForSelector(".rgRow");

    let allData = [];
    let currentPage = 1;

    while (true) {
      console.log(`Scraping page ${currentPage}`);

      const data = await page.evaluate(() => {
        const rows = [...document.querySelectorAll(".rgRow")];

        return rows.map(row => {
          const tds = [...row.querySelectorAll("td")];
          return {
            category: tds[0]?.innerText.trim(),
            title: tds[1]?.innerText.trim(),
            type: tds[2]?.innerText.trim(),
            publishDate: tds[3]?.innerText.trim(),
            closingDate: tds[4]?.innerText.trim(),
            department: tds[5]?.innerText.trim(),
            tenderNotice: tds[7]?.querySelector("a")?.href || "",
            biddingDocs: tds[8]?.querySelector("a")?.href || ""
          };
        });
      });

      allData.push(...data);

      // NEXT button
      const nextBtn = await page.$(".rgPageNext");

      if (!nextBtn) break; // no more pages

      await nextBtn.click();
      await page.waitForTimeout(3000);
      await page.waitForSelector(".rgRow");

      currentPage++;
    }

    res.status(200).json({
      success: true,
      count: allData.length,
      data: allData
    });

  } catch (err) {
    res.status(500).json({
      success: false,
      error: err.message
    });
  } finally {
    if (browser) await browser.close();
  }
}
