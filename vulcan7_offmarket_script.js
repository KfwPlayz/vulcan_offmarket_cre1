// 📌 Required Libraries
const puppeteer = require("puppeteer-core");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// 📁 Constants
const LOGIN_URL = "https://www.vulcan7dialer.com/login";
const CONTACTS_SHELL_URL = "https://www.vulcan7dialer.com/cm/index#params/dmlld19pZD05ODEzOCZwYWdlPTE=";
const FOLDER_URL = "https://www.vulcan7dialer.com/cm/folders/index";
const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const WEBHOOK_URL = process.env.WEBHOOK_URL;
const EXEC_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser";
const CACHE_FILE = path.join(__dirname, "sent-leads-cache-offmarket.json");

// 🗓️ Create folder name
const today = new Date();
const offset = today.getDay() === 0 ? -6 : 1 - today.getDay();
const monday = new Date(today.setDate(today.getDate() + offset));
const folderName = `Expired Leads Week of ${monday.getMonth() + 1}.${monday.getDate()}`;

// Helper
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeText = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();
const buildGoogleMapsLink = ({ street, city, state, zip }) => {
  const parts = [street, city, state, zip].filter(Boolean).join(", ");
  return parts ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts)}` : "";
};

// 🗂 Folder clicking utility
async function clickFolderByName(page, name) {
  const lower = name.trim().toLowerCase();
  await page.waitForFunction(
    (name) =>
      Array.from(document.querySelectorAll("div.contacts-folder-nav-name")).some(
        (el) => (el.textContent || "").trim().toLowerCase() === name
      ),
    { timeout: 30000 },
    lower
  );
  const clicked = await page.evaluate((name) => {
    const target = Array.from(document.querySelectorAll("div.contacts-folder-nav-name")).find(
      (el) => (el.textContent || "").trim().toLowerCase() === name
    );
    if (target) {
      target.click();
      return true;
    }
    return false;
  }, lower);
  if (!clicked) throw new Error(`Folder "${name}" not found`);
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

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "font", "media"].includes(type)) req.abort();
    else req.continue();
  });

  try {
    if (!EMAIL || !PASSWORD || !WEBHOOK_URL) throw new Error("Missing EMAIL, PASSWORD, or WEBHOOK_URL");

    // 🔐 Login
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

    if (page.url().includes("/login")) throw new Error("Login failed");

    // 📂 Navigate to Off Market
    await page.goto(CONTACTS_SHELL_URL);
    await sleep(2500);
    await clickFolderByName(page, "Off Market");
    await sleep(2500);

    await page.waitForFunction(() => {
      const body = (document.body.innerText || "").toLowerCase();
      return document.querySelectorAll("[data-itemid]").length > 0 || body.includes("no contacts");
    });

    // 🧠 Scrape expanded lead data
    const nodes = await page.$$("[data-itemid]");
    const leads = [];

    for (const node of nodes) {
      try {
        const id = await (await node.getProperty("dataset")).jsonValue().then((d) => d.itemid);
        const link = await node.$("a");
        await link.click();
        await page.waitForSelector(".contact-details");
        await sleep(1000);

        const lead = await page.evaluate(() => {
          const grab = (sel) => document.querySelector(sel)?.textContent?.trim() || "";
          const grabInput = (sel) => document.querySelector(sel)?.value?.trim() || "";
          return {
            full_name: grab("h3.contact-name") || "Unknown",
            phone: grab(".contact-phone") || "",
            email: grab("a[href^='mailto:']")?.replace("mailto:", "") || "",
            address: grabInput("input[name='street']"),
            city: grabInput("input[name='city']"),
            state: grabInput("input[name='state']"),
            zip: grabInput("input[name='zip']"),
            property_type: grab("td:contains('Property Type') + td"),
            mls_number: grab("td:contains('MLS Number') + td"),
            mls_status: grab("td:contains('MLS Status') + td"),
            status_change_date: grab("td:contains('Status Change Date') + td"),
            list_price: grab("td:contains('List Price') + td"),
            beds: grab("td:contains('Beds') + td"),
            baths: grab("td:contains('Baths') + td"),
            sqft: grab("td:contains('Sq Ft') + td"),
            dom: grab("td:contains('DOM') + td"),
            listing_agent: grab("td:contains('Listing Agent') + td"),
            listing_office: grab("td:contains('Listing Office') + td"),
            zillow: document.querySelector("a[href*='zillow.com']")?.href || "",
          };
        });

        lead.google_maps = buildGoogleMapsLink(lead);
        const parts = lead.full_name.split(" ");
        lead.first_name = parts[0];
        lead.last_name = parts.slice(1).join(" ");

        leads.push(lead);
        await page.goBack();
        await sleep(1000);
      } catch (e) {
        console.warn("Failed scraping a lead:", e.message);
      }
    }

    console.log("✅ Found leads:", leads.length);

    // 📦 De-duplicate + Send to Zapier
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

    // 📁 Create folder if needed
    await page.goto(FOLDER_URL);
    await page.waitForSelector("#new_folder_button");
    await page.click("#new_folder_button");
    await page.waitForSelector("#name");
    await page.type("#name", folderName);
    await page.select("#layout", "8109").catch(() => {});
    await page.click('button[type="submit"]').catch(() => {});
    await sleep(3000);

    // 🔁 Move leads to folder
    await page.goto(CONTACTS_SHELL_URL);
    await clickFolderByName(page, "Off Market");
    await sleep(2500);

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
