// Re-attempts only the landmark names that scripts/fetch-landmark-images.js
// left without an image (likely Wikipedia API rate-limiting after ~90
// rapid-fire requests), merging results into the existing
// data/landmark-images.js instead of starting over. More conservative
// pacing and a retry-with-backoff on failure.
const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const UA = "TravelMapApp/1.0 (personal hobby project; contact: local-user)";

function apiGet(url) {
  return fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
}

async function summaryFor(title) {
  const url =
    "https://ko.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(title);
  const res = await apiGet(url);
  if (!res.ok) return { ok: false, status: res.status };
  const json = await res.json();
  if (json.type === "disambiguation") return { ok: false, status: "disambig" };
  return { ok: true, json };
}

async function searchTitle(query) {
  const url =
    "https://ko.wikipedia.org/w/api.php?action=query&list=search&format=json" +
    "&srlimit=1&srsearch=" +
    encodeURIComponent(query);
  const res = await apiGet(url);
  if (!res.ok) return null;
  const json = await res.json();
  var hit = json.query && json.query.search && json.query.search[0];
  return hit ? hit.title : null;
}

async function fetchImageDataUri(imgUrl) {
  const res = await fetch(imgUrl, { headers: { "User-Agent": UA } });
  if (!res.ok) return null;
  const contentType = res.headers.get("content-type") || "image/jpeg";
  const buf = Buffer.from(await res.arrayBuffer());
  return "data:" + contentType + ";base64," + buf.toString("base64");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A full-text search fallback can match a page that's textually related
// but a completely different subject (a landmark named after a person
// once matched that OTHER person's own biography page - showing a former
// president's portrait for an unrelated county would be a bad mistake).
// Require some real character overlap with the query before trusting it.
function sharesSubstring(a, b, minLen) {
  for (var i = 0; i <= a.length - minLen; i++) {
    if (b.indexOf(a.slice(i, i + minLen)) !== -1) return true;
  }
  return false;
}

async function resolveOnce(name) {
  var summary = await summaryFor(name);
  if (!summary.ok) {
    var altTitle = await searchTitle(name);
    await sleep(300);
    if (altTitle && altTitle !== name && sharesSubstring(name, altTitle, 2)) {
      summary = await summaryFor(altTitle);
    }
  }
  if (!summary.ok || !summary.json.thumbnail) return null;
  var dataUri = await fetchImageDataUri(summary.json.thumbnail.source);
  if (!dataUri) return null;
  return {
    src: dataUri,
    credit: summary.json.title,
    sourceUrl: "https://ko.wikipedia.org/wiki/" + encodeURIComponent(summary.json.title),
  };
}

async function resolveWithRetry(name, attempts) {
  for (var i = 0; i < attempts; i++) {
    try {
      var r = await resolveOnce(name);
      if (r) return r;
    } catch (e) {
      // fall through to retry
    }
    await sleep(800 * (i + 1)); // back off more each attempt
  }
  return null;
}

async function main() {
  var landmarksSrc = fs.readFileSync(path.join(root, "data/landmarks.js"), "utf8");
  var sandbox = { window: {} };
  new Function("window", landmarksSrc)(sandbox.window);
  var LANDMARKS = sandbox.window.LANDMARKS;
  var allNames = [...new Set(Object.values(LANDMARKS).map((v) => v.name))];

  var existingSrc = fs.readFileSync(path.join(root, "data/landmark-images.js"), "utf8");
  var existingSandbox = { window: {} };
  new Function("window", existingSrc)(existingSandbox.window);
  var out = existingSandbox.window.LANDMARK_IMAGES || {};

  var missing = allNames.filter((n) => !out[n]);
  console.log("retrying", missing.length, "missing of", allNames.length);

  var stillFailed = [];
  for (var i = 0; i < missing.length; i++) {
    var name = missing[i];
    var result = await resolveWithRetry(name, 3);
    if (result) {
      out[name] = result;
      console.log(
        "[" + (i + 1) + "/" + missing.length + "]",
        name,
        "->",
        result.credit,
        Math.round(result.src.length / 1024) + "KB"
      );
    } else {
      stillFailed.push(name);
      console.log("[" + (i + 1) + "/" + missing.length + "]", name, "-> still no image");
    }
    await sleep(400);
  }

  fs.writeFileSync(
    path.join(root, "data/landmark-images.js"),
    "window.LANDMARK_IMAGES = " + JSON.stringify(out) + ";"
  );
  console.log("total resolved", Object.keys(out).length, "of", allNames.length);
  if (stillFailed.length) console.log("still failed:", stillFailed.join(", "));
}

main();
