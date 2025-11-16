import express from "express";
import chromium from "chrome-aws-lambda";
import puppeteer from "puppeteer-core";

const app = express();

app.get("/", async (req, res) => {
  let browser = null;

  try {
    const executablePath = await chromium.executablePath;

    browser = await puppeteer.launch({
      executablePath: executablePath,
      args: chromium.args,
      headless: chromium.headless,
      defaultViewport: chromium.defaultViewport
    });

    const page = await browser.newPage();
    await page.goto("https://eproc.punjab.gov.pk/ActiveTenders.aspx", {
      waitUntil: "networkidle2",
      timeout: 0
    });

    await page.waitForSelector(".rgRow");

    const allData = [];

    // Loop through 10 pages
    for (let i = 1; i <= 10; i++) {
      const pageData = await page.evaluate(() => {
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

      allData.push(...pageData);

      const nextBtn = await page.$(".rgPageNext");
      if (!nextBtn) break;

      await nextBtn.click();
      await page.waitForTimeout(3000);
      await page.waitForSelector(".rgRow");
    }

    res.json({
      success: true,
      count: allData.length,
      data: allData
    });

  } catch (error) {
    res.json({ success: false, error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(3000, () => console.log("Scraper API running on port 3000"));
