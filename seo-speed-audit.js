/**
 * luxbaz Speed Audit — a DIY GTmetrix-style tool
 * -----------------------------------------------
 * Steps:
 *  1) Read the sitemap (and any nested sitemap indexes) and extract all URLs
 *  2) Categorize URLs based on the patterns in config.json (e.g. all /product/... is one category)
 *  3) Only a configurable number of samples per category are actually tested with Lighthouse
 *  4) Build an HTML report with a table + chart, similar to a GTmetrix report
 *
 * Run: node seo-speed-audit.js
 */

const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

let lighthouse, chromeLauncher;

// ---------- Helper utilities ----------

function loadConfig() {
  const configPath = path.join(__dirname, "config.json");
  const raw = fs.readFileSync(configPath, "utf-8");
  return JSON.parse(raw);
}

// Fetches a URL as text. `timeoutMs` aborts the request if the server never responds
// (default 15s, can be overridden via config.sitemapTimeoutMs).
function fetchUrl(url, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https") ? https : http;
    const req = client.get(url, { headers: { "User-Agent": "Mozilla/5.0 (LuxbazSpeedAudit/1.0)" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, timeoutMs).then(resolve, reject);
      }
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => resolve(data));
    });

    req.on("error", reject);

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Timed out after ${timeoutMs}ms waiting for ${url}`));
    });
  });
}

// Retries fetchUrl a configurable number of times before giving up, with a short
// pause between attempts. Used for sitemap files, which occasionally time out
// or hiccup on a slow/loaded server.
async function fetchUrlWithRetry(url, timeoutMs, retries) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetchUrl(url, timeoutMs);
    } catch (err) {
      lastErr = err;
      console.warn(`  ⚠ Attempt ${attempt}/${retries} failed for ${url}: ${err.message}`);
      if (attempt < retries) await sleep(1000 * attempt); // small increasing pause before retrying
    }
  }
  throw lastErr;
}

// Extract all <loc>...</loc> tags from an xml file (sitemap or sitemap index)
function extractLocs(xml) {
  const matches = xml.match(/<loc>(.*?)<\/loc>/g) || [];
  return matches.map((m) => m.replace(/<\/?loc>/g, "").trim());
}

async function getAllUrlsFromSitemap(sitemapUrl, config, seen = new Set()) {
  if (seen.has(sitemapUrl)) return [];
  seen.add(sitemapUrl);

  const timeoutMs = config.sitemapTimeoutMs ?? 15000;
  const retries = config.sitemapRetries ?? 3;

  console.log(`  Reading: ${sitemapUrl}`);
  let xml;
  try {
    xml = await fetchUrlWithRetry(sitemapUrl, timeoutMs, retries);
  } catch (err) {
    console.warn(`  ⚠ Could not fetch after ${retries} attempt(s): ${sitemapUrl} (${err.message})`);
    return [];
  }

  const locs = extractLocs(xml);

  // If this is a sitemap index, the locs themselves are other sitemaps (usually ending in .xml)
  const looksLikeSitemapIndex = xml.includes("<sitemapindex");

  if (looksLikeSitemapIndex) {
    let all = [];
    for (const loc of locs) {
      const childUrls = await getAllUrlsFromSitemap(loc, config, seen);
      all = all.concat(childUrls);
    }
    return all;
  }

  return locs;
}

function categorizeUrl(url, patterns) {
  for (const { category, pattern } of patterns) {
    try {
      const re = new RegExp(pattern, "i");
      if (re.test(url)) return category;
    } catch (e) {
      // Invalid pattern, skip it
    }
  }
  return "other";
}

function groupAndSample(urls, config) {
  const groups = {};
  for (const url of urls) {
    const cat = categorizeUrl(url, config.urlPatterns);
    if (!groups[cat]) groups[cat] = [];
    groups[cat].push(url);
  }

  const selected = [];
  const meta = []; // { url, category, totalInCategory }

  for (const [cat, list] of Object.entries(groups)) {
    const sampleSize = config.samplesPerCategory[cat] ?? config.samplesPerCategory.other ?? 2;
    const sample = list.slice(0, sampleSize);
    for (const url of sample) {
      selected.push(url);
      meta.push({ url, category: cat, totalInCategory: list.length });
    }
  }

  // Add pages that must always be tested (if not already in the list)
  for (const url of config.alwaysInclude || []) {
    if (!selected.includes(url)) {
      selected.push(url);
      meta.push({ url, category: "pinned", totalInCategory: 1 });
    }
  }

  return { selected, meta, groups };
}

// ---------- Running Lighthouse ----------

async function runLighthouseOnUrl(url, config, chrome) {
  const options = {
    port: chrome.port,
    output: "json",
    onlyCategories: ["performance"],
    formFactor: config.formFactor || "mobile",
    screenEmulation:
      (config.formFactor || "mobile") === "mobile"
        ? { mobile: true, width: 412, height: 823, deviceScaleFactor: 2.625, disabled: false }
        : { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
    throttlingMethod: "simulate",
  };

  const timeoutMs = config.lighthouseTimeoutMs ?? 90000;

  // Race the actual Lighthouse run against a timeout so one stuck page can't hang
  // the whole audit. Note: this only stops *waiting* for Lighthouse — if the
  // underlying run is truly wedged, the Chrome tab may keep working in the
  // background until the next test reuses/reclaims it.
  const runnerResult = await Promise.race([
    lighthouse(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Lighthouse timed out after ${timeoutMs}ms on ${url}`)), timeoutMs)
    ),
  ]);
  const lhr = runnerResult.lhr;

  const audits = lhr.audits;
  const score = Math.round((lhr.categories.performance.score || 0) * 100);

  const metric = (id) => audits[id]?.numericValue ?? null;
  const metricDisplay = (id) => audits[id]?.displayValue ?? "—";

  // List of the most important improvement opportunities, sorted by estimated time savings
  const opportunities = Object.values(audits)
    .filter((a) => a.details && a.details.type === "opportunity" && (a.numericValue || 0) > 0)
    .sort((a, b) => (b.numericValue || 0) - (a.numericValue || 0))
    .slice(0, 8)
    .map((a) => ({
      title: a.title,
      description: a.description,
      savingsMs: a.details.overallSavingsMs ? Math.round(a.details.overallSavingsMs) : null,
    }));

  // Other important failed/borderline diagnostics
  const diagnostics = Object.values(audits)
    .filter(
      (a) =>
        a.score !== null &&
        a.score < 0.9 &&
        a.scoreDisplayMode === "binary" &&
        !opportunities.find((o) => o.title === a.title)
    )
    .slice(0, 8)
    .map((a) => ({ title: a.title, description: a.description }));

  return {
    url,
    score,
    metrics: {
      fcp: metricDisplay("first-contentful-paint"),
      lcp: metricDisplay("largest-contentful-paint"),
      tbt: metricDisplay("total-blocking-time"),
      cls: metricDisplay("cumulative-layout-shift"),
      speedIndex: metricDisplay("speed-index"),
    },
    rawMetrics: {
      lcpMs: metric("largest-contentful-paint"),
      tbtMs: metric("total-blocking-time"),
      cls: metric("cumulative-layout-shift"),
    },
    pageSizeBytes: audits["total-byte-weight"]?.numericValue ?? null,
    requestCount: audits["network-requests"]?.details?.items?.length ?? null,
    opportunities,
    diagnostics,
  };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function runWithConcurrency(items, limit, worker) {
  const results = [];
  let i = 0;
  async function next() {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        console.error(`    ✗ Failed: ${items[idx].url} — ${err.message}`);
        results[idx] = { url: items[idx].url, error: err.message };
      }
    }
  }
  const runners = Array.from({ length: Math.min(limit, items.length) }, next);
  await Promise.all(runners);
  return results;
}

// ---------- Building the HTML report ----------

function scoreColor(score) {
  if (score >= 90) return "#0cce6b";
  if (score >= 50) return "#ffa400";
  return "#ff4e42";
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function buildHtmlReport(results, meta, config) {
  const rows = results
    .map((r, idx) => {
      const m = meta[idx];
      if (r.error) {
        return `<tr class="err">
          <td>${escapeHtml(r.url)}</td>
          <td colspan="6">Test failed: ${escapeHtml(r.error)}</td>
        </tr>`;
      }
      const sizeKb = r.pageSizeBytes ? Math.round(r.pageSizeBytes / 1024) : "—";
      return `<tr>
        <td class="url-cell"><a href="${escapeHtml(r.url)}" target="_blank">${escapeHtml(r.url)}</a>
          <div class="cat-badge">${escapeHtml(m.category)} ${m.totalInCategory > 1 ? `(representing ${m.totalInCategory} pages)` : ""}</div>
        </td>
        <td><span class="score-pill" style="background:${scoreColor(r.score)}">${r.score}</span></td>
        <td>${r.metrics.lcp}</td>
        <td>${r.metrics.cls}</td>
        <td>${r.metrics.tbt}</td>
        <td>${r.metrics.speedIndex}</td>
        <td>${sizeKb !== "—" ? sizeKb + " KB" : "—"}</td>
        <td>${r.requestCount ?? "—"}</td>
      </tr>`;
    })
    .join("\n");

  const detailSections = results
    .map((r, idx) => {
      if (r.error) return "";
      const m = meta[idx];
      const opps = r.opportunities
        .map(
          (o) =>
            `<li><strong>${escapeHtml(o.title)}</strong>${
              o.savingsMs ? ` — estimated savings ${o.savingsMs} ms` : ""
            }<div class="desc">${escapeHtml(o.description.replace(/\[.*?\]\(.*?\)/g, "").slice(0, 220))}</div></li>`
        )
        .join("");
      const diags = r.diagnostics
        .map(
          (d) =>
            `<li><strong>${escapeHtml(d.title)}</strong><div class="desc">${escapeHtml(
              d.description.replace(/\[.*?\]\(.*?\)/g, "").slice(0, 220)
            )}</div></li>`
        )
        .join("");

      return `<div class="detail-card">
        <h3><a href="${escapeHtml(r.url)}" target="_blank">${escapeHtml(r.url)}</a>
          <span class="score-pill" style="background:${scoreColor(r.score)}">${r.score}</span>
        </h3>
        <p class="cat-badge">Category: ${escapeHtml(m.category)}</p>
        ${opps ? `<h4>Speed improvement opportunities</h4><ul>${opps}</ul>` : ""}
        ${diags ? `<h4>Other technical issues</h4><ul>${diags}</ul>` : ""}
        ${!opps && !diags ? "<p>No significant issues detected 👍</p>" : ""}
      </div>`;
    })
    .join("\n");

  const chartLabels = JSON.stringify(results.map((r) => (r.error ? r.url + " (error)" : r.url.replace(config.baseUrl, ""))));
  const chartScores = JSON.stringify(results.map((r) => (r.error ? 0 : r.score)));

  const generatedAt = new Date().toLocaleString("en-US");

  return `<!DOCTYPE html>
<html lang="en" dir="ltr">
<head>
<meta charset="UTF-8">
<title>luxbaz.com Speed Report</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js"></script>
<style>
  body { font-family: Tahoma, Arial, sans-serif; background:#f5f6f8; margin:0; padding:24px; color:#222; }
  h1 { font-size: 22px; }
  .meta { color:#666; margin-bottom: 24px; font-size: 13px; }
  table { width:100%; border-collapse: collapse; background:#fff; border-radius:8px; overflow:hidden; box-shadow:0 1px 4px rgba(0,0,0,.08); }
  th, td { padding: 10px 12px; text-align: left; border-bottom: 1px solid #eee; font-size: 13px; }
  th { background:#1f2a44; color:#fff; position: sticky; top:0; }
  tr.err td { color:#c0392b; background:#fff5f5; }
  .url-cell { max-width: 360px; word-break: break-all; }
  .cat-badge { display:inline-block; font-size:11px; color:#666; background:#eef1f6; padding:2px 8px; border-radius:10px; margin-top:4px; }
  .score-pill { display:inline-block; min-width: 34px; text-align:center; color:#fff; font-weight:bold; border-radius:6px; padding:4px 8px; }
  .chart-wrap { background:#fff; padding:16px; border-radius:8px; margin: 20px 0; box-shadow:0 1px 4px rgba(0,0,0,.08); }
  .detail-card { background:#fff; padding:16px 20px; border-radius:8px; margin-bottom:14px; box-shadow:0 1px 4px rgba(0,0,0,.08); }
  .detail-card h3 { display:flex; align-items:center; gap:10px; font-size:15px; }
  .detail-card h4 { font-size: 13px; margin: 14px 0 6px; color:#444; }
  .detail-card ul { margin: 0; padding-left: 18px; }
  .detail-card li { margin-bottom: 10px; font-size: 13px; }
  .detail-card .desc { color:#777; font-size: 12px; margin-top: 2px; }
  .section-title { margin-top: 36px; font-size: 17px; border-left: 4px solid #1f2a44; padding-left: 10px; }
</style>
</head>
<body>
  <h1>luxbaz.com Speed & Performance Report</h1>
  <div class="meta">
    Report generated: ${generatedAt} &nbsp;|&nbsp;
    Pages tested: ${results.length} &nbsp;|&nbsp;
    Device: ${config.formFactor === "desktop" ? "Desktop" : "Mobile"}
  </div>

  <div class="chart-wrap">
    <canvas id="scoreChart" height="90"></canvas>
  </div>

  <h2 class="section-title">Summary Table</h2>
  <table>
    <thead>
      <tr>
        <th>Page</th><th>Score</th><th>LCP</th><th>CLS</th><th>TBT</th><th>Speed Index</th><th>Size</th><th># Requests</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>

  <h2 class="section-title">Per-page Details & Improvement Opportunities</h2>
  ${detailSections}

  <script>
    const ctx = document.getElementById('scoreChart');
    new Chart(ctx, {
      type: 'bar',
      data: {
        labels: ${chartLabels},
        datasets: [{
          label: 'Performance Score',
          data: ${chartScores},
          backgroundColor: ${chartScores}.map(s => s >= 90 ? '#0cce6b' : s >= 50 ? '#ffa400' : '#ff4e42')
        }]
      },
      options: {
        scales: { y: { beginAtZero: true, max: 100 } },
        plugins: { legend: { display: false } }
      }
    });
  </script>
</body>
</html>`;
}

// ---------- Main execution ----------

async function main() {
  console.log("Loading Lighthouse modules...");
  lighthouse = (await import("lighthouse")).default;
  chromeLauncher = await import("chrome-launcher");

  const config = loadConfig();

  console.log(`\n== Step 1: Reading sitemap from ${config.sitemapUrl} ==`);
  const allUrls = [...new Set(await getAllUrlsFromSitemap(config.sitemapUrl, config))];
  console.log(`Total URLs found: ${allUrls.length}`);

  if (allUrls.length === 0) {
    console.error("No URLs found in sitemap. Check the sitemapUrl in config.json.");
    process.exit(1);
  }

  console.log("\n== Step 2: Categorizing and sampling ==");
  const { selected, meta, groups } = groupAndSample(allUrls, config);
  for (const [cat, list] of Object.entries(groups)) {
    const sampleSize = config.samplesPerCategory[cat] ?? config.samplesPerCategory.other ?? 2;
    console.log(`  Category "${cat}": ${list.length} pages found → testing ${Math.min(sampleSize, list.length)} sample(s)`);
  }
  console.log(`Total pages that will actually be tested: ${selected.length}`);

  console.log("\n== Step 3: Running Lighthouse ==");
  const chrome = await chromeLauncher.launch({
    chromeFlags: ["--headless=new", "--no-sandbox", "--disable-gpu"],
  });

  const tasks = meta.map((m) => m);
  let completed = 0;

  const lighthouseRetries = config.lighthouseRetries ?? 1;

  const results = await runWithConcurrency(tasks, config.concurrency || 2, async (item) => {
    if (config.delayBetweenTestsMs) await sleep(config.delayBetweenTestsMs);
    console.log(`  Testing (${++completed}/${tasks.length}): ${item.url}`);

    // Try once, then retry up to `lighthouseRetries` more times on failure
    // (a fresh attempt often succeeds if the previous failure was transient).
    let lastErr;
    for (let attempt = 1; attempt <= lighthouseRetries + 1; attempt++) {
      try {
        const r = await runLighthouseOnUrl(item.url, config, chrome);
        console.log(`    ✓ Score: ${r.score}`);
        return r;
      } catch (err) {
        lastErr = err;
        if (attempt <= lighthouseRetries) {
          console.warn(`    ⚠ Attempt ${attempt}/${lighthouseRetries + 1} failed for ${item.url}: ${err.message} — retrying...`);
        }
      }
    }
    throw lastErr;
  });

  // chrome.kill() also tries to delete Chrome's temp profile folder, which can fail
  // on Windows with EPERM if antivirus/OS still has a lock on it. That's just cleanup —
  // it must never cost us the results we already gathered, so we catch and warn instead
  // of letting it crash the program before the report gets built.
  try {
    await chrome.kill();
  } catch (err) {
    console.warn(`  ⚠ Could not fully clean up Chrome's temp folder (harmless, safe to ignore): ${err.message}`);
  }

  console.log("\n== Step 4: Building report ==");
  const outputDir = path.join(__dirname, config.outputDir || "./reports");
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(outputDir, `raw-${timestamp}.json`);
  const htmlPath = path.join(outputDir, `report-${timestamp}.html`);

  fs.writeFileSync(jsonPath, JSON.stringify({ meta, results }, null, 2), "utf-8");
  fs.writeFileSync(htmlPath, buildHtmlReport(results, meta, config), "utf-8");

  console.log(`\n✅ Done!`);
  console.log(`HTML report: ${htmlPath}`);
  console.log(`Raw JSON data: ${jsonPath}`);
}

main().catch((err) => {
  console.error("Fatal error running the program:", err);
  process.exit(1);
});
