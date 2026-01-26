// 📌 Required Libraries
const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// Helper
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 🔐 Credentials and Constants
const LOGIN_URL = "https://www.vulcan7dialer.com/login";
const CONTACTS_URL = "https://www.vulcan7dialer.com/cm/index#contacts";
const FOLDER_URL = "https://www.vulcan7dialer.com/cm/folders/index";

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
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  page.setDefaultNavigationTimeout(120000);
  await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64)");
  await page.setViewport({ width: 1366, height: 768 });

  try {
    if (!EMAIL || !PASSWORD || !WEBHOOK_URL) throw new Error("Missing EMAIL, PASSWORD, or WEBHOOK_URL");

    // Login
    await page.goto(LOGIN_URL);
    await page.waitForSelector('input[name="email"], #email, input[name="username"]');
    await page.waitForSelector('input[name="password"], #password');

    const emailSel = (await page.$('input[name="email"]')) ? 'input[name="email"]' : (await page.$("#email")) ? "#email" : 'input[name="username"]';
    const passSel = (await page.$('input[name="password"]')) ? 'input[name="password"]' : "#password";

    await page.type(emailSel, EMAIL, { delay: 20 });
    await page.type(passSel, PASSWORD, { delay: 20 });
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }),
      page.click('button[type="submit"], .login-button'),
    ]);

    if (page.url().includes("/login")) throw new Error("Login failed");

    // Go to Off Market
    await page.goto(CONTACTS_URL);
    await sleep(2000);

    // Click Off Market folder
    await page.evaluate(() => {
      const folder = Array.from(document.querySelectorAll("div.contacts-folder-nav-name"))
        .find(el => el.textContent.trim().toLowerCase() === "off market");
      if (folder) folder.click();
    });

    await page.waitForFunction(() => document.querySelectorAll("[data-itemid]").length > 0);

    // Get contact links
    const contactLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("[data-itemid] a[href*='contact_id=']")).map(a => ({
        url: a.href,
        id: a.closest("[data-itemid]").getAttribute("data-itemid")
      }));
    });

    console.log("✅ Found leads:", contactLinks.length);

    // Cache loading
    const cache = fs.existsSync(CACHE_FILE) ? new Set(JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"))) : new Set();
    const seen = new Set();
    const results = [];

    for (const { url, id } of contactLinks) {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await sleep(1000);

      const lead = await page.evaluate(() => {
        const safe = (q) => {
          const el = document.querySelector(q);
          return (el?.textContent || "").trim();
        };
        const emailEl = document.querySelector("a[href^='mailto:']");
        const phoneEl = document.querySelector("a[href^='tel:']");

        const getField = (label) => {
          const th = Array.from(document.querySelectorAll("th")).find(th => th.textContent.trim() === label);
          return th?.nextElementSibling?.textContent.trim() || "";
        };

        return {
          full_name: safe("h1") || "Unknown",
          phone: phoneEl?.textContent.trim() || "",
          email: emailEl?.textContent.replace("mailto:", "") || "",
          address: getField("Address"),
          city: getField("City"),
          state: getField("State"),
          zip: getField("Zip"),
          property_type: getField("Property Type"),
          mls_number: getField("MLS Number"),
          mls_status: getField("MLS Status"),
          status_change_date: getField("Status Change Date"),
          list_price: getField("List Price"),
          beds: getField("Beds"),
          baths: getField("Baths"),
          square_footage: getField("Square Footage"),
          days_on_market: getField("Days On Market"),
          listing_agent: getField("Listing Agent"),
          listing_office: getField("Listing Office"),
        };
      });

      lead.contact_id = id;
      lead.google_maps_link = buildGoogleMapsLink(lead);

      const key = `${lead.full_name}|${lead.phone}`;
      if (!cache.has(key) && !seen.has(key)) {
        seen.add(key);
        results.push(lead);

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
    }

    // Save cache
    fs.writeFileSync(CACHE_FILE, JSON.stringify([...cache, ...seen], null, 2));

    // Create folder if needed
    await page.goto(FOLDER_URL);
    await page.waitForSelector("#new_folder_button");
    await page.click("#new_folder_button");
    await page.waitForSelector("#name");
    await page.type("#name", folderName);
    await page.select("#layout", "8109").catch(() => {});
    await page.click('button[type="submit"]').catch(() => {});
    await sleep(3000);

    // Move contacts
    await page.goto(CONTACTS_URL);
    await sleep(1500);
    await page.evaluate(() => {
      const folder = Array.from(document.querySelectorAll("div.contacts-folder-nav-name"))
        .find(el => el.textContent.trim().toLowerCase() === "off market");
      if (folder) folder.click();
    });

    await page.waitForSelector("#master_checkbox");
    await page.click("#master_checkbox");
    await sleep(1000);
    await page.click("#cm_move_button");
    await sleep(1000);

    const moveSel = `li.move-contacts-folder[title="${folderName}"] a.move-to-folder`;
    const target = await page.$(moveSel);
    if (target) {
      await target.click();
      console.log("✅ Moved contacts to:", folderName);
    } else {
      console.warn("⚠️ Could not find folder to move contacts.");
    }

  } catch (err) {
    console.error("❌ Error:", err);
  } finally {
    await browser.close();
  }
})();
