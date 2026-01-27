// 📌 Required Libraries
const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// Small helper that works on every Node/Puppeteer version
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 🔐 Credentials and Constants
const LOGIN_URL = "https://www.vulcan7dialer.com/login";
const CONTACTS_URL = "https://www.vulcan7dialer.com/cm/index#params/dmlld19pZD05ODEzOCZwYWdlPTE=";
const FOLDER_URL = "https://www.vulcan7dialer.com/cm/folders/index";
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const CACHE_FILE = path.join(__dirname, "sent-leads-cache-offmarket.json");

// 📅 Folder name = Monday of current week
const today = new Date();
const day = today.getDay();
const offset = (day === 0) ? -6 : 1 - day;
const monday = new Date(today);
monday.setDate(today.getDate() + offset);
const folderName = `Expired Leads Week of ${monday.getMonth() + 1}.${monday.getDate()}`;

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process"
    ]
  });

  const page = await browser.newPage();

  // === CI hardening: timeouts, UA, resource blocking, logs ===
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);

  await page.setUserAgent(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123 Safari/537.36"
  );
  await page.setViewport({ width: 1366, height: 768 });

  await page.setRequestInterception(true);
  page.on("request", req => {
    const type = req.resourceType();
    if (type === "image" || type === "font" || type === "media") req.abort();
    else req.continue();
  });

  page.on("console", msg => console.log("[BROWSER]", msg.type(), msg.text()));
  page.on("pageerror", err => console.log("[PAGEERROR]", err));
  page.on("requestfailed", req => console.log("[REQ FAILED]", req.url(), req.failure()?.errorText));
  // === end CI hardening ===

  try {
    // 🔐 Log in to Vulcan7
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector('input[name="email"], #email, input[name="username"]', { timeout: 120000 });
    await page.waitForSelector('input[name="password"], #password', { timeout: 120000 });

    const emailSel = (await page.$('input[name="email"]')) ? 'input[name="email"]'
                     : (await page.$('#email')) ? '#email'
                     : 'input[name="username"]';
    const passSel  = (await page.$('input[name="password"]')) ? 'input[name="password"]' : '#password';

    await page.type(emailSel, EMAIL, { delay: 20 });
    await page.type(passSel,  PASSWORD, { delay: 20 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 120000 }),
      page.click('button[type="submit"], .login-button')
    ]);

    // ✅ Scrape contacts from Off Market folder
    await page.goto(CONTACTS_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector("tr[data-itemid]", { timeout: 120000 });
    await sleep(1500);

    const leads = await page.evaluate(() => {
      const rows = document.querySelectorAll("tr[data-itemid]");
      const leads = [];

      for (const row of rows) {
        const id = row.getAttribute("data-itemid");
        const nameEl = row.querySelector(".contact-details-link a");
        const fullName = nameEl?.innerText?.trim();
        if (!fullName) continue;

        const phoneDiv = document.querySelector(`div[id='cell-example-${id}-143332']`);
        const phone = phoneDiv?.innerText?.trim() || "";

        const emailEl = document.querySelector(`div[id='cell-example-${id}-143333'] a[href^='mailto:']`);
        const email = emailEl?.getAttribute("href")?.replace("mailto:", "").trim() || "";

        const nameParts = fullName.split(" ");
        leads.push({
          full_name: fullName,
          first_name: nameParts[0] || "",
          last_name: nameParts.slice(1).join(" "),
          phone,
          email,
          contact_id: id
        });
      }

      return leads;
    });

    console.log(`✅ Found ${leads.length} raw leads in "Off Market"`);

    // 📥 Deduplication
    const seen = new Set(), filtered = [], dupes = [];
    for (const lead of leads) {
      const key = `${lead.full_name}|${lead.phone}`;
      if (lead.full_name.toLowerCase() === "possible owner" || !seen.has(key)) {
        seen.add(key);
        filtered.push(lead);
      } else {
        dupes.push(lead);
      }
    }

    // 🧠 Load cache
    let sentCache = new Set();
    if (fs.existsSync(CACHE_FILE)) {
      try {
        sentCache = new Set(JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")));
      } catch { /* ignore bad cache */ }
    }

    const unsentLeads = [], newKeys = [];
    for (const lead of filtered) {
      const key = `${lead.full_name}|${lead.phone}`;
      if (!sentCache.has(key)) {
        unsentLeads.push(lead);
        newKeys.push(key);
      }
    }

    // 🔍 Visit each contact detail page to fetch address + extra property info
for (const lead of unsentLeads) {
  const detailPage = await browser.newPage();
  try {
    const detailUrl = `https://www.vulcan7dialer.com/cm/index#contact/${lead.contact_id}`;
    await detailPage.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
    await sleep(1200);

    const detailData = await detailPage.evaluate(() => {
      const safeText = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
      const norm = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").replace(/:$/, "").trim();

      // ---- ADDRESS ----
      let address = { street: "", city: "", state: "", zip: "" };
      const addrEl = document.querySelector('a[data-type="address"]');
      if (addrEl) {
        try {
          const data = JSON.parse(addrEl.getAttribute("data-value") || "{}");
          address = {
            street: data.address || "",
            city: data.city || "",
            state: data.state || "",
            zip: data.zip || ""
          };
        } catch {}
      }

      // ---- GENERIC LABEL → VALUE SCRAPER ----
      const all = Array.from(document.querySelectorAll("*"));
      const getByLabel = (label) => {
        const want = norm(label);
        const el = all.find(e => norm(safeText(e)) === want);
        if (!el) return "";
        const row = el.closest("tr") || el.parentElement;
        if (!row) return "";
        const parts = Array.from(row.querySelectorAll("td,th,div,span"))
          .map(safeText)
          .filter(Boolean);
        const idx = parts.findIndex(t => norm(t) === want);
        return (idx >= 0 && parts[idx + 1]) ? parts[idx + 1] : "";
      };

      // ---- PROPERTY FIELDS ----
      const property_type = getByLabel("Property Type");
      const mls_number = getByLabel("MLS Number");
      const mls_status = getByLabel("MLS Status");
      const status_change_date = getByLabel("Status Change Date");
      const list_price = getByLabel("List Price");
      const beds = getByLabel("Beds");
      const baths = getByLabel("Baths");
      const square_footage = getByLabel("Square Footage");
      const days_on_market = getByLabel("Days On Market");
      const listing_agent = getByLabel("Listing Agent");
      const listing_office = getByLabel("Listing Office");

      // ---- LINKS ----
      const links = Array.from(document.querySelectorAll("a[href]"))
        .map(a => a.getAttribute("href"))
        .filter(Boolean);

      const zillow_link = links.find(h => /zillow\.com/i.test(h)) || "";
      const google_maps_link =
        links.find(h => /google\.(com|ca)\/maps/i.test(h)) ||
        links.find(h => /maps\.google/i.test(h)) ||
        "";

      return {
        address,
        property_type,
        mls_number,
        mls_status,
        status_change_date,
        list_price,
        beds,
        baths,
        square_footage,
        days_on_market,
        listing_agent,
        listing_office,
        zillow_link,
        google_maps_link
      };
    });

    // ---- MERGE INTO LEAD (SAFE DEFAULTS) ----
    Object.assign(
      lead,
      {
        street: "",
        city: "",
        state: "",
        zip: "",
        property_type: "",
        mls_number: "",
        mls_status: "",
        status_change_date: "",
        list_price: "",
        beds: "",
        baths: "",
        square_footage: "",
        days_on_market: "",
        listing_agent: "",
        listing_office: "",
        zillow_link: "",
        google_maps_link: ""
      },
      detailData.address || {},
      detailData
    );

  } catch (err) {
    console.error(`⚠️ Detail fetch failed for ${lead.full_name}: ${err.message}`);
    try {
      await detailPage.screenshot({ path: `failure_${lead.contact_id}.png`, fullPage: true });
    } catch {}
  } finally {
    await detailPage.close();
    await sleep(300);
  }
}


    // 📤 Send to Zapier
    for (const lead of unsentLeads) {
      try {
        await axios.post(WEBHOOK_URL, { timestamp: new Date().toISOString(), lead });
        console.log(`📤 Sent: ${lead.full_name}`);
      } catch (err) {
        console.error(`❌ Failed to send ${lead.full_name}: ${err.message}`);
      }
    }

    // 💾 Save updated cache
    const updatedCache = [...sentCache, ...newKeys];
    fs.writeFileSync(CACHE_FILE, JSON.stringify(updatedCache, null, 2));
})();
