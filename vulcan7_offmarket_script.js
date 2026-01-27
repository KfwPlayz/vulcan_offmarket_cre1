const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const EXEC_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser";

const CONTACTS_SHELL_URL = "https://www.vulcan7dialer.com/cm/index#params/dmlld19pZD05ODEzOCZwYWdlPTE=";
const LOGIN_URL = "https://www.vulcan7dialer.com/login";
const FOLDER_URL = "https://www.vulcan7dialer.com/cm/folders/index";
const CACHE_FILE = path.join(__dirname, "sent-leads-cache-offmarket.json");

// Dynamic folder name
const today = new Date();
const monday = new Date(today.setDate(today.getDate() - ((today.getDay() + 6) % 7)));
const folderName = `Expired Leads Week of ${monday.getMonth() + 1}.${monday.getDate()}`;

// Helper
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeText = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

function buildGoogleMapsLink({ street, city, state, zip }) {
  const parts = [street, city, state, zip].filter(Boolean).join(", ");
  if (!parts.trim()) return "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts)}`;
}

async function clickFolderByName(page, name) {
  const lower = name.trim().toLowerCase();
  await page.waitForFunction(
    (lowerName) => {
      const els = Array.from(document.querySelectorAll("div.contacts-folder-nav-name"));
      return els.some((el) => (el.textContent || "").trim().toLowerCase() === lowerName);
    },
    { timeout: 30000 },
    lower
  );

  const clicked = await page.evaluate((lowerName) => {
    const els = Array.from(document.querySelectorAll("div.contacts-folder-nav-name"));
    const target = els.find((el) => (el.textContent || "").trim().toLowerCase() === lowerName);
    if (target) {
      target.click();
      return true;
    }
    return false;
  }, lower);

  if (!clicked) throw new Error(`Could not click folder "${name}" in left nav`);
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: EXEC_PATH,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"],
  });

  const page = await browser.newPage();
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

  try {
    if (!EMAIL || !PASSWORD || !WEBHOOK_URL) throw new Error("Missing EMAIL, PASSWORD, or WEBHOOK_URL");

    // Log in
await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector('input[name="email"], #email, input[name="username"]');
await page.waitForSelector('input[name="password"], #password');

const emailSel = (await page.$('input[name="email"]')) ? 'input[name="email"]' : (await page.$("#email")) ? "#email" : 'input[name="username"]';
const passSel = (await page.$('input[name="password"]')) ? 'input[name="password"]' : "#password";

await page.type(emailSel, EMAIL, { delay: 20 });
await page.type(passSel, PASSWORD, { delay: 20 });

await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 120000 }),
      page.click('button[type="submit"], .login-button')
    ]);
await page.screenshot({ path: "post-login.png", fullPage: true });


    // Go to contacts and click Off Market
    await page.goto(CONTACTS_SHELL_URL, { waitUntil: "domcontentloaded" });
    await sleep(2000);
    await clickFolderByName(page, "Off Market");
    await sleep(2000);

    // Wait for leads to load
    await page.waitForFunction(() => {
      const gridLoaded = document.querySelectorAll("tr[data-itemid]").length > 0;
      const noResults = (document.body.innerText || "").toLowerCase().includes("no contacts");
      return gridLoaded || noResults;
    }, { timeout: 15000 });

    const leads = await page.evaluate(() => {
      const safeText = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
      let nodes = Array.from(document.querySelectorAll("tr[data-itemid]"));
      if (!nodes.length) nodes = Array.from(document.querySelectorAll("[data-itemid]"));

      const results = [];

      for (const node of nodes) {
        const id = node.getAttribute("data-itemid");
        if (!id) continue;

        let nameEl = node.querySelector(".contact-details-link a") || node.querySelector("a[href*='#contact/']");
        const fullName = safeText(nameEl);
        if (!fullName) continue;

        const phoneDiv = document.querySelector(`div[id='cell-example-${id}-143332']`);
        const phone = safeText(phoneDiv) || "";
        const emailEl = document.querySelector(`div[id='cell-example-${id}-143333'] a[href^='mailto:']`);
        const email = (emailEl?.getAttribute("href") || "").replace("mailto:", "").trim();

        let phone2 = phone;
        if (!phone2) {
          const text = safeText(node);
          const m = text.match(/(\(\d{3}\)\s*\d{3}-\d{4})/);
          phone2 = m ? m[1] : "";
        }

        let email2 = email;
        if (!email2) {
          const m = safeText(node).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
          email2 = m ? m[0] : "";
        }

        const nameParts = fullName.split(" ");
        results.push({
          full_name: fullName,
          first_name: nameParts[0] || "",
          last_name: nameParts.slice(1).join(" "),
          phone: phone2 || "",
          email: email2 || "",
          contact_id: id,
        });
      }
      return results;
    });

    console.log(`✅ Found ${leads.length} leads`);

    // Deduplicate
    const seen = new Set(), filtered = [];
    for (const lead of leads) {
      const key = `${lead.full_name}|${lead.phone}`;
      if (!seen.has(key)) {
        seen.add(key);
        filtered.push(lead);
      }
    }

    // Load cache
    let sentCache = new Set();
    if (fs.existsSync(CACHE_FILE)) {
      try {
        sentCache = new Set(JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")));
      } catch {}
    }

    const unsentLeads = [], newKeys = [];
    for (const lead of filtered) {
      const key = `${lead.full_name}|${lead.phone}`;
      if (!sentCache.has(key)) {
        unsentLeads.push(lead);
        newKeys.push(key);
      }
    }

    // Visit detail pages and scrape additional info
    for (const lead of unsentLeads) {
      const detailPage = await browser.newPage();
      try {
        await detailPage.goto(`https://www.vulcan7dialer.com/cm/index#contact/${lead.contact_id}`, { waitUntil: "domcontentloaded" });
        await sleep(1200);

        const detailData = await detailPage.evaluate(() => {
          const safeText = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
          const normLabel = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").replace(/:$/, "").trim();

          const all = Array.from(document.querySelectorAll("*"));
          const getByLabel = (label) => {
            const want = normLabel(label);
            const el = all.find((el) => normLabel(safeText(el)) === want);
            if (!el) return "";
            const sib = el.nextElementSibling;
            return sib ? safeText(sib) : "";
          };

          const propertyType = getByLabel("Property Type");
          const mlsNumber = getByLabel("MLS Number");
          const mlsStatus = getByLabel("MLS Status");
          const listPrice = getByLabel("List Price");
          const beds = getByLabel("Beds");
          const baths = getByLabel("Baths");
          const squareFootage = getByLabel("Square Footage");
          const daysOnMarket = getByLabel("Days On Market");

          const links = Array.from(document.querySelectorAll("a[href]")).map(a => a.getAttribute("href") || "");
          const zillow = links.find(h => h.includes("zillow.com")) || "";
          const maps = links.find(h => h.includes("maps.google")) || "";

          return {
            property_type: propertyType, mls_number: mlsNumber, mls_status: mlsStatus,
            list_price: listPrice, beds, baths, square_footage: squareFootage, days_on_market: daysOnMarket,
            zillow_link: zillow, google_maps_link: maps,
          };
        });

        Object.assign(lead, detailData);
      } catch (err) {
        console.warn(`⚠️ Failed to fetch extra info for ${lead.full_name}: ${err.message}`);
      } finally {
        await detailPage.close();
        await sleep(200);
      }
    }

    // Send to webhook
    for (const lead of unsentLeads) {
      try {
        await axios.post(WEBHOOK_URL, { lead });
        console.log(`📤 Sent: ${lead.full_name}`);
      } catch (err) {
        console.warn(`❌ Failed to send ${lead.full_name}: ${err.message}`);
      }
    }

    // Save updated cache
    const updatedCache = [...sentCache, ...newKeys];
    fs.writeFileSync(CACHE_FILE, JSON.stringify(updatedCache, null, 2));
  } catch (err) {
    console.error("❌ Script Error:", err);
    try {
      await page.screenshot({ path: "failure.png", fullPage: true });
    } catch {}
  } finally {
    await browser.close();
  }
})();
