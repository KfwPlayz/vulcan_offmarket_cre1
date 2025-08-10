// 📌 Required Libraries
const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const { Parser } = require("json2csv");

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
  // On GitHub’s Ubuntu runners Chromium is usually here:
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage"
  ]
});
  const page = await browser.newPage();

  try {
    // 🔐 Log in to Vulcan7
    await page.goto(LOGIN_URL, { waitUntil: "networkidle2" });
    await page.type('input[name="username"]', EMAIL);
    await page.type('input[name="password"]', PASSWORD);
    await Promise.all([
      page.click('button[type="submit"]'),
      page.waitForNavigation({ waitUntil: "networkidle2" })
    ]);

    // ✅ Scrape contacts from Off Market folder
    await page.goto(CONTACTS_URL, { waitUntil: "networkidle2" });
    await new Promise(resolve => setTimeout(resolve, 3000));

    const leads = await page.evaluate(() => {
  const rows = document.querySelectorAll("tr[data-itemid]");
  const leads = [];

  for (const row of rows) {
    const id = row.getAttribute("data-itemid");

    const fullName = row.querySelector(".contact-details-link a")?.innerText.trim();
    if (!fullName) continue;

    const nameParts = fullName.split(" ");

    const phoneDiv = document.querySelector(`div[id='cell-example-${id}-143332']`);
    const phone = phoneDiv?.innerText?.trim() || "";

    const emailEl = document.querySelector(`div[id='cell-example-${id}-143333'] a[href^='mailto:']`);
    const email = emailEl?.getAttribute("href")?.replace("mailto:", "").trim() || "";

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
      sentCache = new Set(JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8")));
    }

    const unsentLeads = [], newKeys = [];
    for (const lead of filtered) {
      const key = `${lead.full_name}|${lead.phone}`;
      if (!sentCache.has(key)) {
        unsentLeads.push(lead);
        newKeys.push(key);
      }
    }

    // 🔍 Visit each contact detail page to fetch address info
    for (const lead of unsentLeads) {
      const detailPage = await browser.newPage();
      try {
        const detailUrl = `https://www.vulcan7dialer.com/cm/index#contact/${lead.contact_id}`;
        await detailPage.goto(detailUrl, { waitUntil: "networkidle2" });
        await detailPage.waitForSelector('a[data-type="address"]', { timeout: 5000 });

        const address = await detailPage.evaluate(() => {
          const el = document.querySelector('a[data-type="address"]');
          if (!el) return {};
          const data = JSON.parse(el.getAttribute("data-value") || "{}");
          return {
            street: data.address || "",
            city: data.city || "",
            state: data.state || "",
            zip: data.zip || ""
          };
        });

        Object.assign(lead, address);
      } catch (err) {
        console.error(`⚠️ Address fetch failed for ${lead.full_name}`);
        lead.street = lead.city = lead.state = lead.zip = "";
      } finally {
        await detailPage.close();
        await new Promise(r => setTimeout(r, 300));
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

    // First check if folder already exists on the contacts page
await page.goto(CONTACTS_URL, { waitUntil: "networkidle2" });
await page.waitForSelector("div.contacts-folder-nav-name");

const folderExists = await page.evaluate(dataFolderName => {
  const folders = [...document.querySelectorAll("div.contacts-folder-nav-name")];
  return folders.some(f => f.getAttribute("data-folder-name") === dataFolderName);
}, folderName.replace(/\s+/g, "-"));

if (folderExists) {
  console.log(`✅ Folder "${folderName}" already exists — skipping creation.`);
} else {
  console.log(`📁 Folder "${folderName}" not found — creating it.`);
  // Proceed with folder creation logic here...
  await page.goto(FOLDER_URL, { waitUntil: "networkidle2" });
  await page.click("#new_folder_button");
  await page.waitForSelector("#name");
  await page.type("#name", folderName);
  await page.select("#placement", "INSIDE");
  await page.click("div[aria-haspopup='listbox']");
  await page.waitForSelector("div[role='option']");
  await page.evaluate(() => {
    const option = [...document.querySelectorAll("div[role='option']")].find(el => el.textContent.trim() === "Off Market");
    if (option) option.click();
  });
  await page.select("#layout", "8109"); // or whatever layout is needed
  await page.click("button[type='submit']");
  await new Promise(r => setTimeout(r, 3000));
}

    // 📂 Move contacts
    await page.goto(CONTACTS_URL, { waitUntil: "networkidle2" });
    await new Promise(resolve => setTimeout(resolve, 3000));

// ✅ Select all visible contacts
await page.waitForSelector("#master_checkbox", { visible: true });
await page.click("#master_checkbox");
console.log("✅ Selected all contacts via master checkbox.");


    // Open Move dropdown
await page.waitForSelector("#cm_move_button", { visible: true });
await page.click("#cm_move_button");
console.log("📂 Opened move dropdown");

await page.waitForSelector("#cm_move_dropdown", { visible: true });

const moveSuccess = await page.evaluate(folderName => {
  const folderItems = document.querySelectorAll("li.move-contacts-folder[title]");
  for (const item of folderItems) {
    if (item.title.trim() === folderName.trim()) {
      item.querySelector("a.move-to-folder")?.click();
      return true;
    }
  }
  return false;
}, folderName);

// 💡 NEW STEP: Confirm folder creation
try {
  await page.waitForSelector("#bulk_actions_modal button.btn.btn-primary", { visible: true, timeout: 5000 });
  await page.click("#bulk_actions_modal button.btn.btn-primary");
  console.log("🟢 Confirmed folder creation via Okay button.");
} catch (err) {
  console.warn("⚠️ 'Okay' button did not appear after folder creation.");
}

if (moveSuccess) {
  console.log(`✅ Move to folder "${folderName}" triggered`);
  await new Promise(r => setTimeout(r, 3000)); // give time for the move to process
} else {
  console.error(`❌ Could not find move folder: ${folderName}`);
}


  } catch (err) {
    console.error("❌ Script Error:", err.message);
  } finally {
    await browser.close();
  }
})();
