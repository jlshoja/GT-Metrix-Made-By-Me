# luxbaz Speed Audit Tool

A DIY, GTmetrix-style website speed/performance auditing tool for **luxbaz.com**, built on **Lighthouse** (the same engine Google PageSpeed Insights and GTmetrix use under the hood).

It crawls your sitemap, intelligently groups pages by type (product, category, blog, etc.) so it doesn't waste time re-testing hundreds of near-identical product pages, runs real Lighthouse tests on a sample from each group, and generates a polished HTML report with a chart, a summary table, and a prioritized list of fixes for every page tested.

---

## 1. What you get

- **`report-*.html`** — a visual report (open in any browser): performance score per page, Core Web Vitals (LCP, CLS, TBT), Speed Index, page size, request count, a bar chart, and a prioritized list of speed-improvement opportunities for each page.
- **`raw-*.json`** — the same data in raw form, useful if you want to track scores over time or process them with another script later.

Both are saved inside the `reports/` folder, timestamped, so old reports are never overwritten.

---

## 2. One-time setup

1. **Install Node.js** (version 18 or newer) if you don't already have it: https://nodejs.org — just download the Windows installer and click through it.
2. Put all the files from this folder (`config.json`, `seo-speed-audit.js`, `run.bat`, `package.json`) together in one folder on your PC, e.g. `C:\speed-audit\`.
3. Double-click **`run.bat`**.
   - The first time you run it, it will automatically download and install Lighthouse and a headless Chrome (this needs internet access and may take a few minutes — it's all official npm packages).
   - Every time after that, it starts instantly.

---

## 3. Configuration (`config.json`)

You never need to touch the actual code — everything you'd want to tweak lives in this file:

| Setting | What it does |
|---|---|
| `sitemapUrl` | Where to find your sitemap. Open `https://luxbaz.com/sitemap_index.xml` in a browser to confirm this is the right URL — WooCommerce/Yoast SEO sometimes name it differently. |
| `samplesPerCategory` | How many pages to actually test from each category. E.g. `"product": 3` means: out of all product pages found, only test 3 of them and treat the result as representative of the rest. |
| `urlPatterns` | The rules used to sort URLs into categories. Each one is a regex checked against the URL. You can add your own, e.g. to split out a specific landing page type. |
| `alwaysInclude` | Pages that are always tested no matter what (the homepage is in there by default). |
| `concurrency` | How many pages to test at the same time. `2` is a safe default. Going higher speeds things up but puts more load on your server and your PC. |
| `formFactor` | `"mobile"` or `"desktop"` — which device profile Lighthouse simulates. |
| `delayBetweenTestsMs` | A small pause before each test starts, to avoid hammering the server. |
| `outputDir` | Where reports get saved (default: `./reports`). |

---

## 4. Running it

Just double-click **`run.bat`**. You'll see progress printed in the terminal window:

```
== Step 1: Reading sitemap from ... ==
Total URLs found: 187

== Step 2: Categorizing and sampling ==
  Category "product": 142 pages found → testing 3 sample(s)
  Category "product-category": 18 pages found → testing 3 sample(s)
  Category "page": 12 pages found → testing 5 sample(s)
Total pages that will actually be tested: 14

== Step 3: Running Lighthouse ==
  Testing (1/14): https://luxbaz.com/
    ✓ Score: 78
  ...

== Step 4: Building report ==
✅ Done!
HTML report: ./reports/report-2026-06-27....html
Raw JSON data: ./reports/raw-2026-06-27....json
```

When it finishes, open the `report-*.html` file in the `reports` folder — that's your GTmetrix-style report.

---

## 5. Limitations (be aware of these)

- **No multi-location testing.** GTmetrix can test from servers in different countries; this tool only tests from wherever you run it (your PC). If your customers are spread internationally and that matters to you, this won't capture that — but for SEO purposes Google's crawler perspective matters more anyway.
- **Score isn't identical to GTmetrix's own algorithm.** GTmetrix has some proprietary weighting; this tool uses Lighthouse's standard performance score, which is the same one Google uses for ranking signals, so it's arguably more relevant for SEO work than GTmetrix's score.
- **Sampling, not exhaustive testing.** By design, it doesn't test every single product page — only a representative sample per category (configurable). If one specific product page has a unique problem (huge unique image, broken embed, etc.), the sample might miss it. Increase `samplesPerCategory` if you want more coverage at the cost of a longer run.
- **No historical tracking built in yet.** Each run produces a fresh, separate JSON/HTML pair. If you want trend graphs over time, the raw JSON files are there to build that on top of later.

---

## 6. Troubleshooting

- **"No URLs found in sitemap"** → Open the `sitemapUrl` from `config.json` in your browser and confirm it actually loads XML content. Some sites use `/sitemap.xml` instead of `/sitemap_index.xml`.
- **npm install fails / hangs** → Likely a network/internet issue on your end (especially relevant given regional restrictions) — try again, or run `npm install` manually in a terminal inside the folder to see the actual error.
- **Lighthouse error for a specific page** → That page will show up in the report with an "error" row instead of a score; the rest of the report still completes normally.
- Anything else weird → copy the terminal output and send it over, happy to debug it with you.
