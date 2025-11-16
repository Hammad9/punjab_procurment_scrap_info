import express from 'express';
import { scrapeAllPages } from './scraper.js';

const app = express();
app.get('/scrape', async (req,res)=>{
  try {
    const data = await scrapeAllPages({ headless: true });
    res.json({ success: true, count: data.length, tenders: data });
  } catch(e){
    res.status(500).json({ success:false, error: e.message });
  }
});
app.listen(3000);
