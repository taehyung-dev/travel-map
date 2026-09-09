// For the handful of regions where even a second landmark pick had no
// Wikipedia/Commons photo, try up to 3 more candidate names each (in
// order) and stop at the first one that resolves. Only exact-title
// Wikipedia lookups and Commons file search are used - no fuzzy
// full-text-search fallback (that's what matched a former president's
// bio page to an unrelated county earlier). Prints a report; does NOT
// touch landmarks.js/landmark-images.js - review the report, then apply
// the winning picks by hand.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const UA = "TravelMapApp/1.0 (personal hobby project; contact: local-user)";

const CANDIDATES = {
  "33370": ["무극전통시장", "음성 반딧불이생태학교", "음성 원남저수지"], // 음성군
  "38110": ["저도 콰이강의다리", "마산항", "창원 가음정공원"], // 창원시
};

function apiGet(url) {
  return fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
}

async function wikiExact(title) {
  const url = "https://ko.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title);
  const res = await apiGet(url);
  if (!res.ok) return null;
  const json = await res.json();
  if (json.type === "disambiguation" || !json.thumbnail) return null;
  return { src: json.thumbnail.source, credit: json.title, sourceUrl: "https://ko.wikipedia.org/wiki/" + encodeURIComponent(json.title) };
}

async function commonsSearch(query) {
  const url =
    "https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=5" +
    "&prop=imageinfo&iiprop=url|size|mime&iiurlwidth=360&format=json&gsrsearch=" +
    encodeURIComponent(query + " -logo -map -icon");
  const res = await apiGet(url);
  if (!res.ok) return null;
  const json = await res.json();
  if (!json.query || !json.query.pages) return null;
  const hits = Object.values(json.query.pages)
    .filter((p) => p.imageinfo && p.imageinfo[0])
    .map((p) => ({ title: p.title, info: p.imageinfo[0] }))
    .filter((p) => /\.(jpe?g|png)$/i.test(p.title))
    .filter((p) => p.info.width >= 300 && p.info.height >= 200);
  if (!hits.length) return null;
  const pick = hits[0];
  return {
    src: pick.info.thumburl || pick.info.url,
    credit: pick.title.replace(/^File:/, "").replace(/\.(jpe?g|png)$/i, ""),
    sourceUrl: pick.info.descriptionurl || pick.info.url,
  };
}

async function fetchDataUri(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  return "data:" + contentType + ";base64," + buf.toString("base64");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const reportPath = path.join(root, "data/_alt-landmark-report.json");
  const report = fs.existsSync(reportPath)
    ? JSON.parse(fs.readFileSync(reportPath, "utf8"))
    : {};
  for (const [id, names] of Object.entries(CANDIDATES)) {
    report[id] = { tried: [], winner: null };
    for (const name of names) {
      let hit = await wikiExact(name);
      let source = "wikipedia";
      if (!hit) {
        await sleep(200);
        hit = await commonsSearch(name);
        source = "commons";
      }
      if (hit) {
        const dataUri = await fetchDataUri(hit.src);
        if (dataUri) {
          report[id].winner = { name, credit: hit.credit, sourceUrl: hit.sourceUrl, src: dataUri, via: source };
          console.log(id, name, "-> FOUND via", source, "credit:", hit.credit, Math.round(dataUri.length / 1024) + "KB");
          break;
        }
      }
      report[id].tried.push(name);
      console.log(id, name, "-> no image");
      await sleep(300);
    }
    if (!report[id].winner) console.log(id, "-> ALL CANDIDATES FAILED");
    await sleep(300);
  }
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log("done, report written");
}

main();
