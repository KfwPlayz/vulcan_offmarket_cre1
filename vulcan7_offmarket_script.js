// 📌 Required Libraries
const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// Helper
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 🔐 Credentials and Constants
const LOGIN_URL = "https://www.vulcan7dialer.com/login";
const CONTACTS_SHELL_URL = "https://www.vulcan7dialer.com/cm/index#contacts";
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

// 📁 Robust folder click
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

// 🧠 Extract text helper
const safeText = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

(async () => {
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: EXEC_PATH,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--single-process"],
  });

  const page = await browser.newPage();
  page.setDefaultTimeout(120000);
  await page.setUserAgent("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/123 Safari/537.36");
  await page.setViewport({ width: 1366, height: 768 });
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "font", "media"].includes(type)) req.abort();
    else req.continue();
  });

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

    if (page.url().includes("/login")) throw new Error("Login failed");

    // Go to Off Market
    await page.goto(CONTACTS_SHELL_URL);
    await sleep(1500);
    await clickFolderByName(page, "Off Market");
    await sleep(2000);

    await page.waitForFunction(() => {
      const body = (document.body.innerText || "").toLowerCase();
      return document.querySelectorAll("[data-itemid]").length > 0 || body.includes("no contacts");
    });

    // Scrape contacts
    const contactNodes = await page.$$("[data-itemid]");
    const leads = [];

    for (const node of contactNodes) {
      const id = await node.evaluate((el) => el.getAttribute("data-itemid"));
      const nameEl = await node.$("a");
      const fullName = nameEl ? await nameEl.evaluate(safeText) : "";
      if (!fullName || fullName === "Insert Timestamp") continue;

      const parts = fullName.split(" ");
      const phone = await page.$eval(`div[id^='cell-example-${id}-']`, el => el.innerText.trim()).catch(() => "");
      const emailEl = await page.$(`div[id^='cell-example-${id}-'] a[href^='mailto:']`);
      const email = emailEl ? (await emailEl.evaluate((a) => a.href)).replace("mailto:", "") : "";

      // Open lead detail in new tab
      const detailPage = await browser.newPage();
      await detailPage.goto(`https://www.vulcan7dialer.com/cm/contact/edit/${id}`);
      await detailPage.waitForSelector("body", { timeout: 10000 }).catch(() => {});
      await sleep(3000);

      const details = await detailPage.evaluate(() => {
        const get = (label) => {
          const row = Array.from(document.querySelectorAll(".form-group"))
            .find((g) => g.innerText?.toLowerCase().includes(label.toLowerCase()));
          return row?.querySelector("input, select")?.value?.trim() || "";
        };

        const street = get("Street");
        const city = get("City");
        const state = get("State");
        const zip = get("Zip");
        const mlsNumber = get("MLS Number");
        const mlsStatus = get("MLS Status");
        const statusDate = get("Status Change Date");
        const price = get("List Price");
        const type = get("Property Type");
        const beds = get("Beds");
        const baths = get("Baths");
        const sqft = get("Square Footage");
        const dom = get("Days On Market");
        const agent = get("Listing Agent");
        const office = get("Listing Office");

        return {
          street,
          city,
          state,
          zip,
          mlsNumber,
          mlsStatus,
          statusDate,
          price,
          type,
          beds,
          baths,
          sqft,
          dom,
          agent,
          office,
        };
      });

      await detailPage.close();

      leads.push({
        contact_id: id,
        full_name: fullName,
        first_name: parts[0] || "",
        last_name: parts.slice(1).join(" "),
        phone,
        email,
        ...details,
        zillow_link: details.street && details.zip
          ? `https://www.zillow.com/homes/${encodeURIComponent(details.street + " " + details.zip)}`
          : "",
        google_maps_link: buildGoogleMapsLink(details),
      });
    }

    console.log("✅ Found leads:", leads.length);

    // Deduplication
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
          version: "v3",
          timestamp: new Date().toISOString(),
          lead,
        });
        console.log("✅ Sent:", lead.full_name);
      } catch (e) {
        console.warn("❌ Failed:", lead.full_name, e.message);
      }
    }

    fs.writeFileSync(CACHE_FILE, JSON.stringify([...cache, ...[...seen]], null, 2));

    // Folder creation and moving
    await page.goto(FOLDER_URL);
    await page.waitForSelector("#new_folder_button");
    await page.click("#new_folder_button");
    await page.waitForSelector("#name");
    await page.type("#name", folderName);
    await page.select("#layout", "8109").catch(() => {});
    await page.click('button[type="submit"]').catch(() => {});
    await sleep(3000);

    await page.goto(CONTACTS_SHELL_URL);
    await clickFolderByName(page, "Off Market");
    await sleep(1500);

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
