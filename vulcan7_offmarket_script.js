// 📌 Required Libraries
const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// 🔧 Helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 🔐 Credentials and Constants
const LOGIN_URL = "https://www.vulcan7dialer.com/login";
const CONTACTS_SHELL_URL = "https://www.vulcan7dialer.com/cm/index#contacts";
const FOLDER_URL = "https://www.vulcan7dialer.com/cm/folders/index";
const OFF_MARKET_FOLDER_LINK = "https://www.vulcan7dialer.com/cm/index#params/dmlld19pZD05ODEzOCZwYWdlPTE=";

const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const EXEC_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser";

const CACHE_FILE = path.join(__dirname, "sent-leads-cache-offmarket.json");

// 📅 Folder name
const today = new Date();
const offset = today.getDay() === 0 ? -6 : 1 - today.getDay();
const monday = new Date(today.setDate(today.getDate() + offset));
const folderName = `Expired Leads Week of ${monday.getMonth() + 1}.${monday.getDate()}`;

// 🗺️ Google Maps fallback link
function buildGoogleMapsLink({ street, city, state, zip }) {
  const parts = [street, city, state, zip].filter(Boolean).join(", ");
  return parts ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts)}` : "";
}

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: EXEC_PATH,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
    ],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);
  await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123 Safari/537.36");

  try {
    if (!EMAIL || !PASSWORD || !WEBHOOK_URL) throw new Error("Missing EMAIL, PASSWORD, or WEBHOOK_URL");

    // Login
    await page.goto(LOGIN_URL);
    await page.waitForSelector('input[name="email"], #email, input[name="username"]');
    await page.waitForSelector('input[name="password"], #password');

    const emailSel =
      (await page.$('input[name="email"]')) ? 'input[name="email"]' :
      (await page.$("#email")) ? "#email" :
      'input[name="username"]';
    const passSel = (await page.$('input[name="password"]')) ? 'input[name="password"]' : "#password";

    await page.type(emailSel, EMAIL, { delay: 20 });
    await page.type(passSel, PASSWORD, { delay: 20 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click('button[type="submit"], .login-button'),
    ]);

    const url = page.url();
    if (url.includes("/login")) throw new Error("Login failed");

    // Go to Off Market folder directly
    await page.goto(OFF_MARKET_FOLDER_LINK);
    await page.waitForSelector("[data-itemid]");

    // Get contact links
    const contactSelectors = await page.$$eval("[data-itemid] a[href]", anchors =>
      anchors.map(a => ({ id: a.closest("[data-itemid]")?.getAttribute("data-itemid"), href: a.href }))
    );

    const leads = [];
    for (const contact of contactSelectors) {
      await page.goto(contact.href);
      await page.waitForSelector(".contact-details", { timeout: 15000 }).catch(() => {});
      await sleep(1000);

      const lead = await page.evaluate(() => {
        const get = (selector) => document.querySelector(selector)?.textContent?.trim() || "";
        const getHref = (selector) => document.querySelector(selector)?.href || "";

        const address = get(".contact-details .address") || "";
        const [street, city, stateZip] = address.split(",").map((s) => s.trim());
        const [state, zip] = (stateZip || "").split(" ").map((s) => s.trim());

        return {
          full_name: get(".contact-name") || "",
          phone: get(".contact-phone") || "",
          email: getHref("a[href^='mailto:']").replace("mailto:", ""),
          property_type: get("td:contains('Property Type') + td"),
          mls_number: get("td:contains('MLS Number') + td"),
          mls_status: get("td:contains('MLS Status') + td"),
          status_change_date: get("td:contains('Status Change Date') + td"),
          list_price: get("td:contains('List Price') + td"),
          beds: get("td:contains('Beds') + td"),
          baths: get("td:contains('Baths') + td"),
          square_footage: get("td:contains('Square Footage') + td"),
          days_on_market: get("td:contains('Days On Market') + td"),
          listing_agent: get("td:contains('Listing Agent') + td"),
          listing_office: get("td:contains('Listing Office') + td"),
          street,
          city,
          state,
          zip,
          zillow_link: getHref("a[href*='zillow.com']"),
        };
      });

      lead.google_maps_link = buildGoogleMapsLink(lead);
      leads.push(lead);
    }

    console.log("✅ Found leads:", leads.length);

    // De-duplicate
    const cache = fs.existsSync(CACHE_FILE)
      ? new Set(JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")))
      : new Set();

    const seen = new Set();
    const unsent = leads.filter((lead) => {
      const key = `${lead.full_name}|${lead.phone}`;
      const isNew = !cache.has(key) && !seen.has(key);
      seen.add(key);
      return isNew;
    });

    console.log("📤 Leads to send:", unsent.length);

    for (const lead of unsent) {
      try {
        await axios.post(WEBHOOK_URL, {
          version: "v2",
          timestamp: new Date().toISOString(),
          lead,
        });
        console.log("✅ Sent:", lead.full_name);
      } catch (e) {
        console.warn("❌ Failed:", lead.full_name, e.message);
      }
    }

    fs.writeFileSync(CACHE_FILE, JSON.stringify([...cache, ...[...seen]], null, 2));

    // Create new folder
    await page.goto(FOLDER_URL);
    await page.waitForSelector("#new_folder_button");
    await page.click("#new_folder_button");
    await page.waitForSelector("#name");
    await page.type("#name", folderName);
    await page.select("#layout", "8109").catch(() => {});
    await page.click('button[type="submit"]').catch(() => {});
    await sleep(3000);

    // Move contacts
    await page.goto(OFF_MARKET_FOLDER_LINK);
    await page.waitForSelector("#master_checkbox");
    await page.click("#master_checkbox");
    await sleep(1000);
    await page.click("#cm_move_button");
    await sleep(1000);

    const moveSel = `li.move-contacts-folder[title="${folderName}"] a.move-to-folder`;
    const target = await page.$(moveSel);
    if (target) {
      await target.click();
      console.log("✅ Moved to folder:", folderName);
    } else {
      console.warn("⚠️ Could not find folder to move contacts.");
    }

  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    await browser.close();
  }
})();
