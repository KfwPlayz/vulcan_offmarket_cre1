// vulcan7_offmarket_script.js

// 📌 Required Libraries
const puppeteer = require("puppeteer");
const axios = require("axios");
const fs = require("fs");
const path = require("path");

// Small helper that works on every Node/Puppeteer version
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 🔐 Credentials and Constants
const LOGIN_URL = "https://www.vulcan7dialer.com/login";
const CONTACTS_SHELL_URL = "https://www.vulcan7dialer.com/cm/index#contacts";
const FOLDER_URL = "https://www.vulcan7dialer.com/cm/folders/index";

const EMAIL = process.env.EMAIL;
const PASSWORD = process.env.PASSWORD;
const WEBHOOK_URL = process.env.WEBHOOK_URL;

const CACHE_FILE = path.join(__dirname, "sent-leads-cache-offmarket.json");

// 📅 Folder name = Monday of current week
const today = new Date();
const day = today.getDay();
const offset = day === 0 ? -6 : 1 - day;
const monday = new Date(today);
monday.setDate(today.getDate() + offset);
const folderName = `Expired Leads Week of ${monday.getMonth() + 1}.${monday.getDate()}`;

// Build Google Maps link from address if Vulcan doesn't provide it
function buildGoogleMapsLink({ street, city, state, zip }) {
  const parts = [street, city, state, zip].filter(Boolean).join(", ");
  if (!parts.trim()) return "";
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(parts)}`;
}

// Click folder in left nav by visible text (robust)
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
  // ✅ KEEP YOUR EXISTING PUPPETEER SETUP (unchanged)
  const browser = await puppeteer.launch({
    headless: "new",
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium-browser",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--single-process",
    ],
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
  page.on("request", (req) => {
    const type = req.resourceType();
    if (type === "image" || type === "font" || type === "media") req.abort();
    else req.continue();
  });

  page.on("console", (msg) => console.log("[BROWSER]", msg.type(), msg.text()));
  page.on("pageerror", (err) => console.log("[PAGEERROR]", err));
  page.on("requestfailed", (req) => console.log("[REQ FAILED]", req.url(), req.failure()?.errorText));
  // === end CI hardening ===

  try {
    if (!EMAIL || !PASSWORD || !WEBHOOK_URL) {
      throw new Error("Missing env vars: EMAIL, PASSWORD, or WEBHOOK_URL");
    }

    // 🔐 Log in to Vulcan7
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await page.waitForSelector('input[name="email"], #email, input[name="username"]', { timeout: 120000 });
    await page.waitForSelector('input[name="password"], #password', { timeout: 120000 });

    const emailSel =
      (await page.$('input[name="email"]')) ? 'input[name="email"]'
        : (await page.$("#email")) ? "#email"
          : 'input[name="username"]';

    const passSel = (await page.$('input[name="password"]')) ? 'input[name="password"]' : "#password";

    await page.type(emailSel, EMAIL, { delay: 20 });
    await page.type(passSel, PASSWORD, { delay: 20 });

    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 120000 }).catch(() => null),
      page.click('button[type="submit"], .login-button'),
    ]);

    // ✅ Verify login stuck
    const urlAfterLogin = page.url();
    if (urlAfterLogin.includes("/login")) {
      throw new Error("Login did not complete (still on /login). Check creds, MFA, or selector changes.");
    }

    const loginFormStillThere = await page.$('input[name="password"], #password');
    if (loginFormStillThere) {
      throw new Error("Login form still present after submit. Likely failed login or additional verification step.");
    }

    // ✅ Go to contacts shell and click Off Market
    await page.goto(CONTACTS_SHELL_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await sleep(1500);

    await clickFolderByName(page, "Off Market");
    await sleep(2000);

    // ✅ Wait for a grid signal OR a no-results state
    await page.waitForFunction(() => {
      const hasOldRows = document.querySelectorAll("tr[data-itemid]").length > 0;

      const hasAnyRow =
        document.querySelectorAll("[data-itemid]").length > 0 ||
        document.querySelectorAll(".contact-details-link a").length > 0 ||
        document.querySelectorAll("a[href*='#contact/']").length > 0;

      const bodyText = (document.body?.innerText || "").toLowerCase();
      const noResults =
        bodyText.includes("no contacts") ||
        bodyText.includes("no results") ||
        bodyText.includes("0 contacts");

      return hasOldRows || hasAnyRow || noResults;
    }, { timeout: 120000 });

    await sleep(800);

    // ✅ Scrape contacts from Off Market folder (supports multiple layouts)
    const leads = await page.evaluate(() => {
      const safeText = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

      let nodes = Array.from(document.querySelectorAll("tr[data-itemid]"));
      if (!nodes.length) nodes = Array.from(document.querySelectorAll("[data-itemid]"));

      const results = [];

      for (const node of nodes) {
        const id = node.getAttribute("data-itemid");
        if (!id) continue;

        let nameEl = node.querySelector(".contact-details-link a");
        if (!nameEl) {
          nameEl =
            node.querySelector(`a[href*="#contact/${id}"]`) ||
            node.querySelector(`a[href*="#contact/"]`) ||
            node.querySelector("a");
        }

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

    console.log(`✅ Found ${leads.length} raw leads in "Off Market"`);

    if (!leads.length) {
      try { await page.screenshot({ path: "failure_contacts_empty.png", fullPage: true }); } catch {}
      try { fs.writeFileSync("failure_contacts_empty.html", await page.content()); } catch {}
    }

    // 📥 Deduplication (name + phone)
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

    console.log(`📌 Unsent leads: ${unsentLeads.length}`);

    // 🔍 Visit each contact detail page to fetch address + extra property/social info
    for (const lead of unsentLeads) {
      const detailPage = await browser.newPage();
      try {
        const detailUrl = `https://www.vulcan7dialer.com/cm/index#contact/${lead.contact_id}`;
        await detailPage.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 120000 });
        await detailPage.waitForSelector("body", { timeout: 120000 });
        await sleep(1200);

        await detailPage.waitForFunction(() => {
          const txt = (document.body?.innerText || "").toLowerCase();
          return txt.includes("residential property") || txt.includes("contact information");
        }, { timeout: 8000 }).catch(() => {});

        const detailData = await detailPage.evaluate(() => {
          const safeText = (el) => (el?.textContent || "").replace(/\s+/g, " ").trim();

          // Address
          let address = { street: "", city: "", state: "", zip: "" };
          const addrEl = document.querySelector('a[data-type="address"]');
          if (addrEl) {
            try {
              const data = JSON.parse(addrEl.getAttribute("data-value") || "{}");
              address = {
                street: data.address || "",
                city: data.city || "",
                state: data.state || "",
                zip: data.zip || "",
              };
            } catch {}
          }

          // Residential Property label -> value
          const normLabel = (s) =>
            (s || "")
              .toLowerCase()
              .replace(/\s+/g, " ")
              .replace(/:$/, "")
              .trim();

          const all = Array.from(document.querySelectorAll("*"));
          const rpHeader = all.find((el) => safeText(el).toLowerCase() === "residential property") || null;
          const rpRoot =
            rpHeader?.closest("div")?.parentElement ||
            rpHeader?.closest("section") ||
            rpHeader?.closest("div") ||
            document;

          const getByLabel = (label) => {
            const want = normLabel(label);

            const candidates = Array.from(rpRoot.querySelectorAll("div,span,td,th,strong,b"))
              .filter((el) => normLabel(safeText(el)) === want);

            const lab = candidates[0];
            if (!lab) return "";

            const row = lab.closest("tr") || lab.parentElement;
            if (!row) return "";

            if ((row.tagName || "").toLowerCase() === "tr") {
              const cells = Array.from(row.querySelectorAll("td,th,div,span"))
                .map(safeText)
                .filter(Boolean);
              const idx = cells.findIndex((t) => normLabel(t) === want);
              if (idx >= 0 && cells[idx + 1]) return cells[idx + 1];
            }

            const sib = lab.nextElementSibling;
            if (sib && safeText(sib)) return safeText(sib);

            const parts = Array.from(row.querySelectorAll("div,span,td"))
              .map(safeText)
              .filter(Boolean);

            const idx = parts.findIndex((t) => normLabel(t) === want);
            if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];

            return "";
          };

          const propertyType = getByLabel("Property Type");
          const mlsNumber = getByLabel("MLS Number");
          const mlsStatus = getByLabel("MLS Status");
          const statusChangeDate = getByLabel("Status Change Date");
          const listPrice = getByLabel("List Price");
          const squareFootage = getByLabel("Square Footage");
          const daysOnMarket = getByLabel("Days On Market");
          const listingAgent = getByLabel("Listing Agent");
          const listingOffice = getByLabel("Listing Office");

          const bedsBathsRaw = getByLabel("Beds / Baths");
          let beds = "", baths = "";
          if (bedsBathsRaw) {
            const m = bedsBathsRaw.match(/(\d+)\s*\/\s*(\d+)/);
            if (m) { beds = m[1]; baths = m[2]; }
          }

          // Links (Zillow, Google Maps, Social)
          const links = Array.from(document.querySelectorAll("a[href]"))
            .map((a) => a.getAttribute("href"))
            .filter(Boolean);

          const firstMatch = (pred) => (links.find(pred) || "");

          const zillowLink = firstMatch((h) => /zillow\.com/i.test(h)) || "";
          const googleMapsLink =
            firstMatch((h) => /google\.(com|ca)\/maps/i.test(h)) ||
            firstMatch((h) => /maps\.google/i.test(h)) ||
            "";

          const social = {
            facebook: firstMatch((h) => /facebook\.com/i.test(h)) || "",
            instagram: firstMatch((h) => /instagram\.com/i.test(h)) || "",
            linkedin: firstMatch((h) => /linkedin\.com/i.test(h)) || "",
            twitter: firstMatch((h) => /(twitter\.com|x\.com)/i.test(h)) || "",
            tiktok: firstMatch((h) => /tiktok\.com/i.test(h)) || "",
            youtube: firstMatch((h) => /(youtube\.com|youtu\.be)/i.test(h)) || "",
          };

          return {
            address,
            property: {
              property_type: propertyType || "",
              mls_number: mlsNumber || "",
              mls_status: mlsStatus || "",
              status_change_date: statusChangeDate || "",
              list_price: listPrice || "",
              beds: beds || "",
              baths: baths || "",
              square_footage: squareFootage || "",
              days_on_market: daysOnMarket || "",
              listing_agent: listingAgent || "",
              listing_office: listingOffice || "",
              zillow_link: zillowLink || "",
              google_maps_link: googleMapsLink || "",
            },
            social,
          };
        });

        // Defaults if anything missing
        const defaults = {
          street: "", city: "", state: "", zip: "",
          property_type: "", mls_number: "", mls_status: "", status_change_date: "",
          list_price: "", beds: "", baths: "", square_footage: "", days_on_market: "",
          listing_agent: "", listing_office: "", zillow_link: "", google_maps_link: "",
          facebook: "", instagram: "", linkedin: "", twitter: "", tiktok: "", youtube: "",
        };

        const addr = detailData?.address || {};
        const prop = detailData?.property || {};
        const soc = detailData?.social || {};

        const computedMaps = prop.google_maps_link || buildGoogleMapsLink(addr);

        Object.assign(
          lead,
          defaults,
          {
            street: addr.street || "",
            city: addr.city || "",
            state: addr.state || "",
            zip: addr.zip || "",

            property_type: prop.property_type || "",
            mls_number: prop.mls_number || "",
            mls_status: prop.mls_status || "",
            status_change_date: prop.status_change_date || "",
            list_price: prop.list_price || "",
            beds: prop.beds || "",
            baths: prop.baths || "",
            square_footage: prop.square_footage || "",
            days_on_market: prop.days_on_market || "",
            listing_agent: prop.listing_agent || "",
            listing_office: prop.listing_office || "",
            zillow_link: prop.zillow_link || "",
            google_maps_link: computedMaps || "",

            facebook: soc.facebook || "",
            instagram: soc.instagram || "",
            linkedin: soc.linkedin || "",
            twitter: soc.twitter || "",
            tiktok: soc.tiktok || "",
            youtube: soc.youtube || "",
          }
        );

      } catch (err) {
        console.error(`⚠️ Detail fetch failed for ${lead.full_name}: ${err.message}`);
        try { await detailPage.screenshot({ path: `failure_${lead.contact_id}.png`, fullPage: true }); } catch {}

        Object.assign(lead, {
          street: "", city: "", state: "", zip: "",
          property_type: "", mls_number: "", mls_status: "", status_change_date: "",
          list_price: "", beds: "", baths: "", square_footage: "", days_on_market: "",
          listing_agent: "", listing_office: "", zillow_link: "", google_maps_link: "",
          facebook: "", instagram: "", linkedin: "", twitter: "", tiktok: "", youtube: "",
        });
      } finally {
        await detailPage.close();
        await sleep(300);
      }
    }

    // 📤 Send to Zapier
    for (const lead of unsentLeads) {
      try {
        await axios.post(WEBHOOK_URL, {
          version: "v2",
          timestamp: new Date().toISOString(),
          lead,
        });
        console.log(`📤 Sent: ${lead.full_name}`);
      } catch (err) {
        console.error(`❌ Failed to send ${lead.full_name}: ${err.message}`);
      }
    }

    // 💾 Save updated cache
    const updatedCache = [...sentCache, ...newKeys];
    fs.writeFileSync(CACHE_FILE, JSON.stringify(updatedCache, null, 2));

    // 📁 Check/create folder
    await page.goto(CONTACTS_SHELL_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await sleep(1500);

    const normalizedName = folderName.replace(/\s+/g, "-");
    const folderExists = await page.evaluate((dataFolderName) => {
      const folders = [...document.querySelectorAll("div.contacts-folder-nav-name")];
      return folders.some((f) => f.getAttribute("data-folder-name") === dataFolderName);
    }, normalizedName);

    if (!folderExists) {
      console.log(`📁 Creating folder "${folderName}"`);
      await page.goto(FOLDER_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
      try {
        await page.waitForSelector("#new_folder_button", { timeout: 120000 });
        await page.click("#new_folder_button");
        await page.waitForSelector("#name", { timeout: 120000 });
        await page.type("#name", folderName);

        try { await page.select("#placement", "INSIDE"); } catch {}

        try {
          await page.click("div[aria-haspopup='listbox']");
          await page.waitForSelector("div[role='option']", { timeout: 10000 });
          await page.evaluate(() => {
            const option = [...document.querySelectorAll("div[role='option']")]
              .find((el) => el.textContent.trim() === "Off Market");
            option?.click();
          });
        } catch {}

        try { await page.select("#layout", "8109"); } catch {}
        try { await page.click("button[type='submit']"); } catch {}
        await sleep(3000);
      } catch (err) {
        console.warn(`⚠️ Folder creation flow might have changed: ${err.message}`);
      }
    } else {
      console.log(`✅ Folder "${folderName}" already exists — skipping creation.`);
    }

    // 📂 Move contacts (robust + avoids huge DOM scans)
    await page.goto(CONTACTS_SHELL_URL, { waitUntil: "domcontentloaded", timeout: 120000 });
    await sleep(1500);
    await clickFolderByName(page, "Off Market");
    await sleep(1500);

    // Select all
    await page.waitForSelector("#master_checkbox", { visible: true, timeout: 120000 });
    await page.click("#master_checkbox");
    console.log("✅ Selected all contacts via master checkbox.");

    // Move dropdown
    await page.waitForSelector("#cm_move_button", { visible: true, timeout: 120000 });
    await page.click("#cm_move_button");
    await sleep(800);

    const menuShown = await page.waitForFunction(() => {
      return (
        !!document.querySelector("#cm_move_dropdown") ||
        document.querySelectorAll("li.move-contacts-folder[title]").length > 0 ||
        document.querySelectorAll("#cm_move_dropdown li, .dropdown-menu li").length > 0
      );
    }, { timeout: 10000 }).catch(() => false);

    if (!menuShown) {
      console.log("↻ Move menu not detected, retrying click…");
      await page.click("#cm_move_button");
      await sleep(1200);
    }

    const menuDebug = await page.evaluate(() => ({
      hasDropdown: !!document.querySelector("#cm_move_dropdown"),
      itemsByTitle: document.querySelectorAll("li.move-contacts-folder[title]").length,
      anyLis: document.querySelectorAll("#cm_move_dropdown li, .dropdown-menu li").length,
    }));
    console.log("ℹ️ Move menu debug:", JSON.stringify(menuDebug));

    // ✅ Click target folder without scanning hundreds of nodes
    let moveSuccess = false;
    const safeFolderName = folderName.replace(/"/g, '\\"');
    const targetLinkSel = `li.move-contacts-folder[title="${safeFolderName}"] a.move-to-folder`;

    const directHandle = await page.$(targetLinkSel);
    if (directHandle) {
      await directHandle.click();
      moveSuccess = true;
    } else {
      moveSuccess = await page.evaluate((fn) => {
        const dropdown = document.querySelector("#cm_move_dropdown") || document;
        const items = Array.from(dropdown.querySelectorAll("li.move-contacts-folder[title]"));
        const match = items.find((li) => (li.getAttribute("title") || "").trim() === fn.trim());
        const link = match?.querySelector("a.move-to-folder, a, button");
        if (link) { link.click(); return true; }
        return false;
      }, folderName);
    }

    try { await page.keyboard.press("Escape"); } catch {}

    // Confirm modal if it appears
    try {
      await page.waitForSelector("#bulk_actions_modal button.btn.btn-primary", { visible: true, timeout: 5000 });
      await page.click("#bulk_actions_modal button.btn.btn-primary");
      console.log("🟢 Confirmed move modal.");
    } catch {
      console.warn("⚠️ 'Okay' button did not appear after move.");
    }

    if (moveSuccess) {
      console.log(`✅ Move to folder "${folderName}" triggered`);
      await sleep(3000);
    } else {
      console.error(`❌ Could not find move folder: ${folderName}`);
      try { await page.screenshot({ path: "failure_move.png", fullPage: true }); } catch {}
      try { fs.writeFileSync("failure_move.html", await page.content()); } catch {}
    }

  } catch (err) {
    console.error("❌ Script Error:", err);
    try { await page.screenshot({ path: "failure.png", fullPage: true }); } catch {}
    try { fs.writeFileSync("failure.html", await page.content()); } catch {}
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
